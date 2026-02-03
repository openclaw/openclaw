import type { PayloadHandler } from 'payload'
import { getOrchestrator } from '../lib/gateway/orchestrator'

/**
 * API endpoint to stop a bot gateway
 */
export const stopBot: PayloadHandler = async (req, res) => {
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
          error: 'You do not have permission to stop this bot'
        })
      }
    }

    // Stop bot
    const orchestrator = getOrchestrator()
    await orchestrator.stopBot(bot.agentId)

    // Update bot status
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        status: 'inactive',
        errorMessage: null
      }
    })

    return res.status(200).json({
      success: true,
      message: `Bot ${bot.name} stopped successfully`,
      botId: bot.agentId
    })
  } catch (error) {
    req.payload.logger.error(`Failed to stop bot ${botId}: ${error}`)

    return res.status(500).json({
      error: 'Failed to stop bot',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
