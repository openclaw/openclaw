import type { CollectionConfig } from 'payload'

export const Profiles: CollectionConfig = {
  slug: 'profiles',
  admin: {
    useAsTitle: 'username',
    defaultColumns: ['username', 'displayName', 'type', 'followerCount', 'verified'],
    group: 'Social'
  },
  indexes: [
    {
      fields: {
        username: 1
      },
      unique: true,
      options: {
        name: 'profiles_username_idx'
      }
    },
    {
      fields: {
        user: 1
      },
      options: {
        name: 'profiles_user_idx'
      }
    },
    {
      fields: {
        type: 1
      },
      options: {
        name: 'profiles_type_idx'
      }
    },
    {
      fields: {
        verified: 1,
        followerCount: -1
      },
      options: {
        name: 'profiles_verified_followers_idx'
      }
    },
    {
      fields: {
        createdAt: -1
      },
      options: {
        name: 'profiles_created_at_idx'
      }
    }
  ],
  access: {
    create: ({ req: { user } }) => !!user,
    read: () => true, // Public profiles
    update: ({ req: { user }, id }) => {
      if (user?.role === 'admin') return true
      // Users can only update their own profile
      return {
        user: {
          equals: user?.id
        }
      }
    },
    delete: ({ req: { user } }) => user?.role === 'admin'
  },
  hooks: {
    beforeChange: [
      ({ data, operation }) => {
        // Auto-generate username from displayName if not provided
        if (operation === 'create' && !data.username && data.displayName) {
          data.username = data.displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        }
        return data
      }
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        // Create agent profile when bot is created
        if (operation === 'create' && doc.type === 'agent' && doc.agentRef) {
          req.payload.logger.info(`Agent profile created: ${doc.username}`)
        }
      }
    ]
  },
  fields: [
    {
      name: 'type',
      type: 'select',
      required: true,
      options: [
        { label: 'Human', value: 'human' },
        { label: 'Agent', value: 'agent' }
      ],
      admin: {
        description: 'Profile type: human user or AI agent'
      }
    },
    {
      name: 'username',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Unique handle (e.g., @username)'
      },
      validate: (val) => {
        if (!/^[a-z0-9_-]+$/.test(val)) {
          return 'Username must contain only lowercase letters, numbers, underscores, and hyphens'
        }
        if (val.length < 3 || val.length > 30) {
          return 'Username must be between 3 and 30 characters'
        }
        return true
      }
    },
    {
      name: 'displayName',
      type: 'text',
      required: true,
      admin: {
        description: 'Display name shown on profile'
      }
    },
    {
      name: 'bio',
      type: 'textarea',
      maxLength: 500,
      admin: {
        description: 'Profile bio (max 500 characters)'
      }
    },
    {
      name: 'avatar',
      type: 'upload',
      relationTo: 'media',
      admin: {
        description: 'Profile avatar image'
      }
    },
    {
      name: 'coverPhoto',
      type: 'upload',
      relationTo: 'media',
      admin: {
        description: 'Profile cover photo'
      }
    },
    {
      name: 'location',
      type: 'text',
      admin: {
        description: 'Location (optional)'
      }
    },
    {
      name: 'website',
      type: 'text',
      admin: {
        description: 'Website URL (optional)'
      }
    },
    {
      name: 'verified',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Verified badge (admin-only)',
        condition: (data, siblingData, { user }) => user?.role === 'admin'
      }
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Agent Info',
          description: 'Agent-specific information',
          fields: [
            {
              name: 'agentRef',
              type: 'relationship',
              relationTo: 'bots',
              admin: {
                description: 'Linked bot (if agent profile)',
                condition: (data) => data?.type === 'agent'
              }
            },
            {
              name: 'agentType',
              type: 'select',
              options: [
                { label: 'Assistant', value: 'assistant' },
                { label: 'Creative', value: 'creative' },
                { label: 'Technical', value: 'technical' },
                { label: 'Entertainment', value: 'entertainment' },
                { label: 'Educational', value: 'educational' }
              ],
              admin: {
                condition: (data) => data?.type === 'agent'
              }
            },
            {
              name: 'capabilities',
              type: 'array',
              fields: [
                {
                  name: 'tag',
                  type: 'text',
                  required: true
                }
              ],
              admin: {
                description: 'Agent capabilities (e.g., code, art, music)',
                condition: (data) => data?.type === 'agent'
              }
            },
            {
              name: 'modelInfo',
              type: 'text',
              admin: {
                description: 'Model information (e.g., Claude Opus 4.5)',
                condition: (data) => data?.type === 'agent'
              }
            },
            {
              name: 'isPublic',
              type: 'checkbox',
              defaultValue: true,
              admin: {
                description: 'Show in agent gallery',
                condition: (data) => data?.type === 'agent'
              }
            },
            {
              name: 'creator',
              type: 'relationship',
              relationTo: 'users',
              admin: {
                description: 'Agent creator',
                condition: (data) => data?.type === 'agent'
              }
            }
          ]
        },
        {
          label: 'Stats',
          fields: [
            {
              name: 'followerCount',
              type: 'number',
              defaultValue: 0,
              admin: {
                readOnly: true,
                description: 'Number of followers (cached)'
              }
            },
            {
              name: 'followingCount',
              type: 'number',
              defaultValue: 0,
              admin: {
                readOnly: true,
                description: 'Number of following (cached)'
              }
            },
            {
              name: 'postCount',
              type: 'number',
              defaultValue: 0,
              admin: {
                readOnly: true,
                description: 'Number of posts (cached)'
              }
            }
          ]
        },
        {
          label: 'Settings',
          fields: [
            {
              name: 'settings',
              type: 'group',
              fields: [
                {
                  name: 'profileVisibility',
                  type: 'select',
                  defaultValue: 'public',
                  options: [
                    { label: 'Public', value: 'public' },
                    { label: 'Followers Only', value: 'followers' },
                    { label: 'Private', value: 'private' }
                  ]
                },
                {
                  name: 'allowAgentInteractions',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Allow agents to interact with posts'
                  }
                },
                {
                  name: 'allowDMs',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Allow direct messages'
                  }
                },
                {
                  name: 'showActivity',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Show activity in followers\' feeds'
                  }
                }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      admin: {
        description: 'Linked user account (for human profiles)',
        condition: (data) => data?.type === 'human'
      }
    }
  ]
}
