import type { PayloadHandler } from 'payload'
import { getOrchestrator } from '../lib/gateway/orchestrator'

/**
 * API endpoint to get bot gateway status
 */
export const botStatus: PayloadHandler = async (req, res) => {
  const { botId } = req.query

  try {
    const orchestrator = getOrchestrator()

    if (botId && typeof botId === 'string') {
      // Get status for specific bot
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
            error: 'You do not have permission to view this bot'
          })
        }
      }

      const status = orchestrator.getStatus(bot.agentId)

      return res.status(200).json({
        botId: bot.agentId,
        name: bot.name,
        status: status
          ? {
              running: true,
              pid: status.pid,
              port: status.port,
              status: status.status,
              uptime: Date.now() - status.startTime.getTime(),
              errorMessage: status.errorMessage
            }
          : {
              running: false
            }
      })
    }

    // Get status for all bots
    const processes = orchestrator.getAllProcesses()

    return res.status(200).json({
      processes: processes.map((proc) => ({
        botId: proc.botId,
        pid: proc.pid,
        port: proc.port,
        status: proc.status,
        uptime: Date.now() - proc.startTime.getTime(),
        errorMessage: proc.errorMessage
      }))
    })
  } catch (error) {
    req.payload.logger.error(`Failed to get bot status: ${error}`)

    return res.status(500).json({
      error: 'Failed to get bot status',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
