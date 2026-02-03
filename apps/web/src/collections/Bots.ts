import type { CollectionConfig } from 'payload'

export const Bots: CollectionConfig = {
  slug: 'bots',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'user', 'status', 'model', 'updatedAt'],
    group: 'Bot Management'
  },
  indexes: [
    {
      fields: {
        user: 1
      },
      options: {
        name: 'bots_user_idx'
      }
    },
    {
      fields: {
        user: 1,
        status: 1
      },
      options: {
        name: 'bots_user_status_idx'
      }
    },
    {
      fields: {
        status: 1
      },
      options: {
        name: 'bots_status_idx'
      }
    },
    {
      fields: {
        createdAt: -1
      },
      options: {
        name: 'bots_created_at_idx'
      }
    }
  ],
  access: {
    create: ({ req: { user } }) => {
      return user?.role === 'admin' || user?.role === 'operator'
    },
    read: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      if (user?.role === 'operator') {
        return {
          id: {
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
          id: {
            in: user?.assignedBots || []
          }
        }
      }
      return false
    },
    delete: ({ req: { user } }) => {
      return user?.role === 'admin'
    }
  },
  hooks: {
    beforeChange: [
      ({ data }) => {
        // Auto-generate agentId from name if not provided
        if (!data.agentId && data.name) {
          data.agentId = data.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        }
        return data
      }
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        // Sync config to gateway after create/update
        if (operation === 'create' || operation === 'update') {
          req.payload.logger.info(`Bot ${doc.agentId} config changed, syncing...`)

          try {
            // Import sync service
            const { getConfigSync } = await import('../lib/gateway/config-sync')
            const configSync = getConfigSync(req.payload)

            // Sync config to file system
            const outputPath = `/var/openclaw/bots/${doc.agentId}/config.json5`
            await configSync.syncBotConfig(doc.id, outputPath)

            req.payload.logger.info(`✓ Synced config for bot ${doc.agentId}`)

            // If bot is active, restart to pick up new config
            if (doc.status === 'active') {
              const { getOrchestrator } = await import('../lib/gateway/orchestrator')
              const orchestrator = getOrchestrator()

              req.payload.logger.info(`Restarting bot ${doc.agentId} with new config...`)
              await orchestrator.restartBot(doc)
              req.payload.logger.info(`✓ Restarted bot ${doc.agentId}`)

              // Restart session sync watcher
              const { getSessionSyncInstance } = await import('../lib/server-init')
              const sessionSync = getSessionSyncInstance()
              if (sessionSync) {
                sessionSync.stopWatching(doc.id)
                await sessionSync.watchBotSessions(doc.id, doc.agentId)
              }
            }
          } catch (error) {
            req.payload.logger.error(
              `Failed to sync/restart bot ${doc.agentId}: ${error}`
            )
          }
        }
      }
    ],
    beforeDelete: [
      async ({ id, req }) => {
        req.payload.logger.info(`Cleaning up bot ${id}...`)

        try {
          // Fetch bot details
          const bot = await req.payload.findByID({
            collection: 'bots',
            id
          })

          // Stop gateway process if running
          if (bot.status === 'active') {
            const { getOrchestrator } = await import('../lib/gateway/orchestrator')
            const orchestrator = getOrchestrator()

            req.payload.logger.info(`Stopping gateway for bot ${bot.agentId}...`)
            await orchestrator.stopBot(bot.agentId)
            req.payload.logger.info(`✓ Stopped gateway for bot ${bot.agentId}`)
          }

          // Stop session sync watcher
          const { getSessionSyncInstance } = await import('../lib/server-init')
          const sessionSync = getSessionSyncInstance()
          if (sessionSync) {
            sessionSync.stopWatching(id)
          }

          // Delete related sessions
          const sessions = await req.payload.find({
            collection: 'sessions',
            where: {
              bot: {
                equals: id
              }
            }
          })

          for (const session of sessions.docs) {
            await req.payload.delete({
              collection: 'sessions',
              id: session.id
            })
          }

          req.payload.logger.info(
            `✓ Deleted ${sessions.docs.length} sessions for bot ${bot.agentId}`
          )

          // Delete related channels
          const channels = await req.payload.find({
            collection: 'bot-channels',
            where: {
              bot: {
                equals: id
              }
            }
          })

          for (const channel of channels.docs) {
            await req.payload.delete({
              collection: 'bot-channels',
              id: channel.id
            })
          }

          req.payload.logger.info(
            `✓ Deleted ${channels.docs.length} channels for bot ${bot.agentId}`
          )

          // Delete related bindings
          const bindings = await req.payload.find({
            collection: 'bot-bindings',
            where: {
              bot: {
                equals: id
              }
            }
          })

          for (const binding of bindings.docs) {
            await req.payload.delete({
              collection: 'bot-bindings',
              id: binding.id
            })
          }

          req.payload.logger.info(
            `✓ Deleted ${bindings.docs.length} bindings for bot ${bot.agentId}`
          )

          req.payload.logger.info(`✅ Bot ${bot.agentId} cleanup complete`)
        } catch (error) {
          req.payload.logger.error(`Failed to cleanup bot ${id}: ${error}`)
        }
      }
    ]
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Display name for this bot (e.g., "Customer Support Bot")'
      }
    },
    {
      name: 'agentId',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Unique identifier (auto-generated from name)',
        readOnly: true
      }
    },
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      admin: {
        description: 'User who owns this bot',
        position: 'sidebar'
      }
    },
    {
      name: 'profile',
      type: 'relationship',
      relationTo: 'profiles',
      admin: {
        description: 'Associated social profile for this bot',
        position: 'sidebar'
      }
    },
    {
      name: 'agentType',
      type: 'select',
      defaultValue: 'assistant',
      options: [
        { label: 'Assistant', value: 'assistant' },
        { label: 'Content Creator', value: 'content_creator' },
        { label: 'Data Analyst', value: 'data_analyst' },
        { label: 'Code Helper', value: 'code_helper' },
        { label: 'Customer Support', value: 'customer_support' },
        { label: 'Researcher', value: 'researcher' },
        { label: 'Custom', value: 'custom' }
      ],
      admin: {
        description: 'Type of bot/agent'
      }
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'inactive',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
        { label: 'Error', value: 'error' }
      ],
      admin: {
        position: 'sidebar'
      }
    },
    {
      name: 'model',
      type: 'select',
      required: true,
      defaultValue: 'claude-sonnet-4-5',
      options: [
        { label: 'Claude Opus 4.5', value: 'claude-opus-4-5' },
        { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5' },
        { label: 'Claude Haiku 4', value: 'claude-haiku-4' },
        { label: 'Claude Sonnet 3.5', value: 'claude-3-5-sonnet-20241022' }
      ],
      admin: {
        description: 'AI model powering this bot'
      }
    },
    {
      name: 'systemPrompt',
      type: 'textarea',
      required: false,
      admin: {
        description: 'Bot personality and instructions',
        placeholder: 'You are a helpful assistant...'
      }
    },
    {
      name: 'avatar',
      type: 'upload',
      relationTo: 'media',
      required: false,
      admin: {
        description: 'Bot profile image'
      }
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Gateway',
          fields: [
            {
              name: 'gateway',
              type: 'group',
              fields: [
                {
                  name: 'port',
                  type: 'number',
                  required: true,
                  defaultValue: 18789,
                  admin: {
                    description: 'Gateway port (auto-assigned)'
                  }
                },
                {
                  name: 'bind',
                  type: 'select',
                  required: true,
                  defaultValue: 'loopback',
                  options: [
                    { label: 'Loopback (localhost only)', value: 'loopback' },
                    { label: 'LAN (local network)', value: 'lan' },
                    { label: 'Public (internet)', value: 'public' }
                  ]
                },
                {
                  name: 'authToken',
                  type: 'text',
                  required: false,
                  admin: {
                    description: 'Gateway authentication token (auto-generated)',
                    readOnly: true
                  }
                },
                {
                  name: 'processId',
                  type: 'number',
                  required: false,
                  admin: {
                    description: 'Process ID when gateway is running',
                    readOnly: true
                  }
                }
              ]
            }
          ]
        },
        {
          label: 'Sessions',
          fields: [
            {
              name: 'sessions',
              type: 'group',
              fields: [
                {
                  name: 'scope',
                  type: 'select',
                  required: true,
                  defaultValue: 'per-sender',
                  options: [
                    { label: 'Per Sender', value: 'per-sender' },
                    { label: 'Global', value: 'global' }
                  ],
                  admin: {
                    description: 'How conversations are grouped'
                  }
                },
                {
                  name: 'resetMode',
                  type: 'select',
                  required: true,
                  defaultValue: 'daily',
                  options: [
                    { label: 'Daily', value: 'daily' },
                    { label: 'On Idle', value: 'idle' }
                  ]
                }
              ]
            }
          ]
        },
        {
          label: 'Tools',
          fields: [
            {
              name: 'tools',
              type: 'group',
              fields: [
                {
                  name: 'bash',
                  type: 'checkbox',
                  defaultValue: false,
                  admin: {
                    description: 'Allow bot to execute bash commands (CAUTION: security risk)'
                  }
                },
                {
                  name: 'browser',
                  type: 'checkbox',
                  defaultValue: false,
                  admin: {
                    description: 'Allow bot to browse websites'
                  }
                },
                {
                  name: 'media',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Allow bot to process images and media'
                  }
                },
                {
                  name: 'customSkills',
                  type: 'json',
                  admin: {
                    description: 'Custom tool configurations'
                  }
                }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'errorMessage',
      type: 'textarea',
      required: false,
      admin: {
        description: 'Last error message (if status is error)',
        readOnly: true,
        condition: (data) => data.status === 'error'
      }
    },
    {
      name: 'lastSeen',
      type: 'date',
      required: false,
      admin: {
        description: 'Last activity timestamp',
        readOnly: true,
        position: 'sidebar'
      }
    },
    {
      name: 'metrics',
      type: 'group',
      admin: {
        description: 'Bot metrics and statistics'
      },
      fields: [
        {
          name: 'messageCount',
          type: 'number',
          defaultValue: 0,
          admin: {
            readOnly: true
          }
        },
        {
          name: 'sessionCount',
          type: 'number',
          defaultValue: 0,
          admin: {
            readOnly: true
          }
        },
        {
          name: 'uptime',
          type: 'number',
          defaultValue: 0,
          admin: {
            description: 'Uptime in seconds',
            readOnly: true
          }
        }
      ]
    }
  ]
}
