import { getOrchestrator } from './orchestrator'
import { getWebSocketServer } from '../realtime/hooks'
import { RealtimeEvents, RealtimeRooms } from '../realtime/websocket-server'
import type { Payload } from 'payload'

/**
 * Gateway Events Bridge
 *
 * Connects GatewayOrchestrator events to:
 * 1. Payload CMS database (update bot status)
 * 2. WebSocket server (broadcast real-time updates)
 *
 * This ensures the entire system stays in sync when gateway processes
 * start, stop, or encounter errors.
 */

export function bridgeGatewayEvents(payload: Payload): void {
  const orchestrator = getOrchestrator()
  const ws = getWebSocketServer()

  if (!ws) {
    payload.logger.warn(
      'WebSocket server not initialized, gateway events will not be broadcasted'
    )
  }

  /**
   * Bot Started Event
   *
   * Triggered when gateway process successfully starts
   */
  orchestrator.on('started', async ({ botId, port, pid }) => {
    try {
      payload.logger.info(`Gateway started: ${botId} (PID: ${pid}, Port: ${port})`)

      // Find bot in database by agentId
      const bots = await payload.find({
        collection: 'bots',
        where: {
          agentId: {
            equals: botId
          }
        }
      })

      if (bots.docs.length === 0) {
        payload.logger.warn(`Bot ${botId} not found in database`)
        return
      }

      const bot = bots.docs[0]

      // Update database
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'active',
          'gateway.processId': pid,
          lastSeen: new Date().toISOString(),
          errorMessage: null // Clear any previous errors
        }
      })

      payload.logger.info(`Updated bot ${botId} status to active in database`)

      // Broadcast via WebSocket
      if (ws) {
        // Broadcast to bot-specific room
        ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
          type: 'bot',
          event: RealtimeEvents.BOT_STARTED,
          data: {
            botId: bot.id,
            agentId: botId,
            name: bot.name,
            port,
            pid,
            status: 'active'
          },
          timestamp: Date.now()
        })

        // Notify bot owner
        const userId = typeof bot.user === 'string' ? bot.user : bot.user?.id

        if (userId) {
          ws.broadcastToUser(userId, {
            type: 'bot',
            event: RealtimeEvents.BOT_STARTED,
            data: {
              botId: bot.id,
              agentId: botId,
              name: bot.name,
              status: 'active'
            },
            timestamp: Date.now()
          })
        }

        payload.logger.info(`Broadcasted bot started event for ${botId}`)
      }
    } catch (error) {
      payload.logger.error(
        `Failed to handle bot started event for ${botId}: ${error}`
      )
    }
  })

  /**
   * Bot Stopped Event
   *
   * Triggered when gateway process exits (graceful or crash)
   */
  orchestrator.on('stopped', async ({ botId, code, signal }) => {
    try {
      payload.logger.info(
        `Gateway stopped: ${botId} (Code: ${code}, Signal: ${signal})`
      )

      // Find bot in database
      const bots = await payload.find({
        collection: 'bots',
        where: {
          agentId: {
            equals: botId
          }
        }
      })

      if (bots.docs.length === 0) {
        payload.logger.warn(`Bot ${botId} not found in database`)
        return
      }

      const bot = bots.docs[0]

      // Determine if this was an expected stop or a crash
      const wasExpected = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT'
      const newStatus = wasExpected ? 'inactive' : 'error'
      const errorMsg = wasExpected
        ? null
        : `Process exited unexpectedly (code: ${code}, signal: ${signal})`

      // Update database
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: newStatus,
          'gateway.processId': null,
          errorMessage: errorMsg
        }
      })

      payload.logger.info(`Updated bot ${botId} status to ${newStatus} in database`)

      // Broadcast via WebSocket
      if (ws) {
        const event = wasExpected
          ? RealtimeEvents.BOT_STOPPED
          : RealtimeEvents.BOT_ERROR

        ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
          type: 'bot',
          event,
          data: {
            botId: bot.id,
            agentId: botId,
            name: bot.name,
            status: newStatus,
            code,
            signal,
            error: errorMsg
          },
          timestamp: Date.now()
        })

        // Notify bot owner
        const userId = typeof bot.user === 'string' ? bot.user : bot.user?.id

        if (userId) {
          ws.broadcastToUser(userId, {
            type: 'bot',
            event,
            data: {
              botId: bot.id,
              agentId: botId,
              name: bot.name,
              status: newStatus,
              error: errorMsg
            },
            timestamp: Date.now()
          })
        }

        payload.logger.info(`Broadcasted bot stopped event for ${botId}`)
      }
    } catch (error) {
      payload.logger.error(
        `Failed to handle bot stopped event for ${botId}: ${error}`
      )
    }
  })

  /**
   * Bot Error Event
   *
   * Triggered when gateway process encounters an error
   */
  orchestrator.on('error', async ({ botId, error }) => {
    try {
      payload.logger.error(`Gateway error: ${botId} - ${error.message}`)

      // Find bot in database
      const bots = await payload.find({
        collection: 'bots',
        where: {
          agentId: {
            equals: botId
          }
        }
      })

      if (bots.docs.length === 0) {
        payload.logger.warn(`Bot ${botId} not found in database`)
        return
      }

      const bot = bots.docs[0]

      // Update database
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'error',
          errorMessage: error.message
        }
      })

      payload.logger.info(`Updated bot ${botId} status to error in database`)

      // Broadcast via WebSocket
      if (ws) {
        ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
          type: 'bot',
          event: RealtimeEvents.BOT_ERROR,
          data: {
            botId: bot.id,
            agentId: botId,
            name: bot.name,
            error: error.message,
            stack: error.stack
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
              agentId: botId,
              name: bot.name,
              error: error.message
            },
            timestamp: Date.now()
          })
        }

        payload.logger.info(`Broadcasted bot error event for ${botId}`)
      }
    } catch (err) {
      payload.logger.error(
        `Failed to handle bot error event for ${botId}: ${err}`
      )
    }
  })

  /**
   * Bot Log Event
   *
   * Triggered when gateway process outputs to stdout/stderr
   * (Optional: Store logs in database or forward to logging service)
   */
  orchestrator.on('log', ({ botId, level, message }) => {
    // Forward to Payload logger
    if (level === 'error') {
      payload.logger.error(`[Gateway ${botId}] ${message}`)
    } else {
      payload.logger.info(`[Gateway ${botId}] ${message}`)
    }

    // Optional: Store in database or forward to external logging service
    // This can be useful for debugging and audit trails
  })

  payload.logger.info('Gateway events bridged to WebSocket server and database')
}
