import type { Payload } from 'payload'
import type { Bot, BotChannel, BotBinding } from '@/payload-types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { decrypt, decryptObject } from '../utils/encryption'

export interface OpenClawConfig {
  meta: {
    lastTouchedVersion: string
    lastTouchedAt: string
  }
  auth?: {
    anthropic?: { apiKey: string }
    openai?: { apiKey: string }
    [key: string]: unknown
  }
  agents: {
    defaults: {
      model: string
      systemPrompt?: string
    }
    list: Array<{
      agentId: string
      name: string
      model?: string
      systemPrompt?: string
      avatar?: string
    }>
  }
  gateway: {
    port: number
    bind: string
    auth?: {
      token?: string
    }
  }
  session: {
    scope: string
    reset: {
      mode: string
    }
  }
  tools: {
    bash: boolean
    browser: boolean
    media: boolean
    [key: string]: unknown
  }
  channels: {
    telegram?: Record<string, unknown>
    discord?: Record<string, unknown>
    slack?: Record<string, unknown>
    whatsapp?: Record<string, unknown>
    [key: string]: unknown
  }
  bindings: Array<{
    agentId: string
    match: {
      channel: string
      accountId?: string
      peer?: {
        kind: string
        id: string
      }
      guildId?: string
      teamId?: string
    }
  }>
}

/**
 * Config synchronization layer
 * Converts Payload database records to OpenClaw JSON5 config format
 */
export class ConfigSync {
  constructor(private payload: Payload) {}

  /**
   * Generate OpenClaw config from Payload bot data
   */
  async generateBotConfig(botId: string | number): Promise<OpenClawConfig> {
    // Fetch bot
    const bot = await this.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      throw new Error(`Bot ${botId} not found`)
    }

    // Fetch bot channels
    const channelsResult = await this.payload.find({
      collection: 'bot-channels',
      where: {
        bot: {
          equals: bot.id
        }
      }
    })

    // Fetch bot bindings
    const bindingsResult = await this.payload.find({
      collection: 'bot-bindings',
      where: {
        bot: {
          equals: bot.id
        }
      }
    })

    // Build config
    const config: OpenClawConfig = {
      meta: {
        lastTouchedVersion: '2026.1.30',
        lastTouchedAt: new Date().toISOString()
      },
      agents: {
        defaults: {
          model: bot.model || 'claude-sonnet-4-5',
          systemPrompt: bot.systemPrompt || undefined
        },
        list: [
          {
            agentId: bot.agentId,
            name: bot.name,
            model: bot.model || undefined,
            systemPrompt: bot.systemPrompt || undefined,
            avatar:
              typeof bot.avatar === 'object' && bot.avatar !== null && 'url' in bot.avatar
                ? String(bot.avatar.url)
                : undefined
          }
        ]
      },
      gateway: {
        port: bot.gateway?.port || 18789,
        bind: bot.gateway?.bind || 'loopback',
        auth: {
          token: bot.gateway?.authToken || undefined
        }
      },
      session: {
        scope: bot.sessions?.scope || 'per-sender',
        reset: {
          mode: bot.sessions?.resetMode || 'daily'
        }
      },
      tools: {
        bash: bot.tools?.bash || false,
        browser: bot.tools?.browser || false,
        media: bot.tools?.media !== false,
        ...(bot.tools?.customSkills || {})
      },
      channels: this.buildChannelsConfig(channelsResult.docs),
      bindings: this.buildBindingsConfig(bot.agentId, bindingsResult.docs)
    }

    return config
  }

  /**
   * Build channels config from BotChannel records
   */
  private buildChannelsConfig(channels: BotChannel[]): OpenClawConfig['channels'] {
    const channelsConfig: OpenClawConfig['channels'] = {}

    for (const channel of channels) {
      const channelType = channel.channel
      const accountId = channel.accountId || 'default'

      if (!channelsConfig[channelType]) {
        channelsConfig[channelType] = {}
      }

      const channelConfig: Record<string, unknown> = {
        enabled: channel.status === 'connected',
        dmPolicy: channel.config?.dmPolicy || 'allowlist',
        groupPolicy: channel.config?.groupPolicy || 'allowlist',
        allowlist: channel.config?.allowlist?.map((item: { peerId: string }) => item.peerId) || [],
        autoReply: channel.config?.autoReply !== false,
        mentionPolicy: channel.config?.mentionPolicy || 'always'
      }

      // Decrypt and add credentials
      if (channel.credentials) {
        try {
          const credentials = this.decryptChannelCredentials(channelType, channel.credentials)
          Object.assign(channelConfig, credentials)
        } catch (error) {
          this.payload.logger.error(`Failed to decrypt credentials for ${channelType}:${accountId}: ${error}`)
        }
      }

      const configObj = channelsConfig[channelType]
      if (configObj && typeof configObj === 'object') {
        configObj[accountId] = channelConfig
      }
    }

    return channelsConfig
  }

  /**
   * Build bindings config from BotBinding records
   */
  private buildBindingsConfig(
    agentId: string,
    bindings: BotBinding[]
  ): OpenClawConfig['bindings'] {
    return bindings.map((binding) => ({
      agentId,
      match: {
        channel: binding.channel,
        accountId: binding.accountId || undefined,
        peer:
          binding.peer?.kind && binding.peer?.id
            ? {
                kind: binding.peer.kind,
                id: binding.peer.id
              }
            : undefined,
        guildId: binding.guildId || undefined,
        teamId: binding.teamId || undefined
      }
    }))
  }

  /**
   * Decrypt channel credentials based on channel type
   */
  private decryptChannelCredentials(
    channelType: string,
    credentials: Record<string, unknown>
  ): Record<string, unknown> {
    const decrypted: Record<string, unknown> = {}

    // Handle channel-specific credential fields
    const channelCreds = credentials[channelType]
    if (channelCreds && typeof channelCreds === 'object') {
      for (const [key, value] of Object.entries(channelCreds)) {
        if (typeof value === 'string') {
          try {
            decrypted[key] = decrypt(value)
          } catch {
            // Not encrypted or decryption failed
            decrypted[key] = value
          }
        } else {
          decrypted[key] = value
        }
      }
    }

    return decrypted
  }

  /**
   * Write config to file system
   */
  async writeConfigToFile(
    config: OpenClawConfig,
    outputPath: string
  ): Promise<void> {
    // Ensure directory exists
    const dir = join(outputPath, '..')
    await mkdir(dir, { recursive: true })

    // Write config
    const configJson = JSON.stringify(config, null, 2)
    await writeFile(outputPath, configJson, 'utf8')
  }

  /**
   * Full sync: generate and write config
   */
  async syncBotConfig(botId: string | number, outputPath: string): Promise<void> {
    const config = await this.generateBotConfig(botId)
    await this.writeConfigToFile(config, outputPath)
    this.payload.logger.info(`Synced bot ${botId} config to ${outputPath}`)
  }
}

/**
 * Get ConfigSync instance
 */
export function getConfigSync(payload: Payload): ConfigSync {
  return new ConfigSync(payload)
}
