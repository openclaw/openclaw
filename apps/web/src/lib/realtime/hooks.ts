import type { CollectionAfterChangeHook, CollectionAfterDeleteHook } from 'payload'
import type { ClawNetWebSocketServer } from './websocket-server'
import { RealtimeEvents, RealtimeRooms } from './websocket-server'

/**
 * Payload CMS Hooks for Real-Time Updates
 *
 * These hooks automatically broadcast WebSocket events when data changes
 * Attach to collections in payload.config.ts
 */

/**
 * Get WebSocket server instance
 * Store in global singleton
 */
let wsServerInstance: ClawNetWebSocketServer | null = null

export function setWebSocketServer(server: ClawNetWebSocketServer): void {
  wsServerInstance = server
}

export function getWebSocketServer(): ClawNetWebSocketServer | null {
  return wsServerInstance
}

/**
 * Post Created Hook
 */
export const broadcastPostCreated: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== 'create') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  // Broadcast to global feed
  ws.broadcastToRoom(RealtimeRooms.GLOBAL_FEED, {
    type: 'post',
    event: RealtimeEvents.POST_CREATED,
    data: {
      id: doc.id,
      author: doc.author,
      authorType: doc.authorType,
      contentText: doc.contentText,
      createdAt: doc.createdAt,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0
    },
    timestamp: Date.now()
  })

  // Broadcast to author's followers
  const authorId =
    typeof doc.author === 'string' ? doc.author : doc.author?.id

  if (authorId) {
    const followers = await req.payload.find({
      collection: 'follows',
      where: {
        following: { equals: authorId }
      },
      limit: 1000
    })

    for (const follow of followers.docs) {
      const followerId =
        typeof follow.follower === 'string'
          ? follow.follower
          : follow.follower?.id

      if (followerId) {
        ws.broadcastToUser(followerId, {
          type: 'post',
          event: RealtimeEvents.POST_CREATED,
          data: {
            id: doc.id,
            author: doc.author,
            authorType: doc.authorType,
            contentText: doc.contentText,
            createdAt: doc.createdAt
          },
          timestamp: Date.now()
        })
      }
    }
  }

  req.payload.logger.info(`Broadcasted post created: ${doc.id}`)
}

/**
 * Post Updated Hook
 */
export const broadcastPostUpdated: CollectionAfterChangeHook = async ({
  doc,
  operation
}) => {
  if (operation !== 'update') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  ws.broadcastToRoom(RealtimeRooms.GLOBAL_FEED, {
    type: 'post',
    event: RealtimeEvents.POST_UPDATED,
    data: {
      id: doc.id,
      contentText: doc.contentText,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      shareCount: doc.shareCount,
      updatedAt: doc.updatedAt
    },
    timestamp: Date.now()
  })
}

/**
 * Post Deleted Hook
 */
export const broadcastPostDeleted: CollectionAfterDeleteHook = async ({ id }) => {
  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  ws.broadcastToRoom(RealtimeRooms.GLOBAL_FEED, {
    type: 'post',
    event: RealtimeEvents.POST_DELETED,
    data: {
      id
    },
    timestamp: Date.now()
  })
}

/**
 * Comment Created Hook
 */
export const broadcastCommentCreated: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== 'create') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  // Broadcast to post's comment room
  const postId = typeof doc.post === 'string' ? doc.post : doc.post?.id

  if (postId) {
    ws.broadcastToRoom(RealtimeRooms.postComments(postId), {
      type: 'comment',
      event: RealtimeEvents.COMMENT_CREATED,
      data: {
        id: doc.id,
        post: postId,
        author: doc.author,
        content: doc.content,
        createdAt: doc.createdAt
      },
      timestamp: Date.now()
    })

    // Update post comment count
    await req.payload.update({
      collection: 'posts',
      id: postId,
      data: {
        commentCount: (doc.post?.commentCount || 0) + 1
      }
    })

    // Notify post author
    const post = await req.payload.findByID({
      collection: 'posts',
      id: postId
    })

    if (post) {
      const postAuthorId =
        typeof post.author === 'string' ? post.author : post.author?.id

      if (postAuthorId) {
        await req.payload.create({
          collection: 'notifications',
          data: {
            recipient: postAuthorId,
            type: 'comment',
            actor: doc.author,
            targetType: 'post',
            targetPost: postId,
            read: false
          }
        })
      }
    }
  }
}

/**
 * Like Created Hook
 */
export const broadcastLikeCreated: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== 'create') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  if (doc.targetType === 'post' && doc.targetPost) {
    const postId =
      typeof doc.targetPost === 'string' ? doc.targetPost : doc.targetPost?.id

    if (postId) {
      // Broadcast post liked event
      ws.broadcastToRoom(RealtimeRooms.GLOBAL_FEED, {
        type: 'post',
        event: RealtimeEvents.POST_LIKED,
        data: {
          postId,
          likerId: doc.profile,
          likeId: doc.id
        },
        timestamp: Date.now()
      })

      // Update post like count
      const post = await req.payload.findByID({
        collection: 'posts',
        id: postId
      })

      if (post) {
        await req.payload.update({
          collection: 'posts',
          id: postId,
          data: {
            likeCount: (post.likeCount || 0) + 1
          }
        })

        // Notify post author
        const postAuthorId =
          typeof post.author === 'string' ? post.author : post.author?.id

        if (postAuthorId && postAuthorId !== doc.profile) {
          await req.payload.create({
            collection: 'notifications',
            data: {
              recipient: postAuthorId,
              type: 'like',
              actor: doc.profile,
              targetType: 'post',
              targetPost: postId,
              read: false
            }
          })
        }
      }
    }
  }
}

/**
 * Like Deleted Hook
 */
export const broadcastLikeDeleted: CollectionAfterDeleteHook = async ({
  doc,
  req
}) => {
  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  if (doc.targetType === 'post' && doc.targetPost) {
    const postId =
      typeof doc.targetPost === 'string' ? doc.targetPost : doc.targetPost?.id

    if (postId) {
      ws.broadcastToRoom(RealtimeRooms.GLOBAL_FEED, {
        type: 'post',
        event: RealtimeEvents.POST_UNLIKED,
        data: {
          postId,
          unlikerId: doc.profile
        },
        timestamp: Date.now()
      })

      // Update post like count
      const post = await req.payload.findByID({
        collection: 'posts',
        id: postId
      })

      if (post && post.likeCount > 0) {
        await req.payload.update({
          collection: 'posts',
          id: postId,
          data: {
            likeCount: post.likeCount - 1
          }
        })
      }
    }
  }
}

/**
 * Follow Created Hook
 */
export const broadcastFollowCreated: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== 'create') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  const followerId =
    typeof doc.follower === 'string' ? doc.follower : doc.follower?.id
  const followingId =
    typeof doc.following === 'string' ? doc.following : doc.following?.id

  if (followingId) {
    // Notify the followed user
    ws.broadcastToUser(followingId, {
      type: 'follow',
      event: RealtimeEvents.USER_FOLLOWED,
      data: {
        followerId,
        followingId,
        followId: doc.id
      },
      timestamp: Date.now()
    })

    // Create notification
    await req.payload.create({
      collection: 'notifications',
      data: {
        recipient: followingId,
        type: 'follow',
        actor: followerId,
        read: false
      }
    })
  }
}

/**
 * Bot Status Change Hook
 */
export const broadcastBotStatusChange: CollectionAfterChangeHook = async ({
  doc,
  operation
}) => {
  if (operation !== 'update') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  ws.broadcastToRoom(RealtimeRooms.botStatus(doc.id), {
    type: 'bot',
    event: doc.status === 'running' ? RealtimeEvents.BOT_STARTED : RealtimeEvents.BOT_STOPPED,
    data: {
      botId: doc.id,
      status: doc.status,
      name: doc.name,
      agentId: doc.agentId
    },
    timestamp: Date.now()
  })

  // Notify bot owner
  const userId = typeof doc.user === 'string' ? doc.user : doc.user?.id

  if (userId) {
    ws.broadcastToUser(userId, {
      type: 'bot',
      event: doc.status === 'running' ? RealtimeEvents.BOT_STARTED : RealtimeEvents.BOT_STOPPED,
      data: {
        botId: doc.id,
        status: doc.status,
        name: doc.name
      },
      timestamp: Date.now()
    })
  }
}

/**
 * Bot Listed for Sale Hook
 */
export const broadcastBotListed: CollectionAfterChangeHook = async ({
  doc,
  operation
}) => {
  if (operation !== 'update') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  // @ts-ignore
  if (doc.nftListedForSale && doc.nftSalePrice) {
    ws.broadcastToRoom(RealtimeRooms.GLOBAL_MARKETPLACE, {
      type: 'marketplace',
      event: RealtimeEvents.BOT_LISTED,
      data: {
        botId: doc.id,
        name: doc.name,
        // @ts-ignore
        tokenId: doc.nftTokenId,
        // @ts-ignore
        price: doc.nftSalePrice,
        // @ts-ignore
        owner: doc.nftOwner,
        listingType: 'sale'
      },
      timestamp: Date.now()
    })
  }

  // @ts-ignore
  if (doc.nftListedForRent && doc.nftRentalPrice) {
    ws.broadcastToRoom(RealtimeRooms.GLOBAL_MARKETPLACE, {
      type: 'marketplace',
      event: RealtimeEvents.BOT_LISTED,
      data: {
        botId: doc.id,
        name: doc.name,
        // @ts-ignore
        tokenId: doc.nftTokenId,
        // @ts-ignore
        pricePerDay: doc.nftRentalPrice,
        // @ts-ignore
        maxDays: doc.nftRentalMaxDays,
        // @ts-ignore
        owner: doc.nftOwner,
        listingType: 'rent'
      },
      timestamp: Date.now()
    })
  }
}

/**
 * Notification Created Hook
 */
export const broadcastNotificationCreated: CollectionAfterChangeHook = async ({
  doc,
  operation
}) => {
  if (operation !== 'create') {
    return
  }

  const ws = getWebSocketServer()
  if (!ws) {
    return
  }

  const recipientId =
    typeof doc.recipient === 'string' ? doc.recipient : doc.recipient?.id

  if (recipientId) {
    ws.broadcastToUser(recipientId, {
      type: 'notification',
      event: RealtimeEvents.NOTIFICATION_CREATED,
      data: {
        id: doc.id,
        type: doc.type,
        actor: doc.actor,
        targetType: doc.targetType,
        targetPost: doc.targetPost,
        targetComment: doc.targetComment,
        message: doc.message,
        read: doc.read,
        createdAt: doc.createdAt
      },
      timestamp: Date.now()
    })
  }
}

/**
 * Export all hooks for easy import in collections
 */
export const RealtimeHooks = {
  // Posts
  afterChange: [broadcastPostCreated, broadcastPostUpdated],
  afterDelete: [broadcastPostDeleted],

  // Comments
  afterCommentChange: [broadcastCommentCreated],

  // Likes
  afterLikeChange: [broadcastLikeCreated],
  afterLikeDelete: [broadcastLikeDeleted],

  // Follows
  afterFollowChange: [broadcastFollowCreated],

  // Bots
  afterBotChange: [broadcastBotStatusChange, broadcastBotListed],

  // Notifications
  afterNotificationChange: [broadcastNotificationCreated]
}
