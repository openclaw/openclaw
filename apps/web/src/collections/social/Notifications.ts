import type { CollectionConfig } from 'payload'

export const Notifications: CollectionConfig = {
  slug: 'notifications',
  admin: {
    useAsTitle: 'content',
    defaultColumns: ['recipient', 'type', 'actor', 'read', 'createdAt'],
    group: 'Social'
  },
  indexes: [
    {
      fields: {
        recipient: 1,
        read: 1,
        createdAt: -1
      },
      options: {
        name: 'notifications_inbox_idx'
      }
    },
    {
      fields: {
        recipient: 1,
        type: 1
      },
      options: {
        name: 'notifications_recipient_type_idx'
      }
    },
    {
      fields: {
        createdAt: -1
      },
      options: {
        name: 'notifications_created_at_idx'
      }
    }
  ],
  access: {
    create: () => true, // System creates notifications
    read: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      // Users can only read their own notifications
      return {
        'recipient.user': {
          equals: user?.id
        }
      }
    },
    update: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      return {
        'recipient.user': {
          equals: user?.id
        }
      }
    },
    delete: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      return {
        'recipient.user': {
          equals: user?.id
        }
      }
    }
  },
  fields: [
    {
      name: 'recipient',
      type: 'relationship',
      relationTo: 'profiles',
      required: true,
      admin: {
        description: 'Notification recipient'
      }
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      options: [
        { label: 'New Follower', value: 'new_follower' },
        { label: 'Like', value: 'like' },
        { label: 'Comment', value: 'comment' },
        { label: 'Mention', value: 'mention' },
        { label: 'Repost', value: 'repost' },
        { label: 'Agent Post', value: 'agent_post' },
        { label: 'Direct Message', value: 'dm' }
      ]
    },
    {
      name: 'actor',
      type: 'relationship',
      relationTo: 'profiles',
      required: true,
      admin: {
        description: 'Profile that triggered the notification'
      }
    },
    {
      name: 'targetType',
      type: 'select',
      options: [
        { label: 'Post', value: 'post' },
        { label: 'Comment', value: 'comment' },
        { label: 'Profile', value: 'profile' }
      ]
    },
    {
      name: 'targetPost',
      type: 'relationship',
      relationTo: 'posts',
      admin: {
        condition: (data) => data?.targetType === 'post'
      }
    },
    {
      name: 'targetComment',
      type: 'relationship',
      relationTo: 'comments',
      admin: {
        condition: (data) => data?.targetType === 'comment'
      }
    },
    {
      name: 'targetProfile',
      type: 'relationship',
      relationTo: 'profiles',
      admin: {
        condition: (data) => data?.targetType === 'profile'
      }
    },
    {
      name: 'content',
      type: 'text',
      required: true,
      admin: {
        description: 'Notification message'
      }
    },
    {
      name: 'read',
      type: 'checkbox',
      defaultValue: false
    },
    {
      name: 'readAt',
      type: 'date',
      admin: {
        condition: (data) => data?.read
      }
    }
  ]
}
