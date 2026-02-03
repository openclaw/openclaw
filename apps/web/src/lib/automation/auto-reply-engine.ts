import type { Payload } from 'payload'
import type { Bot } from '@/payload-types'
import type { IncomingMessage } from '../message-routing/router'

/**
 * Auto-Reply Engine
 *
 * Makes intelligent decisions about when and how bots should respond to messages.
 *
 * Responsibilities:
 * - Enforce quiet hours
 * - Intelligent rate limiting
 * - Context-aware responses
 * - Priority handling
 * - Smart conversation management
 */

export interface AutoReplyDecision {
  shouldReply: boolean
  reason: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  suggestedDelay?: number // milliseconds
  metadata?: Record<string, any>
}

export class AutoReplyEngine {
  constructor(private payload: Payload) {}

  /**
   * Decide if bot should reply to message
   */
  async shouldReply(
    bot: Bot,
    message: IncomingMessage
  ): Promise<AutoReplyDecision> {
    // 1. Check if bot is in quiet hours
    const quietHoursCheck = this.checkQuietHours(bot)
    if (!quietHoursCheck.allowed) {
      return {
        shouldReply: false,
        reason: quietHoursCheck.reason
      }
    }

    // 2. Check conversation context
    const contextCheck = await this.checkConversationContext(bot, message)
    if (!contextCheck.allowed) {
      return {
        shouldReply: false,
        reason: contextCheck.reason
      }
    }

    // 3. Detect spam/abuse
    const spamCheck = await this.detectSpam(bot, message)
    if (!spamCheck.allowed) {
      return {
        shouldReply: false,
        reason: spamCheck.reason
      }
    }

    // 4. Calculate priority
    const priority = this.calculatePriority(message)

    // 5. Determine response delay (avoid appearing too instant)
    const delay = this.calculateResponseDelay(priority, message)

    return {
      shouldReply: true,
      reason: 'All checks passed',
      priority,
      suggestedDelay: delay,
      metadata: {
        quietHours: false,
        spam: false,
        priority
      }
    }
  }

  /**
   * Check quiet hours
   */
  private checkQuietHours(bot: Bot): { allowed: boolean; reason: string } {
    const settings = bot.settings?.quietHours

    if (!settings?.enabled) {
      return { allowed: true, reason: 'Quiet hours not enabled' }
    }

    const now = new Date()
    const currentHour = now.getHours()
    const currentDay = now.getDay() // 0 = Sunday, 6 = Saturday

    // Check day of week
    if (settings.daysOfWeek && settings.daysOfWeek.length > 0) {
      if (!settings.daysOfWeek.includes(currentDay)) {
        return { allowed: true, reason: 'Quiet hours not active today' }
      }
    }

    // Check time range
    const startHour = settings.startHour || 23 // 11 PM
    const endHour = settings.endHour || 7 // 7 AM

    let inQuietHours = false

    if (startHour < endHour) {
      // Same day range (e.g., 9 AM - 5 PM)
      inQuietHours = currentHour >= startHour && currentHour < endHour
    } else {
      // Crosses midnight (e.g., 11 PM - 7 AM)
      inQuietHours = currentHour >= startHour || currentHour < endHour
    }

    if (inQuietHours) {
      return {
        allowed: false,
        reason: `Quiet hours active (${startHour}:00 - ${endHour}:00)`
      }
    }

    return { allowed: true, reason: 'Outside quiet hours' }
  }

  /**
   * Check conversation context
   */
  private async checkConversationContext(
    bot: Bot,
    message: IncomingMessage
  ): Promise<{ allowed: boolean; reason: string }> {
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    // Get recent session
    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1,
      sort: '-lastMessage'
    })

    if (sessions.docs.length === 0) {
      // New conversation - always allow
      return {
        allowed: true,
        reason: 'New conversation'
      }
    }

    const session = sessions.docs[0]

    // Check if conversation was ended by user
    if (session.metadata?.ended === true) {
      const endedAt = new Date(session.metadata.endedAt)
      const now = new Date()
      const hoursSinceEnd = (now.getTime() - endedAt.getTime()) / (1000 * 60 * 60)

      // Don't reply within 24 hours of user ending conversation
      if (hoursSinceEnd < 24) {
        return {
          allowed: false,
          reason: 'User ended conversation recently'
        }
      }
    }

    // Check message count threshold
    const maxMessagesPerSession = bot.settings?.maxMessagesPerSession || 100

    if (session.messageCount >= maxMessagesPerSession) {
      return {
        allowed: false,
        reason: `Session message limit reached (${maxMessagesPerSession})`
      }
    }

    return {
      allowed: true,
      reason: 'Conversation context OK'
    }
  }

  /**
   * Detect spam/abuse
   */
  private async detectSpam(
    bot: Bot,
    message: IncomingMessage
  ): Promise<{ allowed: boolean; reason: string }> {
    // 1. Check message length
    if (message.message.length > 5000) {
      return {
        allowed: false,
        reason: 'Message too long (possible spam)'
      }
    }

    // 2. Check for repeated messages
    const recentSessions = await this.payload.find({
      collection: 'sessions',
      where: {
        and: [
          { bot: { equals: bot.id } },
          { peer: { equals: message.peer.id } },
          {
            lastMessage: {
              greater_than: new Date(Date.now() - 5 * 60 * 1000).toISOString()
            }
          }
        ]
      }
    })

    if (recentSessions.docs.length > 0) {
      const session = recentSessions.docs[0]

      // Simple spam detection: same message repeated
      if (session.metadata?.lastUserMessage === message.message) {
        const repeatCount = (session.metadata?.repeatCount || 0) + 1

        if (repeatCount >= 3) {
          return {
            allowed: false,
            reason: 'Repeated message spam detected'
          }
        }

        // Update repeat count
        await this.payload.update({
          collection: 'sessions',
          id: session.id,
          data: {
            metadata: {
              ...session.metadata,
              repeatCount
            }
          }
        })
      } else {
        // Different message - reset repeat count
        await this.payload.update({
          collection: 'sessions',
          id: session.id,
          data: {
            metadata: {
              ...session.metadata,
              lastUserMessage: message.message,
              repeatCount: 0
            }
          }
        })
      }
    }

    // 3. Check for suspicious patterns
    const suspiciousPatterns = [
      /viagra|cialis|pharmacy/i,
      /click here|download now/i,
      /prize|winner|congratulations.*won/i,
      /verify.*account|suspended.*account/i
    ]

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(message.message)) {
        return {
          allowed: false,
          reason: 'Suspicious content pattern detected'
        }
      }
    }

    return {
      allowed: true,
      reason: 'No spam detected'
    }
  }

  /**
   * Calculate message priority
   */
  private calculatePriority(message: IncomingMessage): 'low' | 'normal' | 'high' | 'urgent' {
    // Urgent keywords
    const urgentKeywords = [
      'urgent',
      'emergency',
      'critical',
      'asap',
      'immediately',
      'help!',
      'error',
      'broken',
      'down'
    ]

    // High priority keywords
    const highKeywords = ['important', 'issue', 'problem', 'bug', 'not working']

    const lowerMessage = message.message.toLowerCase()

    // Check for urgent
    if (urgentKeywords.some((keyword) => lowerMessage.includes(keyword))) {
      return 'urgent'
    }

    // Check for high
    if (highKeywords.some((keyword) => lowerMessage.includes(keyword))) {
      return 'high'
    }

    // Check for questions (usually higher priority)
    if (lowerMessage.includes('?') || lowerMessage.startsWith('how') || lowerMessage.startsWith('what') || lowerMessage.startsWith('why')) {
      return 'normal'
    }

    return 'low'
  }

  /**
   * Calculate suggested response delay
   *
   * Avoid appearing too robotic by adding natural delays
   */
  private calculateResponseDelay(
    priority: 'low' | 'normal' | 'high' | 'urgent',
    message: IncomingMessage
  ): number {
    // Base delays (milliseconds)
    const baseDelays = {
      urgent: 500, // 0.5 seconds
      high: 1500, // 1.5 seconds
      normal: 3000, // 3 seconds
      low: 5000 // 5 seconds
    }

    const baseDelay = baseDelays[priority]

    // Add jitter (±20% randomness for natural feel)
    const jitter = baseDelay * 0.2 * (Math.random() - 0.5)

    // Adjust based on message length (longer messages take longer to "read")
    const messageLength = message.message.length
    const readingTime = Math.min(messageLength * 20, 3000) // ~50 WPM reading speed, max 3s

    return Math.max(baseDelay + jitter + readingTime, 500)
  }

  /**
   * Suggest follow-up action
   */
  async suggestFollowUp(
    bot: Bot,
    message: IncomingMessage,
    responseDelivered: boolean
  ): Promise<{
    shouldFollowUp: boolean
    delay?: number
    message?: string
  }> {
    if (!bot.settings?.followUp?.enabled) {
      return { shouldFollowUp: false }
    }

    const followUpDelay = bot.settings.followUp.delayHours || 24

    // Only follow up if response was delivered
    if (!responseDelivered) {
      return { shouldFollowUp: false }
    }

    // Check if this is an appropriate conversation for follow-up
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1
    })

    if (sessions.docs.length === 0) {
      return { shouldFollowUp: false }
    }

    const session = sessions.docs[0]

    // Follow up if conversation was meaningful (5+ messages)
    if (session.messageCount >= 5) {
      return {
        shouldFollowUp: true,
        delay: followUpDelay * 60 * 60 * 1000,
        message:
          bot.settings.followUp.message ||
          'Hi! Just checking in - did my previous response help? Let me know if you need anything else!'
      }
    }

    return { shouldFollowUp: false }
  }

  /**
   * Check if user wants to end conversation
   */
  isConversationEnder(message: IncomingMessage): boolean {
    const enderPhrases = [
      'goodbye',
      'bye',
      'thanks',
      'thank you',
      'that\'s all',
      'stop',
      'quit',
      'done',
      'no more',
      'unsubscribe'
    ]

    const lowerMessage = message.message.toLowerCase().trim()

    return enderPhrases.some((phrase) => lowerMessage === phrase || lowerMessage.endsWith(phrase))
  }

  /**
   * Mark conversation as ended
   */
  async endConversation(bot: Bot, message: IncomingMessage): Promise<void> {
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1
    })

    if (sessions.docs.length > 0) {
      const session = sessions.docs[0]

      await this.payload.update({
        collection: 'sessions',
        id: session.id,
        data: {
          metadata: {
            ...session.metadata,
            ended: true,
            endedAt: new Date().toISOString(),
            endedBy: 'user'
          }
        }
      })

      this.payload.logger.info(`Conversation ended: ${sessionKey}`)
    }
  }
}

/**
 * Get AutoReplyEngine instance
 */
export function getAutoReplyEngine(payload: Payload): AutoReplyEngine {
  return new AutoReplyEngine(payload)
}
