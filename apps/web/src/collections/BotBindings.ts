import type { CollectionConfig } from 'payload'

export const BotBindings: CollectionConfig = {
  slug: 'bot-bindings',
  admin: {
    useAsTitle: 'displayName',
    defaultColumns: ['displayName', 'bot', 'channel', 'priority'],
    group: 'Bot Management',
    description: 'Route specific channels/peers to specific bots'
  },
  access: {
    create: ({ req: { user } }) => {
      return user?.role === 'admin' || user?.role === 'operator'
    },
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
    update: ({ req: { user } }) => {
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
    delete: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      if (user?.role === 'operator') {
        return {
          bot: {
            in: user?.assignedBots || []
          }
        }
      }
      return false
    }
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      required: false,
      admin: {
        description: 'Optional display name for this binding'
      }
    },
    {
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      admin: {
        description: 'Bot to route messages to'
      }
    },
    {
      name: 'channel',
      type: 'text',
      required: true,
      admin: {
        description: 'Channel name (telegram, discord, etc.)'
      }
    },
    {
      name: 'accountId',
      type: 'text',
      required: false,
      admin: {
        description: 'Optional: specific account ID (* for all accounts)'
      }
    },
    {
      name: 'peer',
      type: 'group',
      admin: {
        description: 'Optional: route specific peer (DM, group, channel)'
      },
      fields: [
        {
          name: 'kind',
          type: 'select',
          options: [
            { label: 'DM', value: 'dm' },
            { label: 'Group', value: 'group' },
            { label: 'Channel', value: 'channel' }
          ]
        },
        {
          name: 'id',
          type: 'text',
          admin: {
            description: 'User ID, group ID, or channel ID'
          }
        }
      ]
    },
    {
      name: 'guildId',
      type: 'text',
      required: false,
      admin: {
        description: 'Discord guild ID (optional)'
      }
    },
    {
      name: 'teamId',
      type: 'text',
      required: false,
      admin: {
        description: 'MS Teams team ID (optional)'
      }
    },
    {
      name: 'priority',
      type: 'number',
      required: true,
      defaultValue: 100,
      admin: {
        description: 'Higher priority bindings are checked first'
      }
    }
  ]
}
