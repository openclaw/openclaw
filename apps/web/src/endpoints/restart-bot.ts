import type { PayloadHandler } from 'payload'
import { getOrchestrator } from '../lib/gateway/orchestrator'
import { getConfigSync } from '../lib/gateway/config-sync'

/**
 * API endpoint to restart a bot gateway
 */
export const restartBot: PayloadHandler = async (req, res) => {
  const { botId } = req.body

  if (!botId) {
    return res.status(400).json({
      error: 'Bot ID is required'
    })
  }

  try {
    // Fetch bot from database
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({
        error: `Bot ${botId} not found`
      })
    }

    // Check permissions
    if (req.user?.role !== 'admin') {
      const userBots = req.user?.assignedBots || []
      if (!userBots.includes(botId)) {
        return res.status(403).json({
          error: 'You do not have permission to restart this bot'
        })
      }
    }

    // Sync config before restarting
    const configSync = getConfigSync(req.payload)
    const outputPath = `/var/openclaw/bots/${bot.agentId}/config.json5`
    await configSync.syncBotConfig(botId, outputPath)

    // Restart bot
    const orchestrator = getOrchestrator()
    await orchestrator.restartBot(bot)

    // Update bot status
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        status: 'active',
        lastSeen: new Date().toISOString(),
        errorMessage: null
      }
    })

    return res.status(200).json({
      success: true,
      message: `Bot ${bot.name} restarted successfully`,
      botId: bot.agentId,
      port: bot.gateway?.port
    })
  } catch (error) {
    req.payload.logger.error(`Failed to restart bot ${botId}: ${error}`)

    // Update bot status to error
    try {
      await req.payload.update({
        collection: 'bots',
        id: botId,
        data: {
          status: 'error',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      })
    } catch (updateError) {
      req.payload.logger.error(`Failed to update bot status: ${updateError}`)
    }

    return res.status(500).json({
      error: 'Failed to restart bot',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
