import type { PayloadHandler } from 'payload'

/**
 * POST /api/social/profiles/:id/follow
 * Follow a profile
 */
export const followProfile: PayloadHandler = async (req, res) => {
  try {
    const { id } = req.params

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
        error: 'Your profile not found'
      })
    }

    const followerId = userProfile.docs[0].id

    // Cannot follow yourself
    if (followerId === id) {
      return res.status(400).json({
        error: 'Cannot follow yourself'
      })
    }

    // Check if already following
    const existingFollow = await req.payload.find({
      collection: 'follows',
      where: {
        and: [
          {
            follower: {
              equals: followerId
            }
          },
          {
            following: {
              equals: id
            }
          }
        ]
      },
      limit: 1
    })

    if (existingFollow.docs[0]) {
      return res.status(400).json({
        error: 'Already following this profile'
      })
    }

    // Create follow relationship
    await req.payload.create({
      collection: 'follows',
      data: {
        follower: followerId,
        following: id
      }
    })

    return res.status(200).json({
      success: true,
      message: 'Successfully followed profile'
    })
  } catch (error) {
    req.payload.logger.error(`Failed to follow profile: ${error}`)
    return res.status(500).json({
      error: 'Failed to follow profile',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * DELETE /api/social/profiles/:id/follow
 * Unfollow a profile
 */
export const unfollowProfile: PayloadHandler = async (req, res) => {
  try {
    const { id } = req.params

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
        error: 'Your profile not found'
      })
    }

    const followerId = userProfile.docs[0].id

    // Find follow relationship
    const followResult = await req.payload.find({
      collection: 'follows',
      where: {
        and: [
          {
            follower: {
              equals: followerId
            }
          },
          {
            following: {
              equals: id
            }
          }
        ]
      },
      limit: 1
    })

    if (!followResult.docs[0]) {
      return res.status(404).json({
        error: 'Not following this profile'
      })
    }

    // Delete follow relationship
    await req.payload.delete({
      collection: 'follows',
      id: followResult.docs[0].id
    })

    return res.status(200).json({
      success: true,
      message: 'Successfully unfollowed profile'
    })
  } catch (error) {
    req.payload.logger.error(`Failed to unfollow profile: ${error}`)
    return res.status(500).json({
      error: 'Failed to unfollow profile',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
