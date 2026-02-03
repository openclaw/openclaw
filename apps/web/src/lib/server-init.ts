import { ClawNetWebSocketServer } from './realtime/websocket-server'
import { setWebSocketServer } from './realtime/hooks'
import { bridgeGatewayEvents } from './gateway/gateway-events-bridge'
import { GatewayHealthMonitor } from './gateway/health-monitor'
import { SessionSyncService } from './gateway/session-sync'
import { getProactiveActionsEngine } from './automation/proactive-actions'
import type { Payload } from 'payload'
import type { Server } from 'http'

/**
 * Server Initialization Module
 *
 * Initializes all integration services:
 * - WebSocket server for real-time updates
 * - Gateway event bridge (gateway ↔ WebSocket ↔ database)
 * - Session sync (gateway sessions → database)
 * - Health monitoring (detect crashed processes)
 * - Proactive actions (scheduled tasks, monitoring, follow-ups)
 */

// Singleton instances
let wsServer: ClawNetWebSocketServer | null = null
let healthMonitor: GatewayHealthMonitor | null = null
let sessionSync: SessionSyncService | null = null
let proactiveActions: ReturnType<typeof getProactiveActionsEngine> | null = null

/**
 * Initialize all ClawNet services
 */
export async function initializeClawNetServices(
  payload: Payload,
  httpServer: Server
): Promise<void> {
  payload.logger.info('Initializing ClawNet services...')

  try {
    // 1. Initialize WebSocket server
    wsServer = new ClawNetWebSocketServer(payload, httpServer)
    setWebSocketServer(wsServer)
    payload.logger.info('✓ WebSocket server initialized on /ws')

    // 2. Bridge gateway events to WebSocket and database
    bridgeGatewayEvents(payload)
    payload.logger.info('✓ Gateway events bridged')

    // 3. Initialize session sync service
    sessionSync = new SessionSyncService(payload)
    payload.logger.info('✓ Session sync service initialized')

    // 4. Start health monitor
    healthMonitor = new GatewayHealthMonitor(payload, 30000) // 30 second checks
    healthMonitor.start()
    payload.logger.info('✓ Health monitor started')

    // 5. Initialize proactive actions engine
    proactiveActions = getProactiveActionsEngine(payload)
    payload.logger.info('✓ Proactive actions engine initialized')

    // 6. Auto-start bots marked as active
    await autoStartActiveBots(payload)

    payload.logger.info('✅ All ClawNet services initialized successfully')
  } catch (error) {
    payload.logger.error(`Failed to initialize ClawNet services: ${error}`)
    throw error
  }
}

/**
 * Auto-start bots that were active when server shut down
 */
async function autoStartActiveBots(payload: Payload): Promise<void> {
  try {
    const activeBots = await payload.find({
      collection: 'bots',
      where: {
        status: {
          equals: 'active'
        }
      }
    })

    if (activeBots.docs.length === 0) {
      payload.logger.info('No active bots to auto-start')
      return
    }

    payload.logger.info(`Auto-starting ${activeBots.docs.length} active bots...`)

    const { getOrchestrator } = await import('./gateway/orchestrator')
    const orchestrator = getOrchestrator()

    for (const bot of activeBots.docs) {
      try {
        await orchestrator.startBot(bot)
        payload.logger.info(`✓ Auto-started bot: ${bot.agentId}`)

        // Start watching sessions for this bot
        if (sessionSync) {
          await sessionSync.watchBotSessions(bot.id, bot.agentId)
        }

        // Initialize proactive actions for this bot
        if (proactiveActions) {
          await proactiveActions.initializeBotActions(bot)
        }
      } catch (error) {
        payload.logger.error(
          `Failed to auto-start bot ${bot.agentId}: ${error}`
        )

        // Mark as error in database
        await payload.update({
          collection: 'bots',
          id: bot.id,
          data: {
            status: 'error',
            errorMessage: `Auto-start failed: ${error instanceof Error ? error.message : String(error)}`
          }
        })
      }
    }
  } catch (error) {
    payload.logger.error(`Failed to auto-start bots: ${error}`)
  }
}

/**
 * Graceful shutdown
 */
export async function shutdownClawNetServices(payload: Payload): Promise<void> {
  payload.logger.info('Shutting down ClawNet services...')

  try {
    // 1. Stop proactive actions
    if (proactiveActions) {
      // Stop all scheduled tasks
      const activeBots = await payload.find({
        collection: 'bots',
        where: { status: { equals: 'active' } }
      })

      for (const bot of activeBots.docs) {
        proactiveActions.stopBotActions(bot.id)
      }
      payload.logger.info('✓ Proactive actions stopped')
    }

    // 2. Stop health monitor
    if (healthMonitor) {
      healthMonitor.stop()
      payload.logger.info('✓ Health monitor stopped')
    }

    // 3. Stop session sync watchers
    if (sessionSync) {
      sessionSync.stopAllWatchers()
      payload.logger.info('✓ Session sync stopped')
    }

    // 4. Stop all gateway processes
    const { getOrchestrator } = await import('./gateway/orchestrator')
    const orchestrator = getOrchestrator()
    await orchestrator.stopAll()
    payload.logger.info('✓ All gateway processes stopped')

    // 5. Shutdown WebSocket server
    if (wsServer) {
      await wsServer.shutdown()
      payload.logger.info('✓ WebSocket server shut down')
    }

    payload.logger.info('✅ All ClawNet services shut down successfully')
  } catch (error) {
    payload.logger.error(`Error during shutdown: ${error}`)
  }
}

/**
 * Get WebSocket server instance
 */
export function getWebSocketServerInstance(): ClawNetWebSocketServer | null {
  return wsServer
}

/**
 * Get session sync service instance
 */
export function getSessionSyncInstance(): SessionSyncService | null {
  return sessionSync
}

/**
 * Get proactive actions engine instance
 */
export function getProactiveActionsInstance(): ReturnType<
  typeof getProactiveActionsEngine
> | null {
  return proactiveActions
}
