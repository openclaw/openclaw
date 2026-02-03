import type { CollectionConfig } from 'payload'

export const Sessions: CollectionConfig = {
  slug: 'sessions',
  admin: {
    useAsTitle: 'sessionKey',
    defaultColumns: ['sessionKey', 'bot', 'channel', 'messageCount', 'lastMessage'],
    group: 'Bot Management',
    description: 'Active conversation sessions'
  },
  access: {
    create: () => false, // Sessions created automatically by gateway
    read: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      if (user?.role === 'operator') {
        return {
          bot: {
            in: user?.assignedBots || []
          }
        }
      }
      return false
    },
    update: () => false, // Sessions updated automatically
    delete: ({ req: { user } }) => {
      return user?.role === 'admin'
    }
  },
  fields: [
    {
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      admin: {
        description: 'Bot handling this session'
      }
    },
    {
      name: 'sessionKey',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Unique session identifier',
        readOnly: true
      }
    },
    {
      name: 'channel',
      type: 'text',
      required: true,
      admin: {
        readOnly: true
      }
    },
    {
      name: 'peer',
      type: 'text',
      required: true,
      admin: {
        description: 'User ID or group ID',
        readOnly: true
      }
    },
    {
      name: 'messageCount',
      type: 'number',
      required: true,
      defaultValue: 0,
      admin: {
        readOnly: true
      }
    },
    {
      name: 'lastMessage',
      type: 'date',
      required: false,
      admin: {
        readOnly: true
      }
    },
    {
      name: 'deliveryContext',
      type: 'json',
      admin: {
        description: 'Message delivery context',
        readOnly: true
      }
    },
    {
      name: 'transcript',
      type: 'textarea',
      admin: {
        description: 'Recent message history (preview)',
        readOnly: true
      }
    },
    {
      name: 'metadata',
      type: 'json',
      admin: {
        description: 'Session metadata',
        readOnly: true
      }
    }
  ]
}
