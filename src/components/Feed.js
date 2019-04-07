import React from 'react'
import {
  View,
  Alert,
  Image,
  Keyboard,
  StyleSheet,
  Dimensions,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native'

import { Ionicons } from '@expo/vector-icons'
import { Card, Text } from 'native-base'

// Amplify
import API, { graphqlOperation } from '@aws-amplify/api'
import Auth from '@aws-amplify/auth'
import Amplify from '@aws-amplify/core'
import Storage from '@aws-amplify/storage'

// Third party libs
import { RNS3 } from 'react-native-aws3' // for sending pics to S3 instead of Storage.put()
import { ImagePicker, Permissions } from 'expo'
import { v4 as uuid } from 'uuid'

// Local components
import Header from './Header';
import PostCard from './PostCard'
// import PictureCard from './PictureCard'
import ModalPosts from './ModalPosts'
import config from '../aws-exports'
import keys from '../keys'

// GraphQL components
import CreatePost from '../graphQL/CreatePost'
import CreatePicture from '../graphQL/CreatePicture'
import DeletePicture from '../graphQL/DeletePicture'
import CreateLikePost from '../graphQL/CreateLikePost'
import CreateLikePicture from '../graphQL/CreateLikePicture'
import DeleteLikePost from '../graphQL/DeleteLikePost'
import DeletePost from '../graphQL/DeletePost'
import listPosts from '../graphQL/listPosts'
import listPictures from '../graphQL/listPictures'

// Apollo components
import { graphql, compose } from 'react-apollo'

Amplify.configure(config)

class Feed extends React.Component {
  state = {
    modalVisible: false,
    posts: [],
    pictures: [],
    allPicsURIs: [],
    postOwnerId: '',
    likeOwnerId: '',
    postContent: '',
    postOwnerUsername: '',
    likeOwnerUsername: '',
  }


  componentDidMount = async () => {
    await Auth.currentAuthenticatedUser()
      .then(user => {
        this.setState(
          {
            postOwnerUsername: user.username,
            likeOwnerUsername: user.username,
            postOwnerId: user.attributes.sub,
            likeOwnerId: user.attributes.sub,
          }
        )
      })
      .catch(err => console.log(err))
    await this.listPosts()
    await this.allPicsURIs()
    // console.log('List of posts: ', this.state.posts)
    // console.log('List of pictures: ', this.state.pictures)
  }

  // Modal posts methods
  showModal = () => {
    this.setState({ modalVisible: true })
  }

  hideModal = () => {
    this.setState({ modalVisible: false, postContent: '' })
  }

  onChangeText = (key, val) => {
    this.setState({ [key]: val })
  }

  _onRefresh = () => {
    this.setState({ refreshing: true })
    this.componentDidMount()
      .then(() => {
        this.setState({ refreshing: false })
      })
  }

  // Query both posts and pictutres 
  listPosts = async () => {
    try {
      const postsData = await API.graphql(graphqlOperation(listPosts))
      const picturesData = await API.graphql(graphqlOperation(listPictures))
      const listOfAllposts = await postsData.data.listPosts.items
      const listOfAllpictures = await picturesData.data.listPictures.items
      this.setState({ posts: listOfAllposts, pictures: listOfAllpictures })
    }
    catch (err) {
      console.log('error: ', err)
    }
  }

  createPost = async () => {
    const post = this.state
    if (post.postContent === '') {
      Alert.alert('Write something!')
      return
    }
    try {
      await API.graphql(graphqlOperation(CreatePost, post))
      await this.componentDidMount()
      Keyboard.dismiss()
      this.hideModal()
    } catch (err) {
      console.log('Error creating post.', err)
    }
  }

  deletePostAlert = async (post) => {
    await Alert.alert(
      'Delete Post',
      'Are you sure you wanna delete this post?',
      [
        { text: 'Cancel', onPress: () => { return }, style: 'cancel' },
        { text: 'OK', onPress: () => this.deletePost(post) },
      ],
      { cancelable: false }
    )
  }

  deletePost = async (post) => {
    const postId = await post['id']
    try {
      await API.graphql(graphqlOperation(DeletePost, { id: postId }))
      await this.componentDidMount()
    } catch (err) {
      console.log('Error deleting post.', err)
    }
  }

  // Get pictures from device then upload them to AWS S3 and store their records in DynamobDB
  createPicture = async () => {
    await this.askPermissionsAsync()
    const result = await ImagePicker.launchImageLibraryAsync(
      {
        allowsEditing: false,
      }
    )
    if (!result.cancelled) {
      this.uploadToS3AndRecordInDynamodb(result.uri)
    }
  }

  uploadToS3AndRecordInDynamodb = async (uri) => {
    const { bucket, region } = this.props.options
    let picture = {
      uri: uri,
      name: uuid() + '.jpeg',
      type: "image/jpeg",
      bucket,
      region,
    }
    const config = {
      keyPrefix: "public/",
      bucket,
      region,
      accessKey: keys.accessKey,
      secretKey: keys.secretKey,
      successActionStatus: 201
    }
    const visibility = 'public'
    RNS3.put(picture, config)
      .then(response => {
        if (response.status !== 201) {
          throw new Error("Failed to upload image to S3")
        } else {
          console.log('Upload successful.')
          const { type: mimeType } = response;
          const key = `${picture.name}`
          const file = {
            bucket,
            region,
            key,
            mimeType
          }
          // Apollo mutation to create a picture
          this.props.onAddPicture(
            {
              id: uuid(),
              pictureOwnerId: this.state.postOwnerId,
              pictureOwnerUsername: this.state.postOwnerUsername,
              visibility: visibility,
              file: file
            }
          )
        }
      })
  }

  allPicsURIs = () => {
		/* 
		Perform a get call with Storage API to retrieve the URI of each picture.
		We then store all URIs in the state to be called in the render method.
		*/
    let access = { level: 'public' }
    let key
    this.state.pictures.map((picture, index) => {
      key = picture.file.key
      Storage.get(key, access)
        .then((response) => {
          // Extract uri from response
          let uri = response.substring(0, response.indexOf('?'))
          if (this.state.allPicsURIs.includes(uri)) {
            return
          } else {
            this.setState(prevState => ({
              allPicsURIs: [...prevState.allPicsURIs, uri]
            }))
          }
        })
        .catch(err => console.log(err))
    })
  }

  deletePicture = async (uri) => {
    const { allPicsURIs } = this.state
    const key = await uri.substring(uri.indexOf('public/') + 7)
    const pictureObject = await this.state.pictures.filter(photo => photo.file.key === key)
    const pictureId = await pictureObject[0].id
    try {
      await this.props.onRemovePicture({ id: pictureId })
      await this.removeImageFromS3(key)
      const index = await allPicsURIs.indexOf(uri)
      if (index > -1) {
        allPicsURIs.splice(index, 1)
      }
      this.setState({ allPicsURIs: allPicsURIs })
    } catch (err) {
      console.log('Error deleting post.', err)
    }
  }

  removeImageFromS3 = async (key) => {
    await Storage.remove(key)
      .then(result => console.log('Picture deleted', result))
      .catch(err => console.log(err))
  }

  // Give Expo access to device library
  askPermissionsAsync = async () => {
    await Permissions.askAsync(Permissions.CAMERA_ROLL)
  }

  toggleLikePost = async (post) => {
    const loggedInUser = await this.state.postOwnerId
    const likeUserObject = await post.likes.items.filter(
      obj => obj.likeOwnerId === loggedInUser
    )
    if (likeUserObject.length !== 0) {
      await this.deleteLikePost(likeUserObject)
      return
    }
    await this.createLikePost(post)
  }

  createLikePost = async (post) => {
    const postId = await post['id']
    const like = {
      id: postId,
      likeOwnerId: this.state.likeOwnerId,
      likeOwnerUsername: this.state.likeOwnerUsername,
    }
    try {
      await API.graphql(graphqlOperation(CreateLikePost, like))
      await this.componentDidMount()
    } catch (err) {
      console.log('Error creating like.', err)
    }
  }

  toggleLikePictures = async (uri) => {
    const key = await uri.substring(uri.indexOf('public/') + 7)
    const pictureObject = await this.state.pictures.filter(photo => photo.file.key === key)
    const loggedInUser = await this.state.postOwnerId
    const likeUserObject = await pictureObject[0].likes.items.filter(
      obj => obj.likeOwnerId === loggedInUser
    )
    if (likeUserObject.length !== 0) {
      await this.deleteLikePost(likeUserObject)
      return
    }
    await this.createLikePicture(uri)
  }

  // Create like method for pictures
  createLikePicture = async (uri) => {
    const key = await uri.substring(uri.indexOf('public/') + 7)
    const pictureObject = await this.state.pictures.filter(photo => photo.file.key === key)
    const pictureId = await pictureObject[0].id
    const like = {
      id: pictureId,
      likeOwnerId: this.state.likeOwnerId,
      likeOwnerUsername: this.state.likeOwnerUsername,
    }
    try {
      await API.graphql(graphqlOperation(CreateLikePicture, like))
      await this.componentDidMount()
    } catch (err) {
      console.log('Error creating like.', err)
    }
  }

  // Works for both posts and pictures
  deleteLikePost = async (likeUserObject) => {
    const likeId = await likeUserObject[0]['id']
    try {
      await API.graphql(graphqlOperation(DeleteLikePost, { id: likeId }))
      await this.componentDidMount()
    } catch (err) {
      console.log('Error deleting like.', err)
    }
  }

  render() {
    let loggedInUser = this.state.postOwnerId
    let { pictures, allPicsURIs } = this.state
    return (
      <View style={{ flex: 1 }}>
        <View style={styles.headerStyle}>
          {/* Header */}
          <Header
            showModal={this.showModal}
            accessDevice={this.createPicture}
            refresh={this.componentDidMount}
          />
          {/* Open Modal component to write a post */}
          <ModalPosts
            modalVisible={this.state.modalVisible}
            postContent={this.state.postContent}
            hideModal={this.hideModal}
            createPost={this.createPost}
            onChangeText={val => this.onChangeText('postContent', val)}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.container}
          refreshControl={
            <RefreshControl
              refreshing={this.state.refreshing}
              onRefresh={this._onRefresh}
            />
          }
        >
          <View style={{ flex: 1, alignItems: 'center' }}>
            {/* Posts component */}
            {/* {
              this.state.posts.map((post, index) => (
                <PostCard
                  key={index}
                  post={post}
                  user={loggedInUser}
                  deletePostAlert={() => this.deletePostAlert(post)}
                  toggleLikePost={() => this.toggleLikePost(post)}
                />
              ))
            } */}
            {/* Pictures component */}
            {
              allPicsURIs.map((uri, index) => (
                <Card key={index} style={styles.cardStyle}>
                  <View style={styles.cardHeaderStyle}>
                    {/* Not a working code. Here to add delete image alert. */}
                    {/* {
                      post.postOwnerId === user &&
                      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-start' }}>
                        <TouchableOpacity onPress={deletePostAlert}>
                          <Ionicons
                            style={{ color: '#1f267e', padding: 5, fontSize: 30 }}
                            name="md-more"
                          />
                        </TouchableOpacity>
                      </View>
                    } */}
                    <Image style={styles.image} source={{ uri: uri }} />
                    <View style={styles.cardFooterStyle}>
                      <View style={{ flex: 1, justifyContent: 'flex-start', alignItems: 'flex-start' }}>
                        <Text style={styles.postUsername}>
                          {
                            pictures.filter(
                              pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                            )[0].pictureOwnerUsername
                          }
                        </Text>
                      </View>
                      {
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].pictureOwnerId === loggedInUser &&
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-start' }}>
                          <TouchableOpacity onPress={() => this.deletePicture(uri)}>
                            <Ionicons
                              style={{ color: '#1f267e', fontSize: 30 }}
                              name="md-more"
                            />
                          </TouchableOpacity>
                        </View>
                      }
                      {/* Logged in user liked this picture */}
                      {
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].likes.items.length !== 0 &&
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].likes.items.filter(obj => obj.likeOwnerId === loggedInUser).length === 1 &&
                        <TouchableOpacity onPress={() => this.toggleLikePictures(uri)}>
                          <Ionicons
                            name='md-heart'
                            style={{ fontSize: 45, color: '#FB7777' }}
                          />
                        </TouchableOpacity>
                      }
                      {/* Logged in user did not like this picture */}
                      {
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].likes.items.length !== 0 &&
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].likes.items.filter(obj => obj.likeOwnerId === loggedInUser).length === 0 &&
                        <TouchableOpacity onPress={() => this.toggleLikePictures(uri)}>
                          <Ionicons
                            name='md-heart'
                            style={{ fontSize: 45, color: '#69FF' }}
                          />
                        </TouchableOpacity>
                      }
                      {/* Picture has no likes */}
                      {
                        pictures.filter(
                          pic => pic.file.key === uri.substring(uri.indexOf('public/') + 7)
                        )[0].likes.items.length === 0 &&
                        <TouchableOpacity onPress={() => this.toggleLikePictures(uri)}>
                          <Ionicons
                            name='md-heart'
                            style={{ fontSize: 45, color: '#69FF' }}
                          />
                        </TouchableOpacity>
                      }
                    </View>
                  </View>
                </Card>
              ))
            }
          </View>
        </ScrollView>
      </View>
    )
  }
}

const ApolloWrapper = compose(
  graphql(CreatePicture, {
    props: (props) => ({
      onAddPicture: (picture) => {
        props.mutate({
          variables: { input: picture },
          optimisticResponse: () => ({
            createPicture: {
              ...picture,
              __typename: 'Picture',
              file: { ...picture.file, __typename: 'S3Object' }
            }
          }),
        })
      }
    }),
  }),
  graphql(DeletePicture, {
    props: (props) => ({
      onRemovePicture: (picture) => {
        props.mutate({
          variables: { input: picture },
          optimisticResponse: () => ({
            deletePicture: { ...picture, __typename: 'Picture' }
          }),
        })
      }
    }),
  }),
)(Feed)

export default ApolloWrapper

let width = Dimensions.get('window').width

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerStyle: {
    padding: 8,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardStyle: {
    flex: 1,
    backgroundColor: '#d0d9ed',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20
  },
  image: {
    width: width,
    height: width,
    marginBottom: 24
  },
  cardFooterStyle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: 10,
    paddingRight: 10,
  },
  postUsername: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1f267e'
  },
})
