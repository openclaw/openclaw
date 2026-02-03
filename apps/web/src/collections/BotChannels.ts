import type { CollectionConfig } from 'payload'

export const BotChannels: CollectionConfig = {
  slug: 'bot-channels',
  admin: {
    useAsTitle: 'displayName',
    defaultColumns: ['displayName', 'bot', 'channel', 'status'],
    group: 'Bot Management'
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
  hooks: {
    beforeChange: [
      async ({ data, operation }) => {
        // Encrypt credentials before saving
        if (operation === 'create' || operation === 'update') {
          if (data.credentials) {
            const { encrypt, isEncrypted } = await import('../lib/utils/encryption')
            const channelType = data.channel
            const channelCreds = data.credentials[channelType]

            if (channelCreds && typeof channelCreds === 'object') {
              const encrypted: Record<string, any> = {}

              for (const [key, value] of Object.entries(channelCreds)) {
                if (typeof value === 'string' && !isEncrypted(value)) {
                  // Encrypt sensitive credential fields
                  encrypted[key] = encrypt(value)
                } else {
                  encrypted[key] = value
                }
              }

              data.credentials[channelType] = encrypted
            }
          }
        }

        return data
      }
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation === 'create' || operation === 'update') {
          req.payload.logger.info(
            `Channel config changed for bot ${doc.bot}, syncing and reconnecting...`
          )

          try {
            // Import services
            const { getConfigSync } = await import('../lib/gateway/config-sync')
            const { getOrchestrator } = await import('../lib/gateway/orchestrator')

            const configSync = getConfigSync(req.payload)
            const orchestrator = getOrchestrator()

            // Fetch bot
            const botId = typeof doc.bot === 'string' ? doc.bot : doc.bot?.id
            const bot = await req.payload.findByID({
              collection: 'bots',
              id: botId
            })

            if (!bot) {
              req.payload.logger.warn(`Bot ${botId} not found`)
              return
            }

            // Sync config to file system
            const outputPath = `/var/openclaw/bots/${bot.agentId}/config.json5`
            await configSync.syncBotConfig(bot.id, outputPath)

            req.payload.logger.info(`✓ Synced config for bot ${bot.agentId}`)

            // If bot is active, restart to pick up new channel config
            if (bot.status === 'active') {
              req.payload.logger.info(
                `Restarting bot ${bot.agentId} to reconnect channels...`
              )
              await orchestrator.restartBot(bot)
              req.payload.logger.info(`✓ Restarted bot ${bot.agentId}`)
            } else {
              req.payload.logger.info(
                `Bot ${bot.agentId} not active, config synced but not restarted`
              )
            }

            // Update channel status to 'disconnected' until reconnection succeeds
            await req.payload.update({
              collection: 'bot-channels',
              id: doc.id,
              data: {
                status: 'disconnected',
                lastSeen: new Date().toISOString()
              }
            })
          } catch (error) {
            req.payload.logger.error(
              `Failed to sync/reconnect channel for bot: ${error}`
            )

            // Mark channel as error
            await req.payload.update({
              collection: 'bot-channels',
              id: doc.id,
              data: {
                status: 'error',
                errorMessage: error instanceof Error ? error.message : String(error)
              }
            })
          }
        }
      }
    ]
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      required: false,
      admin: {
        description: 'Optional display name (auto-generated if empty)'
      }
    },
    {
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      admin: {
        description: 'Bot that uses this channel'
      }
    },
    {
      name: 'channel',
      type: 'select',
      required: true,
      options: [
        { label: 'Telegram', value: 'telegram' },
        { label: 'Discord', value: 'discord' },
        { label: 'Slack', value: 'slack' },
        { label: 'WhatsApp Web', value: 'whatsapp' },
        { label: 'Signal', value: 'signal' },
        { label: 'iMessage', value: 'imessage' },
        { label: 'LINE', value: 'line' },
        { label: 'Google Chat', value: 'googlechat' }
      ],
      admin: {
        description: 'Messaging platform'
      }
    },
    {
      name: 'accountId',
      type: 'text',
      required: true,
      defaultValue: 'default',
      admin: {
        description: 'Channel account identifier (e.g., "default", "bot1")'
      }
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'disconnected',
      options: [
        { label: 'Connected', value: 'connected' },
        { label: 'Disconnected', value: 'disconnected' },
        { label: 'Error', value: 'error' }
      ],
      admin: {
        position: 'sidebar'
      }
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Credentials',
          fields: [
            {
              name: 'credentials',
              type: 'group',
              admin: {
                description: 'Channel-specific authentication (encrypted at rest)'
              },
              fields: [
                {
                  name: 'telegram',
                  type: 'group',
                  admin: {
                    condition: (data) => data.channel === 'telegram'
                  },
                  fields: [
                    {
                      name: 'botToken',
                      type: 'text',
                      required: false,
                      admin: {
                        description: 'Get from @BotFather',
                        placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
                      }
                    }
                  ]
                },
                {
                  name: 'discord',
                  type: 'group',
                  admin: {
                    condition: (data) => data.channel === 'discord'
                  },
                  fields: [
                    {
                      name: 'token',
                      type: 'text',
                      required: false,
                      admin: {
                        description: 'Discord bot token'
                      }
                    },
                    {
                      name: 'applicationId',
                      type: 'text',
                      required: false,
                      admin: {
                        description: 'Discord application ID'
                      }
                    }
                  ]
                },
                {
                  name: 'slack',
                  type: 'group',
                  admin: {
                    condition: (data) => data.channel === 'slack'
                  },
                  fields: [
                    {
                      name: 'botToken',
                      type: 'text',
                      required: false,
                      admin: {
                        description: 'Slack bot token (xoxb-...)'
                      }
                    },
                    {
                      name: 'appToken',
                      type: 'text',
                      required: false,
                      admin: {
                        description: 'Slack app token (xapp-...)'
                      }
                    }
                  ]
                },
                {
                  name: 'whatsapp',
                  type: 'group',
                  admin: {
                    condition: (data) => data.channel === 'whatsapp'
                  },
                  fields: [
                    {
                      name: 'sessionData',
                      type: 'json',
                      required: false,
                      admin: {
                        description: 'WhatsApp session (pairing via QR code)',
                        readOnly: true
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          label: 'Access Control',
          fields: [
            {
              name: 'config',
              type: 'group',
              fields: [
                {
                  name: 'dmPolicy',
                  type: 'select',
                  required: true,
                  defaultValue: 'allowlist',
                  options: [
                    { label: 'All (anyone can DM)', value: 'all' },
                    { label: 'Allowlist (restricted)', value: 'allowlist' },
                    { label: 'None (DMs disabled)', value: 'none' }
                  ]
                },
                {
                  name: 'groupPolicy',
                  type: 'select',
                  required: true,
                  defaultValue: 'allowlist',
                  options: [
                    { label: 'All (join any group)', value: 'all' },
                    { label: 'Allowlist (restricted)', value: 'allowlist' },
                    { label: 'None (groups disabled)', value: 'none' }
                  ]
                },
                {
                  name: 'allowlist',
                  type: 'array',
                  fields: [
                    {
                      name: 'peerId',
                      type: 'text',
                      required: true,
                      admin: {
                        description: 'User ID, group ID, or channel ID'
                      }
                    }
                  ],
                  admin: {
                    description: 'List of allowed peers',
                    condition: (data) =>
                      data?.config?.dmPolicy === 'allowlist' ||
                      data?.config?.groupPolicy === 'allowlist'
                  }
                },
                {
                  name: 'autoReply',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Send automatic replies'
                  }
                },
                {
                  name: 'mentionPolicy',
                  type: 'select',
                  defaultValue: 'always',
                  options: [
                    { label: 'Always respond', value: 'always' },
                    { label: 'Only when mentioned', value: 'mentioned' },
                    { label: 'Never in groups', value: 'never' }
                  ],
                  admin: {
                    description: 'How bot responds in group chats'
                  }
                }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'lastSeen',
      type: 'date',
      required: false,
      admin: {
        description: 'Last connection time',
        readOnly: true,
        position: 'sidebar'
      }
    },
    {
      name: 'errorMessage',
      type: 'textarea',
      required: false,
      admin: {
        description: 'Last error (if status is error)',
        readOnly: true,
        condition: (data) => data.status === 'error'
      }
    }
  ]
}
