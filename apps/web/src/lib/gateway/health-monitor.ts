import { getOrchestrator } from './orchestrator'
import { getWebSocketServer } from '../realtime/hooks'
import { RealtimeEvents, RealtimeRooms } from '../realtime/websocket-server'
import type { Payload } from 'payload'

/**
 * Gateway Health Monitor
 *
 * Periodically checks if gateway processes marked as "active" in the database
 * are actually running. If a process crashed or was killed externally, this
 * service detects it and updates the database + broadcasts status change.
 *
 * This prevents the UI from showing "active" status for dead processes.
 */

export class GatewayHealthMonitor {
  private interval: NodeJS.Timeout | null = null
  private checkCount = 0

  constructor(
    private payload: Payload,
    private checkIntervalMs: number = 30000 // 30 seconds
  ) {}

  /**
   * Start periodic health checks
   */
  start(): void {
    this.payload.logger.info(
      `Starting gateway health monitor (interval: ${this.checkIntervalMs}ms)`
    )

    this.interval = setInterval(async () => {
      await this.checkAllBots()
    }, this.checkIntervalMs)

    // Run initial check after 5 seconds (give bots time to start)
    setTimeout(async () => {
      await this.checkAllBots()
    }, 5000)
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.payload.logger.info('Gateway health monitor stopped')
    }
  }

  /**
   * Check all bots marked as active
   */
  private async checkAllBots(): Promise<void> {
    this.checkCount++

    try {
      // Find all bots marked as active in database
      const activeBots = await this.payload.find({
        collection: 'bots',
        where: {
          status: {
            equals: 'active'
          }
        }
      })

      if (activeBots.docs.length === 0) {
        this.payload.logger.debug('Health check: No active bots')
        return
      }

      this.payload.logger.debug(
        `Health check #${this.checkCount}: Checking ${activeBots.docs.length} bots`
      )

      const orchestrator = getOrchestrator()
      let healthyCount = 0
      let unhealthyCount = 0

      for (const bot of activeBots.docs) {
        const isHealthy = await this.checkBotHealth(bot, orchestrator)
        if (isHealthy) {
          healthyCount++
        } else {
          unhealthyCount++
        }
      }

      if (unhealthyCount > 0) {
        this.payload.logger.warn(
          `Health check complete: ${healthyCount} healthy, ${unhealthyCount} unhealthy`
        )
      } else {
        this.payload.logger.debug(
          `Health check complete: ${healthyCount} healthy`
        )
      }
    } catch (error) {
      this.payload.logger.error(`Health check failed: ${error}`)
    }
  }

  /**
   * Check health of a single bot
   */
  private async checkBotHealth(
    bot: any,
    orchestrator: ReturnType<typeof getOrchestrator>
  ): Promise<boolean> {
    const processStatus = orchestrator.getStatus(bot.agentId)

    // Bot marked active but process not running or not in running state
    if (!processStatus || processStatus.status !== 'running') {
      this.payload.logger.warn(
        `Bot ${bot.agentId} (ID: ${bot.id}) marked active but process is ${processStatus?.status || 'not found'}`
      )

      // Update database to reflect actual status
      await this.markBotUnhealthy(bot, processStatus)

      return false
    }

    // Additional health check: verify process is still alive
    try {
      // Send signal 0 to check if process exists (doesn't actually send a signal)
      process.kill(processStatus.pid, 0)

      // Process exists and is running
      return true
    } catch (error) {
      // Process doesn't exist
      this.payload.logger.warn(
        `Bot ${bot.agentId} process (PID: ${processStatus.pid}) not found`
      )

      await this.markBotUnhealthy(bot, processStatus)

      return false
    }
  }

  /**
   * Mark bot as unhealthy and broadcast status change
   */
  private async markBotUnhealthy(
    bot: any,
    processStatus: any
  ): Promise<void> {
    try {
      // Update database
      await this.payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'error',
          errorMessage: processStatus
            ? `Gateway process in ${processStatus.status} state`
            : 'Gateway process unexpectedly stopped',
          'gateway.processId': null
        }
      })

      this.payload.logger.info(
        `Updated bot ${bot.agentId} status to error in database`
      )

      // Broadcast status change via WebSocket
      const ws = getWebSocketServer()
      if (ws) {
        ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
          type: 'bot',
          event: RealtimeEvents.BOT_ERROR,
          data: {
            botId: bot.id,
            agentId: bot.agentId,
            name: bot.name,
            error: 'Gateway process health check failed',
            detectedBy: 'health-monitor'
          },
          timestamp: Date.now()
        })

        // Notify bot owner
        const userId = typeof bot.user === 'string' ? bot.user : bot.user?.id

        if (userId) {
          ws.broadcastToUser(userId, {
            type: 'bot',
            event: RealtimeEvents.BOT_ERROR,
            data: {
              botId: bot.id,
              agentId: bot.agentId,
              name: bot.name,
              error: 'Bot unexpectedly stopped. Please restart.'
            },
            timestamp: Date.now()
          })
        }
      }
    } catch (error) {
      this.payload.logger.error(
        `Failed to mark bot ${bot.agentId} as unhealthy: ${error}`
      )
    }
  }

  /**
   * Get health monitor stats
   */
  getStats(): {
    enabled: boolean
    checkIntervalMs: number
    totalChecks: number
  } {
    return {
      enabled: this.interval !== null,
      checkIntervalMs: this.checkIntervalMs,
      totalChecks: this.checkCount
    }
  }
}
