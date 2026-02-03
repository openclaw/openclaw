import type { PayloadHandler } from 'payload'
import { ActivityPubAdapter } from '@/lib/federation/activitypub'
import { createHash } from 'node:crypto'

/**
 * ActivityPub Inbox Endpoint
 * Handles incoming activities from federated instances (Mastodon, Pleroma, etc.)
 *
 * POST /ap/users/:username/inbox
 *
 * This is the main entry point for federation. Remote servers send activities here.
 */
export const handleInboxRequest: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params

    if (!username) {
      return res.status(400).json({
        error: 'Username required'
      })
    }

    // Get HTTP Signature header
    const signature = req.headers['signature'] as string

    if (!signature) {
      return res.status(401).json({
        error: 'HTTP Signature required for ActivityPub federation'
      })
    }

    // Extract request details for signature verification
    const method = req.method
    const path = req.url || req.path
    const host = req.headers['host'] || ''
    const date = req.headers['date'] as string

    // Calculate digest from request body
    const bodyJson = JSON.stringify(req.body)
    const digest = `SHA-256=${createHash('sha256').update(bodyJson).digest('base64')}`

    // Verify digest header matches body
    const receivedDigest = req.headers['digest'] as string
    if (receivedDigest && receivedDigest !== digest) {
      return res.status(400).json({
        error: 'Digest mismatch - request body was tampered with'
      })
    }

    // Get activity from request body
    const activity = req.body

    if (!activity || !activity.type || !activity.actor) {
      return res.status(400).json({
        error: 'Invalid ActivityPub activity'
      })
    }

    // Initialize ActivityPub adapter
    const baseUrl = `${req.protocol}://${host}`
    const activityPub = new ActivityPubAdapter(req.payload, baseUrl)

    // Handle the incoming activity (includes signature verification)
    await activityPub.handleInbox(username, activity, signature, {
      method,
      path,
      host,
      date,
      digest
    })

    // Return 202 Accepted (ActivityPub standard)
    res.status(202).json({
      status: 'accepted'
    })
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub inbox error: ${error}`)

    if (error.message?.includes('signature')) {
      return res.status(401).json({
        error: 'Invalid signature'
      })
    }

    res.status(500).json({
      error: 'Failed to process activity'
    })
  }
}

/**
 * ActivityPub Shared Inbox (for all users)
 * POST /ap/inbox
 *
 * Some servers send to shared inbox instead of individual inboxes
 */
export const handleSharedInboxRequest: PayloadHandler = async (req, res) => {
  try {
    const signature = req.headers['signature'] as string

    if (!signature) {
      return res.status(401).json({
        error: 'HTTP Signature required'
      })
    }

    const activity = req.body

    if (!activity || !activity.type || !activity.actor) {
      return res.status(400).json({
        error: 'Invalid activity'
      })
    }

    // Extract target username from activity.object or activity.to
    let targetUsername: string | undefined

    if (typeof activity.object === 'string') {
      // Extract username from URL like https://example.com/ap/users/alice
      const match = activity.object.match(/\/ap\/users\/([^\/]+)/)
      targetUsername = match?.[1]
    } else if (activity.to && Array.isArray(activity.to)) {
      // Find username from 'to' field
      for (const recipient of activity.to) {
        const match = recipient.match(/\/ap\/users\/([^\/]+)/)
        if (match) {
          targetUsername = match[1]
          break
        }
      }
    }

    if (!targetUsername) {
      return res.status(400).json({
        error: 'Cannot determine target user from activity'
      })
    }

    // Get request details
    const method = req.method
    const path = req.url || req.path
    const host = req.headers['host'] || ''
    const date = req.headers['date'] as string
    const bodyJson = JSON.stringify(req.body)
    const digest = `SHA-256=${createHash('sha256').update(bodyJson).digest('base64')}`

    // Initialize ActivityPub adapter
    const baseUrl = `${req.protocol}://${host}`
    const activityPub = new ActivityPubAdapter(req.payload, baseUrl)

    // Handle the incoming activity
    await activityPub.handleInbox(targetUsername, activity, signature, {
      method,
      path,
      host,
      date,
      digest
    })

    res.status(202).json({
      status: 'accepted'
    })
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub shared inbox error: ${error}`)

    if (error.message?.includes('signature')) {
      return res.status(401).json({
        error: 'Invalid signature'
      })
    }

    res.status(500).json({
      error: 'Failed to process activity'
    })
  }
}

/**
 * ActivityPub Actor/Profile Endpoint
 * GET /ap/users/:username
 *
 * Returns ActivityPub actor representation for federation discovery
 */
export const getActorProfile: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params

    if (!username) {
      return res.status(400).json({
        error: 'Username required'
      })
    }

    // Find profile by username
    const profiles = await req.payload.find({
      collection: 'profiles',
      where: {
        username: { equals: username }
      },
      limit: 1
    })

    const profile = profiles.docs[0]

    if (!profile) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    // Get host from request
    const host = req.headers['host'] || ''
    const baseUrl = `${req.protocol}://${host}`

    // Initialize ActivityPub adapter
    const activityPub = new ActivityPubAdapter(req.payload, baseUrl)

    // Get actor representation
    const actor = await activityPub.getActor(username)

    // Return with ActivityPub content type
    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8')
    res.json(actor)
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub actor error: ${error}`)
    res.status(500).json({
      error: 'Failed to fetch actor profile'
    })
  }
}

/**
 * ActivityPub Outbox Endpoint
 * GET /ap/users/:username/outbox
 *
 * Returns public posts from the user (for federation)
 */
export const getActorOutbox: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params
    const { page } = req.query

    if (!username) {
      return res.status(400).json({
        error: 'Username required'
      })
    }

    // Find profile
    const profiles = await req.payload.find({
      collection: 'profiles',
      where: {
        username: { equals: username }
      },
      limit: 1
    })

    const profile = profiles.docs[0]

    if (!profile) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    const host = req.headers['host'] || ''
    const baseUrl = `${req.protocol}://${host}`
    const userUrl = `${baseUrl}/ap/users/${username}`

    if (!page) {
      // Return outbox collection metadata
      res.setHeader('Content-Type', 'application/activity+json; charset=utf-8')
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${userUrl}/outbox`,
        type: 'OrderedCollection',
        first: `${userUrl}/outbox?page=1`,
        totalItems: profile.postCount || 0
      })
    }

    // Return paginated posts
    const pageNum = parseInt(page as string, 10) || 1
    const limit = 20

    const posts = await req.payload.find({
      collection: 'posts',
      where: {
        author: { equals: profile.id },
        visibility: { equals: 'public' }
      },
      limit,
      page: pageNum,
      sort: '-createdAt'
    })

    const orderedItems = posts.docs.map((post) => ({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${baseUrl}/ap/posts/${post.id}`,
      type: 'Create',
      actor: userUrl,
      published: post.createdAt,
      object: {
        id: `${baseUrl}/ap/posts/${post.id}`,
        type: 'Note',
        attributedTo: userUrl,
        content: post.contentText,
        published: post.createdAt,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${userUrl}/followers`]
      }
    }))

    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8')
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${userUrl}/outbox?page=${pageNum}`,
      type: 'OrderedCollectionPage',
      partOf: `${userUrl}/outbox`,
      orderedItems,
      prev: pageNum > 1 ? `${userUrl}/outbox?page=${pageNum - 1}` : undefined,
      next: posts.hasNextPage ? `${userUrl}/outbox?page=${pageNum + 1}` : undefined
    })
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub outbox error: ${error}`)
    res.status(500).json({
      error: 'Failed to fetch outbox'
    })
  }
}

/**
 * ActivityPub Followers Collection
 * GET /ap/users/:username/followers
 */
export const getActorFollowers: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params

    if (!username) {
      return res.status(400).json({
        error: 'Username required'
      })
    }

    // Find profile
    const profiles = await req.payload.find({
      collection: 'profiles',
      where: {
        username: { equals: username }
      },
      limit: 1
    })

    const profile = profiles.docs[0]

    if (!profile) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    const host = req.headers['host'] || ''
    const baseUrl = `${req.protocol}://${host}`

    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8')
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${baseUrl}/ap/users/${username}/followers`,
      type: 'OrderedCollection',
      totalItems: profile.followerCount || 0
    })
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub followers error: ${error}`)
    res.status(500).json({
      error: 'Failed to fetch followers'
    })
  }
}

/**
 * ActivityPub Following Collection
 * GET /ap/users/:username/following
 */
export const getActorFollowing: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params

    if (!username) {
      return res.status(400).json({
        error: 'Username required'
      })
    }

    // Find profile
    const profiles = await req.payload.find({
      collection: 'profiles',
      where: {
        username: { equals: username }
      },
      limit: 1
    })

    const profile = profiles.docs[0]

    if (!profile) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    const host = req.headers['host'] || ''
    const baseUrl = `${req.protocol}://${host}`

    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8')
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${baseUrl}/ap/users/${username}/following`,
      type: 'OrderedCollection',
      totalItems: profile.followingCount || 0
    })
  } catch (error: any) {
    req.payload.logger.error(`ActivityPub following error: ${error}`)
    res.status(500).json({
      error: 'Failed to fetch following'
    })
  }
}
