import type { Payload } from 'payload'
import type { Bot, BotBinding, BotChannel } from '@/payload-types'

/**
 * Message Router
 *
 * Routes incoming messages from channels (Telegram, Discord, Slack, etc.) to the
 * appropriate bot based on bindings configuration.
 *
 * Responsibilities:
 * - Find matching bot binding
 * - Validate auto-reply policies
 * - Check allowlists/blocklists
 * - Enforce rate limits
 * - Route to OpenClaw gateway
 */

export interface IncomingMessage {
  channel: string
  accountId?: string
  peer: {
    kind: 'user' | 'group' | 'channel'
    id: string
    name?: string
  }
  message: string
  messageId?: string
  from?: {
    id: string
    username?: string
    firstName?: string
    lastName?: string
  }
  isMention?: boolean
  replyTo?: string
  media?: Array<{
    type: 'photo' | 'video' | 'audio' | 'document'
    url: string
    fileId?: string
  }>
  timestamp?: number
  guildId?: string
  teamId?: string
}

export interface RoutingResult {
  routed: boolean
  botId?: string
  agentId?: string
  reason: string
  bindingId?: string
}

export class MessageRouter {
  constructor(private payload: Payload) {}

  /**
   * Route incoming message to appropriate bot
   */
  async routeMessage(message: IncomingMessage): Promise<RoutingResult> {
    try {
      // 1. Find matching bot binding
      const binding = await this.findBotBinding(message)

      if (!binding) {
        this.payload.logger.debug(
          `No bot binding found for ${message.channel}:${message.peer.id}`
        )
        return {
          routed: false,
          reason: 'No matching bot binding'
        }
      }

      // 2. Get bot details
      const botId = typeof binding.bot === 'string' ? binding.bot : binding.bot?.id
      const bot = await this.payload.findByID({
        collection: 'bots',
        id: botId,
        depth: 1
      })

      if (!bot) {
        return {
          routed: false,
          reason: 'Bot not found'
        }
      }

      // 3. Check if bot is active
      if (bot.status !== 'active') {
        this.payload.logger.warn(`Bot ${bot.agentId} not active, cannot route message`)
        return {
          routed: false,
          botId: bot.id,
          agentId: bot.agentId,
          reason: `Bot status: ${bot.status}`
        }
      }

      // 4. Check auto-reply policy
      const policyCheck = await this.checkAutoReplyPolicy(bot, binding, message)
      if (!policyCheck.allowed) {
        this.payload.logger.debug(
          `Auto-reply policy blocked message: ${policyCheck.reason}`
        )
        return {
          routed: false,
          botId: bot.id,
          agentId: bot.agentId,
          reason: policyCheck.reason,
          bindingId: binding.id
        }
      }

      // 5. Check rate limits
      const rateLimitCheck = await this.checkRateLimit(bot, message)
      if (!rateLimitCheck.allowed) {
        this.payload.logger.warn(
          `Rate limit exceeded for ${message.peer.id}: ${rateLimitCheck.reason}`
        )
        return {
          routed: false,
          botId: bot.id,
          agentId: bot.agentId,
          reason: rateLimitCheck.reason,
          bindingId: binding.id
        }
      }

      // 6. Send to OpenClaw gateway
      await this.sendToGateway(bot, message)

      // 7. Track message in session
      await this.trackMessage(bot, message, 'incoming')

      this.payload.logger.info(
        `Routed message from ${message.channel}:${message.peer.id} to bot ${bot.agentId}`
      )

      return {
        routed: true,
        botId: bot.id,
        agentId: bot.agentId,
        reason: 'Message routed successfully',
        bindingId: binding.id
      }
    } catch (error) {
      this.payload.logger.error(`Failed to route message: ${error}`)
      return {
        routed: false,
        reason: `Routing error: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * Find matching bot binding for message
   */
  private async findBotBinding(message: IncomingMessage): Promise<BotBinding | null> {
    const whereConditions: any[] = [
      { channel: { equals: message.channel } }
    ]

    // Match accountId if provided
    if (message.accountId) {
      whereConditions.push({ accountId: { equals: message.accountId } })
    }

    // Try exact peer match first
    if (message.peer) {
      const exactBindings = await this.payload.find({
        collection: 'bot-bindings',
        where: {
          and: [
            ...whereConditions,
            { 'peer.kind': { equals: message.peer.kind } },
            { 'peer.id': { equals: message.peer.id } }
          ]
        },
        limit: 1
      })

      if (exactBindings.docs.length > 0) {
        return exactBindings.docs[0]
      }
    }

    // Try guild/team match
    if (message.guildId) {
      const guildBindings = await this.payload.find({
        collection: 'bot-bindings',
        where: {
          and: [
            ...whereConditions,
            { guildId: { equals: message.guildId } }
          ]
        },
        limit: 1
      })

      if (guildBindings.docs.length > 0) {
        return guildBindings.docs[0]
      }
    }

    if (message.teamId) {
      const teamBindings = await this.payload.find({
        collection: 'bot-bindings',
        where: {
          and: [
            ...whereConditions,
            { teamId: { equals: message.teamId } }
          ]
        },
        limit: 1
      })

      if (teamBindings.docs.length > 0) {
        return teamBindings.docs[0]
      }
    }

    // Fallback: channel-wide binding (no specific peer)
    const channelBindings = await this.payload.find({
      collection: 'bot-bindings',
      where: {
        and: whereConditions
      },
      limit: 1
    })

    return channelBindings.docs[0] || null
  }

  /**
   * Check auto-reply policy
   */
  private async checkAutoReplyPolicy(
    bot: Bot,
    binding: BotBinding,
    message: IncomingMessage
  ): Promise<{ allowed: boolean; reason: string }> {
    // Get channel config
    const channels = await this.payload.find({
      collection: 'bot-channels',
      where: {
        and: [
          { bot: { equals: bot.id } },
          { channel: { equals: message.channel } },
          message.accountId ? { accountId: { equals: message.accountId } } : {}
        ]
      },
      limit: 1
    })

    if (channels.docs.length === 0) {
      return {
        allowed: false,
        reason: 'Channel not configured for bot'
      }
    }

    const channelConfig = channels.docs[0]
    const config = channelConfig.config || {}

    // Check if auto-reply is enabled
    if (config.autoReply === false) {
      return {
        allowed: false,
        reason: 'Auto-reply disabled for this channel'
      }
    }

    const isDM = message.peer.kind === 'user'
    const isGroup = message.peer.kind === 'group' || message.peer.kind === 'channel'

    // Check DM policy
    if (isDM) {
      const dmPolicy = config.dmPolicy || 'allowlist'

      if (dmPolicy === 'allowlist') {
        const allowlist = config.allowlist || []
        const allowed = allowlist.some((item: any) => item.peerId === message.peer.id)

        if (!allowed) {
          return {
            allowed: false,
            reason: 'User not in DM allowlist'
          }
        }
      } else if (dmPolicy === 'blocklist') {
        const blocklist = config.blocklist || []
        const blocked = blocklist.some((item: any) => item.peerId === message.peer.id)

        if (blocked) {
          return {
            allowed: false,
            reason: 'User in DM blocklist'
          }
        }
      }
      // 'open' policy allows all DMs
    }

    // Check group policy
    if (isGroup) {
      const groupPolicy = config.groupPolicy || 'allowlist'

      if (groupPolicy === 'allowlist') {
        const allowlist = config.allowlist || []
        const allowed = allowlist.some((item: any) => item.peerId === message.peer.id)

        if (!allowed) {
          return {
            allowed: false,
            reason: 'Group not in allowlist'
          }
        }
      } else if (groupPolicy === 'blocklist') {
        const blocklist = config.blocklist || []
        const blocked = blocklist.some((item: any) => item.peerId === message.peer.id)

        if (blocked) {
          return {
            allowed: false,
            reason: 'Group in blocklist'
          }
        }
      }

      // Check mention policy for groups
      const mentionPolicy = config.mentionPolicy || 'always'

      if (mentionPolicy === 'always' && !message.isMention) {
        return {
          allowed: false,
          reason: 'Bot must be mentioned in groups'
        }
      } else if (mentionPolicy === 'never') {
        return {
          allowed: false,
          reason: 'Bot disabled in groups'
        }
      }
      // 'dm-only' allows all group messages when mentioned
    }

    return {
      allowed: true,
      reason: 'Policy check passed'
    }
  }

  /**
   * Check rate limits
   */
  private async checkRateLimit(
    bot: Bot,
    message: IncomingMessage
  ): Promise<{ allowed: boolean; reason: string }> {
    const rateLimits = bot.settings?.rateLimits || {
      messagesPerHour: 60,
      messagesPerDay: 500
    }

    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // Count recent messages from this peer
    const recentSessions = await this.payload.find({
      collection: 'sessions',
      where: {
        and: [
          { bot: { equals: bot.id } },
          { peer: { equals: message.peer.id } },
          { lastMessage: { greater_than: oneHourAgo.toISOString() } }
        ]
      }
    })

    // Approximate: assume each session = multiple messages
    const messagesLastHour = recentSessions.docs.reduce(
      (sum, session) => sum + (session.messageCount || 0),
      0
    )

    if (messagesLastHour > rateLimits.messagesPerHour) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${messagesLastHour}/${rateLimits.messagesPerHour} messages per hour`
      }
    }

    // Check daily limit
    const dailySessions = await this.payload.find({
      collection: 'sessions',
      where: {
        and: [
          { bot: { equals: bot.id } },
          { peer: { equals: message.peer.id } },
          { lastMessage: { greater_than: oneDayAgo.toISOString() } }
        ]
      }
    })

    const messagesLastDay = dailySessions.docs.reduce(
      (sum, session) => sum + (session.messageCount || 0),
      0
    )

    if (messagesLastDay > rateLimits.messagesPerDay) {
      return {
        allowed: false,
        reason: `Daily rate limit exceeded: ${messagesLastDay}/${rateLimits.messagesPerDay} messages`
      }
    }

    return {
      allowed: true,
      reason: 'Rate limit check passed'
    }
  }

  /**
   * Send message to OpenClaw gateway
   */
  private async sendToGateway(bot: Bot, message: IncomingMessage): Promise<void> {
    if (!bot.gateway?.port) {
      throw new Error(`Bot ${bot.agentId} has no gateway port configured`)
    }

    const gatewayUrl = `http://localhost:${bot.gateway.port}`

    // Build session key (channel:peer:agentId)
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    const response = await fetch(`${gatewayUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bot.gateway.authToken || 'dev-token'}`
      },
      body: JSON.stringify({
        sessionKey,
        channel: message.channel,
        peer: message.peer,
        message: message.message,
        from: message.from,
        messageId: message.messageId,
        replyTo: message.replyTo,
        media: message.media,
        timestamp: message.timestamp || Date.now()
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Gateway returned ${response.status}: ${error}`)
    }

    this.payload.logger.debug(`Message sent to gateway ${gatewayUrl}`)
  }

  /**
   * Track message in session
   */
  private async trackMessage(
    bot: Bot,
    message: IncomingMessage,
    direction: 'incoming' | 'outgoing'
  ): Promise<void> {
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    // Find or create session
    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1
    })

    if (sessions.docs.length > 0) {
      // Update existing session
      const session = sessions.docs[0]
      await this.payload.update({
        collection: 'sessions',
        id: session.id,
        data: {
          messageCount: (session.messageCount || 0) + 1,
          lastMessage: new Date().toISOString()
        }
      })
    } else {
      // Create new session
      await this.payload.create({
        collection: 'sessions',
        data: {
          bot: bot.id,
          sessionKey,
          channel: message.channel,
          peer: message.peer.id,
          messageCount: 1,
          lastMessage: new Date().toISOString()
        }
      })
    }
  }
}

/**
 * Get MessageRouter instance
 */
export function getMessageRouter(payload: Payload): MessageRouter {
  return new MessageRouter(payload)
}
