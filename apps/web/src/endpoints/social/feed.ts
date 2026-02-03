import type { PayloadHandler } from 'payload'
import { getFeedService } from '../../lib/social/feed-service'

/**
 * GET /api/social/feed
 * Get personalized feed for authenticated user
 */
export const getFeed: PayloadHandler = async (req, res) => {
  try {
    // Get user's profile
    const userProfile = await req.payload.find({
      collection: 'profiles',
      where: {
        user: {
          equals: req.user?.id
        }
      },
      limit: 1
    })

    if (!userProfile.docs[0]) {
      return res.status(404).json({
        error: 'Profile not found'
      })
    }

    const profileId = userProfile.docs[0].id

    // Get feed options from query
    const { limit, offset, type } = req.query

    const feedService = getFeedService(req.payload)
    const posts = await feedService.getHomeFeed(profileId, {
      limit: limit ? Number.parseInt(limit as string, 10) : 20,
      offset: offset ? Number.parseInt(offset as string, 10) : 0,
      type: (type as 'following' | 'discovery' | 'agent') || 'following'
    })

    return res.status(200).json({
      posts,
      hasMore: posts.length === (limit ? Number.parseInt(limit as string, 10) : 20)
    })
  } catch (error) {
    req.payload.logger.error(`Failed to get feed: ${error}`)
    return res.status(500).json({
      error: 'Failed to load feed',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * GET /api/social/profiles/:username/timeline
 * Get public timeline for a profile
 */
export const getProfileTimeline: PayloadHandler = async (req, res) => {
  try {
    const { username } = req.params
    const { limit, offset } = req.query

    // Find profile by username
    const profileResult = await req.payload.find({
      collection: 'profiles',
      where: {
        username: {
          equals: username
        }
      },
      limit: 1
    })

    if (!profileResult.docs[0]) {
      return res.status(404).json({
        error: 'Profile not found'
      })
    }

    const profile = profileResult.docs[0]

    // Check visibility
    if (profile.settings?.profileVisibility === 'private') {
      // Check if requester is authorized
      const userProfile = await req.payload.find({
        collection: 'profiles',
        where: {
          user: {
            equals: req.user?.id
          }
        },
        limit: 1
      })

      if (!userProfile.docs[0] || userProfile.docs[0].id !== profile.id) {
        return res.status(403).json({
          error: 'This profile is private'
        })
      }
    }

    const feedService = getFeedService(req.payload)
    const posts = await feedService.getProfileTimeline(profile.id, {
      limit: limit ? Number.parseInt(limit as string, 10) : 20,
      offset: offset ? Number.parseInt(offset as string, 10) : 0
    })

    return res.status(200).json({
      profile: {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        avatar: profile.avatar,
        verified: profile.verified,
        type: profile.type,
        followerCount: profile.followerCount,
        followingCount: profile.followingCount,
        postCount: profile.postCount
      },
      posts,
      hasMore: posts.length === (limit ? Number.parseInt(limit as string, 10) : 20)
    })
  } catch (error) {
    req.payload.logger.error(`Failed to get profile timeline: ${error}`)
    return res.status(500).json({
      error: 'Failed to load timeline',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
