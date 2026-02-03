import type { Payload } from 'payload'
import type { Bot } from '@/payload-types'
import { getBotAutoPoster } from '../bot-social/auto-poster'
import { getResponseDeliveryService } from '../message-routing/delivery'

/**
 * Proactive Actions Engine
 *
 * Enables bots to take autonomous actions without user prompts:
 * - Scheduled content creation
 * - Monitoring and alerts
 * - Follow-up messages
 * - Daily summaries
 * - Automated workflows
 */

export interface ProactiveTask {
  id: string
  botId: string
  type: 'content' | 'monitoring' | 'followup' | 'summary' | 'custom'
  schedule: {
    type: 'interval' | 'cron' | 'once'
    value: string | number
  }
  config: Record<string, any>
  enabled: boolean
}

export class ProactiveActionsEngine {
  private tasks: Map<string, NodeJS.Timeout> = new Map()
  private intervals: Map<string, NodeJS.Timeout> = new Map()

  constructor(private payload: Payload) {}

  /**
   * Initialize proactive actions for a bot
   */
  async initializeBotActions(bot: Bot): Promise<void> {
    this.payload.logger.info(`Initializing proactive actions for bot ${bot.agentId}`)

    // 1. Content creation (for content creator bots)
    if (bot.agentType === 'content_creator' && bot.settings?.contentCreation?.enabled) {
      await this.scheduleContentCreation(bot)
    }

    // 2. Monitoring checks
    if (bot.agentType === 'monitoring' || bot.settings?.monitoring?.enabled) {
      await this.scheduleMonitoring(bot)
    }

    // 3. Daily summaries
    if (bot.settings?.dailySummary?.enabled) {
      await this.scheduleDailySummary(bot)
    }

    // 4. Follow-up messages
    if (bot.settings?.followUp?.enabled) {
      await this.scheduleFollowUps(bot)
    }

    // 5. Custom scheduled tasks
    const customTasks = bot.settings?.customTasks || []
    for (const task of customTasks) {
      if (task.enabled) {
        await this.scheduleCustomTask(bot, task)
      }
    }

    this.payload.logger.info(
      `Initialized ${this.tasks.size} proactive tasks for bot ${bot.agentId}`
    )
  }

  /**
   * Stop all proactive actions for a bot
   */
  stopBotActions(botId: string): void {
    const taskKeys = Array.from(this.tasks.keys()).filter((key) =>
      key.startsWith(`${botId}:`)
    )

    for (const key of taskKeys) {
      const task = this.tasks.get(key)
      if (task) {
        clearInterval(task)
        this.tasks.delete(key)
      }
    }

    this.payload.logger.info(`Stopped ${taskKeys.length} proactive tasks for bot ${botId}`)
  }

  /**
   * Schedule content creation
   */
  private async scheduleContentCreation(bot: Bot): Promise<void> {
    const settings = bot.settings?.contentCreation
    if (!settings) return

    const intervalMs = (settings.intervalHours || 24) * 60 * 60 * 1000

    const taskId = setInterval(async () => {
      try {
        this.payload.logger.info(`Running content creation for bot ${bot.agentId}`)

        // Generate content via gateway
        const content = await this.generateContentViaGateway(bot, settings.prompt)

        if (!content) {
          this.payload.logger.warn(`No content generated for bot ${bot.agentId}`)
          return
        }

        // Post to social feed
        const poster = getBotAutoPoster(this.payload)
        await poster.createBotPost({
          botId: bot.id,
          content,
          visibility: settings.visibility || 'public'
        })

        this.payload.logger.info(`Bot ${bot.agentId} posted scheduled content`)

        // Update bot metrics
        await this.payload.update({
          collection: 'bots',
          id: bot.id,
          data: {
            'metrics.scheduledPostsCount':
              (bot.metrics?.scheduledPostsCount || 0) + 1
          }
        })
      } catch (error) {
        this.payload.logger.error(
          `Content creation failed for bot ${bot.agentId}: ${error}`
        )
      }
    }, intervalMs)

    this.tasks.set(`${bot.id}:content-creation`, taskId)
    this.payload.logger.info(
      `Scheduled content creation every ${settings.intervalHours}h for bot ${bot.agentId}`
    )
  }

  /**
   * Schedule monitoring checks
   */
  private async scheduleMonitoring(bot: Bot): Promise<void> {
    const settings = bot.settings?.monitoring
    if (!settings?.checks || settings.checks.length === 0) return

    for (const check of settings.checks) {
      if (!check.enabled) continue

      const intervalMs = check.intervalMinutes * 60 * 1000

      const taskId = setInterval(async () => {
        try {
          this.payload.logger.debug(
            `Running monitoring check "${check.name}" for bot ${bot.agentId}`
          )

          const result = await this.executeMonitoringCheck(bot, check)

          // If alert condition met, send notifications
          if (result.shouldAlert) {
            await this.sendMonitoringAlert(bot, check, result)
          }

          // Update check history
          await this.updateMonitoringHistory(bot, check, result)
        } catch (error) {
          this.payload.logger.error(
            `Monitoring check "${check.name}" failed for bot ${bot.agentId}: ${error}`
          )
        }
      }, intervalMs)

      this.tasks.set(`${bot.id}:monitoring:${check.id}`, taskId)
      this.payload.logger.info(
        `Scheduled monitoring check "${check.name}" every ${check.intervalMinutes}m for bot ${bot.agentId}`
      )
    }
  }

  /**
   * Schedule daily summary
   */
  private async scheduleDailySummary(bot: Bot): Promise<void> {
    const settings = bot.settings?.dailySummary
    if (!settings) return

    // Parse time (e.g., "18:00" for 6 PM)
    const [hour, minute] = (settings.time || '18:00').split(':').map(Number)

    // Calculate next execution time
    const now = new Date()
    const nextExecution = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0
    )

    if (nextExecution <= now) {
      // If time has passed today, schedule for tomorrow
      nextExecution.setDate(nextExecution.getDate() + 1)
    }

    const delay = nextExecution.getTime() - now.getTime()

    // Schedule first execution
    setTimeout(async () => {
      await this.sendDailySummary(bot)

      // Then schedule daily repeats
      const intervalId = setInterval(
        async () => {
          await this.sendDailySummary(bot)
        },
        24 * 60 * 60 * 1000
      ) // 24 hours

      this.intervals.set(`${bot.id}:daily-summary`, intervalId)
    }, delay)

    this.payload.logger.info(
      `Scheduled daily summary at ${settings.time} for bot ${bot.agentId}`
    )
  }

  /**
   * Schedule follow-ups
   */
  private async scheduleFollowUps(bot: Bot): Promise<void> {
    const settings = bot.settings?.followUp
    if (!settings) return

    // Check for conversations that need follow-up every hour
    const checkInterval = 60 * 60 * 1000 // 1 hour

    const taskId = setInterval(async () => {
      try {
        const followUpDelay = (settings.delayHours || 24) * 60 * 60 * 1000

        // Find sessions that need follow-up
        const sessions = await this.payload.find({
          collection: 'sessions',
          where: {
            and: [
              { bot: { equals: bot.id } },
              {
                lastMessage: {
                  greater_than: new Date(Date.now() - followUpDelay - checkInterval).toISOString(),
                  less_than: new Date(Date.now() - followUpDelay).toISOString()
                }
              },
              { messageCount: { greater_than: 4 } }
            ]
          }
        })

        for (const session of sessions.docs) {
          // Check if follow-up already sent
          if (session.metadata?.followUpSent) continue

          // Send follow-up
          await this.sendFollowUpMessage(bot, session, settings.message)

          // Mark as sent
          await this.payload.update({
            collection: 'sessions',
            id: session.id,
            data: {
              metadata: {
                ...session.metadata,
                followUpSent: true,
                followUpSentAt: new Date().toISOString()
              }
            }
          })
        }
      } catch (error) {
        this.payload.logger.error(`Follow-up check failed for bot ${bot.agentId}: ${error}`)
      }
    }, checkInterval)

    this.tasks.set(`${bot.id}:followups`, taskId)
    this.payload.logger.info(
      `Scheduled follow-up checks every 1h for bot ${bot.agentId}`
    )
  }

  /**
   * Schedule custom task
   */
  private async scheduleCustomTask(bot: Bot, task: any): Promise<void> {
    if (task.schedule.type === 'interval') {
      const intervalMs = task.schedule.value as number

      const taskId = setInterval(async () => {
        try {
          await this.executeCustomTask(bot, task)
        } catch (error) {
          this.payload.logger.error(
            `Custom task "${task.name}" failed for bot ${bot.agentId}: ${error}`
          )
        }
      }, intervalMs)

      this.tasks.set(`${bot.id}:custom:${task.id}`, taskId)
      this.payload.logger.info(
        `Scheduled custom task "${task.name}" for bot ${bot.agentId}`
      )
    }
    // TODO: Support cron and once schedules
  }

  /**
   * Generate content via gateway
   */
  private async generateContentViaGateway(
    bot: Bot,
    prompt?: string
  ): Promise<string | null> {
    try {
      const gatewayUrl = `http://localhost:${bot.gateway?.port}`

      const response = await fetch(`${gatewayUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bot.gateway?.authToken || 'dev-token'}`
        },
        body: JSON.stringify({
          prompt:
            prompt ||
            'Generate an insightful, engaging post about AI and technology. Keep it under 500 characters.'
        }),
        signal: AbortSignal.timeout(30000) // 30 second timeout
      })

      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`)
      }

      const data = await response.json()
      return data.content || null
    } catch (error) {
      this.payload.logger.error(`Failed to generate content via gateway: ${error}`)
      return null
    }
  }

  /**
   * Execute monitoring check
   */
  private async executeMonitoringCheck(
    bot: Bot,
    check: any
  ): Promise<{ success: boolean; value?: any; shouldAlert: boolean; message?: string }> {
    try {
      // Execute check via gateway
      const gatewayUrl = `http://localhost:${bot.gateway?.port}`

      const response = await fetch(`${gatewayUrl}/api/execute-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bot.gateway?.authToken || 'dev-token'}`
        },
        body: JSON.stringify({
          check
        }),
        signal: AbortSignal.timeout(60000) // 60 second timeout
      })

      const result = await response.json()

      // Evaluate alert conditions
      const shouldAlert = this.evaluateAlertCondition(check, result)

      return {
        success: true,
        value: result.value,
        shouldAlert,
        message: result.message
      }
    } catch (error) {
      return {
        success: false,
        shouldAlert: true, // Alert on check failures
        message: `Check failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * Evaluate alert condition
   */
  private evaluateAlertCondition(check: any, result: any): boolean {
    if (!check.alertCondition) return false

    const { operator, threshold } = check.alertCondition

    switch (operator) {
      case 'greater_than':
        return result.value > threshold
      case 'less_than':
        return result.value < threshold
      case 'equals':
        return result.value === threshold
      case 'not_equals':
        return result.value !== threshold
      default:
        return false
    }
  }

  /**
   * Send monitoring alert
   */
  private async sendMonitoringAlert(bot: Bot, check: any, result: any): Promise<void> {
    // Send to configured channels
    const alertChannels = check.alertChannels || []

    for (const channelConfig of alertChannels) {
      try {
        const delivery = getResponseDeliveryService(this.payload)

        await delivery.deliverResponse(bot, {
          channel: channelConfig.channel,
          peer: channelConfig.peer,
          message: `🚨 Alert: ${check.name}\n\n${result.message || 'Threshold exceeded'}\n\nValue: ${result.value}\nThreshold: ${check.alertCondition.threshold}`
        })
      } catch (error) {
        this.payload.logger.error(`Failed to send monitoring alert: ${error}`)
      }
    }
  }

  /**
   * Update monitoring history
   */
  private async updateMonitoringHistory(
    bot: Bot,
    check: any,
    result: any
  ): Promise<void> {
    // Store check results in bot metadata
    const history = bot.metadata?.monitoringHistory || {}

    if (!history[check.id]) {
      history[check.id] = []
    }

    history[check.id].push({
      timestamp: new Date().toISOString(),
      success: result.success,
      value: result.value,
      alerted: result.shouldAlert
    })

    // Keep last 100 results
    if (history[check.id].length > 100) {
      history[check.id] = history[check.id].slice(-100)
    }

    await this.payload.update({
      collection: 'bots',
      id: bot.id,
      data: {
        metadata: {
          ...bot.metadata,
          monitoringHistory: history
        }
      }
    })
  }

  /**
   * Send daily summary
   */
  private async sendDailySummary(bot: Bot): Promise<void> {
    try {
      this.payload.logger.info(`Sending daily summary for bot ${bot.agentId}`)

      // Get yesterday's stats
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(0, 0, 0, 0)

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const sessions = await this.payload.find({
        collection: 'sessions',
        where: {
          and: [
            { bot: { equals: bot.id } },
            { lastMessage: { greater_than: yesterday.toISOString() } },
            { lastMessage: { less_than: today.toISOString() } }
          ]
        }
      })

      const totalMessages = sessions.docs.reduce(
        (sum, s) => sum + (s.messageCount || 0),
        0
      )
      const totalConversations = sessions.docs.length

      const summary = `📊 Daily Summary (${yesterday.toLocaleDateString()})\n\n` +
        `💬 Conversations: ${totalConversations}\n` +
        `📝 Messages: ${totalMessages}\n` +
        `⚡ Avg messages/conversation: ${totalConversations > 0 ? Math.round(totalMessages / totalConversations) : 0}\n\n` +
        `Status: ${bot.status}\n` +
        `Uptime: Active`

      // Post to social feed if enabled
      if (bot.settings?.dailySummary?.postToFeed) {
        const poster = getBotAutoPoster(this.payload)
        await poster.createBotPost({
          botId: bot.id,
          content: summary,
          visibility: 'public'
        })
      }

      // Send to configured channels
      if (bot.settings?.dailySummary?.sendToChannels) {
        const channels = bot.settings.dailySummary.sendToChannels

        for (const channelConfig of channels) {
          const delivery = getResponseDeliveryService(this.payload)

          await delivery.deliverResponse(bot, {
            channel: channelConfig.channel,
            peer: channelConfig.peer,
            message: summary
          })
        }
      }

      this.payload.logger.info(`Daily summary sent for bot ${bot.agentId}`)
    } catch (error) {
      this.payload.logger.error(`Failed to send daily summary: ${error}`)
    }
  }

  /**
   * Send follow-up message
   */
  private async sendFollowUpMessage(
    bot: Bot,
    session: any,
    message?: string
  ): Promise<void> {
    try {
      const defaultMessage =
        'Hi! Just checking in - did my previous response help? Let me know if you need anything else!'

      const delivery = getResponseDeliveryService(this.payload)

      await delivery.deliverResponse(bot, {
        channel: session.channel,
        peer: { kind: 'user', id: session.peer },
        message: message || defaultMessage
      })

      this.payload.logger.info(`Follow-up sent for session ${session.sessionKey}`)
    } catch (error) {
      this.payload.logger.error(`Failed to send follow-up: ${error}`)
    }
  }

  /**
   * Execute custom task
   */
  private async executeCustomTask(bot: Bot, task: any): Promise<void> {
    this.payload.logger.info(`Executing custom task "${task.name}" for bot ${bot.agentId}`)

    // Custom task execution logic
    // This can be extended based on task.type and task.config
  }

  /**
   * Get stats
   */
  getStats(botId?: string): {
    totalTasks: number
    activeTasks: number
    tasksByBot: Record<string, number>
  } {
    const tasks = Array.from(this.tasks.keys())

    if (botId) {
      const botTasks = tasks.filter((key) => key.startsWith(`${botId}:`))
      return {
        totalTasks: botTasks.length,
        activeTasks: botTasks.length,
        tasksByBot: { [botId]: botTasks.length }
      }
    }

    const tasksByBot: Record<string, number> = {}
    for (const key of tasks) {
      const botId = key.split(':')[0]
      tasksByBot[botId] = (tasksByBot[botId] || 0) + 1
    }

    return {
      totalTasks: tasks.length,
      activeTasks: tasks.length,
      tasksByBot
    }
  }
}

/**
 * Get ProactiveActionsEngine instance (singleton)
 */
let instance: ProactiveActionsEngine | null = null

export function getProactiveActionsEngine(payload: Payload): ProactiveActionsEngine {
  if (!instance) {
    instance = new ProactiveActionsEngine(payload)
  }
  return instance
}
