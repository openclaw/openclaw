import type { CollectionConfig } from 'payload'

export const Follows: CollectionConfig = {
  slug: 'follows',
  admin: {
    useAsTitle: 'id',
    defaultColumns: ['follower', 'following', 'createdAt'],
    group: 'Social'
  },
  access: {
    create: ({ req: { user } }) => !!user,
    read: () => true,
    delete: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      return {
        'follower.user': {
          equals: user?.id
        }
      }
    }
  },
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation === 'create') {
          // Increment follower/following counts
          const followerProfile = await req.payload.findByID({
            collection: 'profiles',
            id: doc.follower
          })

          const followingProfile = await req.payload.findByID({
            collection: 'profiles',
            id: doc.following
          })

          if (followerProfile) {
            await req.payload.update({
              collection: 'profiles',
              id: doc.follower,
              data: {
                followingCount: (followerProfile.followingCount || 0) + 1
              }
            })
          }

          if (followingProfile) {
            await req.payload.update({
              collection: 'profiles',
              id: doc.following,
              data: {
                followerCount: (followingProfile.followerCount || 0) + 1
              }
            })
          }

          // Create notification
          await req.payload.create({
            collection: 'notifications',
            data: {
              recipient: doc.following,
              type: 'new_follower',
              actor: doc.follower,
              targetType: 'profile',
              targetProfile: doc.follower,
              content: 'started following you',
              read: false
            }
          })
        }
      }
    ],
    afterDelete: [
      async ({ doc, req }) => {
        // Decrement follower/following counts
        const followerProfile = await req.payload.findByID({
          collection: 'profiles',
          id: doc.follower
        })

        const followingProfile = await req.payload.findByID({
          collection: 'profiles',
          id: doc.following
        })

        if (followerProfile && followerProfile.followingCount > 0) {
          await req.payload.update({
            collection: 'profiles',
            id: doc.follower,
            data: {
              followingCount: followerProfile.followingCount - 1
            }
          })
        }

        if (followingProfile && followingProfile.followerCount > 0) {
          await req.payload.update({
            collection: 'profiles',
            id: doc.following,
            data: {
              followerCount: followingProfile.followerCount - 1
            }
          })
        }
      }
    ]
  },
  fields: [
    {
      name: 'follower',
      type: 'relationship',
      relationTo: 'profiles',
      required: true,
      admin: {
        description: 'Profile that is following'
      }
    },
    {
      name: 'following',
      type: 'relationship',
      relationTo: 'profiles',
      required: true,
      admin: {
        description: 'Profile being followed'
      }
    },
    {
      name: 'isMuted',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Mute posts from this profile'
      }
    },
    {
      name: 'notificationsEnabled',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description: 'Get notifications for new posts'
      }
    }
  ],
  indexes: [
    {
      fields: {
        follower: 1,
        following: 1
      },
      unique: true,
      options: {
        name: 'follows_unique_idx'
      }
    },
    {
      fields: {
        follower: 1
      },
      options: {
        name: 'follows_follower_idx'
      }
    },
    {
      fields: {
        following: 1
      },
      options: {
        name: 'follows_following_idx'
      }
    },
    {
      fields: {
        following: 1,
        createdAt: -1
      },
      options: {
        name: 'follows_following_created_at_idx'
      }
    }
  ]
}
