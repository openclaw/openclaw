import type { PayloadHandler } from 'payload'
import { getResponseDeliveryService } from '../../lib/message-routing/delivery'
import { getAutoReplyEngine } from '../../lib/automation/auto-reply-engine'
import type { OutgoingMessage } from '../../lib/message-routing/delivery'

/**
 * Gateway Response Delivery Endpoint
 *
 * Called by OpenClaw gateway processes to deliver bot responses back to users.
 *
 * This is the critical link between:
 * - OpenClaw gateway (generates AI responses)
 * - Payload CMS (routes to channels)
 * - Channel platforms (Telegram, Discord, etc.)
 *
 * Flow:
 * 1. User sends message → Webhook → Router → Gateway
 * 2. Gateway processes with Claude AI
 * 3. Gateway calls THIS endpoint with response
 * 4. Response delivered to channel platform
 */

export const deliverResponse: PayloadHandler = async (req, res) => {
  try {
    const { botId, agentId, channel, peer, message, parseMode, media, replyTo, buttons } =
      req.body

    // Validate required fields
    if (!botId && !agentId) {
      return res.status(400).json({
        error: 'Bot ID or Agent ID required'
      })
    }

    if (!channel || !peer || !message) {
      return res.status(400).json({
        error: 'Channel, peer, and message are required'
      })
    }

    // Get bot
    let bot
    if (botId) {
      bot = await req.payload.findByID({
        collection: 'bots',
        id: botId
      })
    } else {
      // Find by agentId
      const bots = await req.payload.find({
        collection: 'bots',
        where: {
          agentId: { equals: agentId }
        },
        limit: 1
      })

      if (bots.docs.length === 0) {
        return res.status(404).json({
          error: `Bot not found: ${agentId}`
        })
      }

      bot = bots.docs[0]
    }

    if (!bot) {
      return res.status(404).json({
        error: 'Bot not found'
      })
    }

    // Build outgoing message
    const outgoingMessage: OutgoingMessage = {
      channel,
      peer,
      message,
      parseMode: parseMode || 'markdown',
      media,
      replyTo,
      buttons
    }

    // Deliver response
    const delivery = getResponseDeliveryService(req.payload)
    const result = await delivery.deliverWithRetry(bot, outgoingMessage, 3)

    if (!result.delivered) {
      req.payload.logger.error(
        `Failed to deliver response from bot ${bot.agentId}: ${result.error}`
      )

      return res.status(500).json({
        error: 'Failed to deliver response',
        details: result.error,
        retries: result.retries
      })
    }

    // Track delivery
    await trackDelivery(req.payload, bot, outgoingMessage, result)

    // Check if follow-up should be scheduled
    const autoReply = getAutoReplyEngine(req.payload)
    const followUp = await autoReply.suggestFollowUp(
      bot,
      {
        channel,
        peer,
        message
      } as any,
      result.delivered
    )

    if (followUp.shouldFollowUp) {
      await scheduleFollowUp(req.payload, bot, peer, followUp)
    }

    req.payload.logger.info(
      `Response delivered from bot ${bot.agentId} to ${channel}:${peer.id}`
    )

    res.json({
      success: true,
      delivered: true,
      messageId: result.messageId,
      channel,
      peer
    })
  } catch (error) {
    req.payload.logger.error(`Deliver response error: ${error}`)

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Track message delivery
 */
async function trackDelivery(
  payload: any,
  bot: any,
  message: OutgoingMessage,
  result: any
): Promise<void> {
  try {
    // Update bot metrics
    await payload.update({
      collection: 'bots',
      id: bot.id,
      data: {
        'metrics.messagesSent': (bot.metrics?.messagesSent || 0) + 1,
        'metrics.lastMessageSent': new Date().toISOString()
      }
    })

    // Update session
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    const sessions = await payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1
    })

    if (sessions.docs.length > 0) {
      const session = sessions.docs[0]

      await payload.update({
        collection: 'sessions',
        id: session.id,
        data: {
          messageCount: (session.messageCount || 0) + 1,
          lastMessage: new Date().toISOString(),
          metadata: {
            ...session.metadata,
            lastBotResponse: message.message.substring(0, 200),
            lastDeliverySuccess: result.delivered,
            lastDeliveryMessageId: result.messageId
          }
        }
      })
    }
  } catch (error) {
    payload.logger.error(`Failed to track delivery: ${error}`)
  }
}

/**
 * Schedule follow-up message
 */
async function scheduleFollowUp(
  payload: any,
  bot: any,
  peer: any,
  followUp: any
): Promise<void> {
  // This would integrate with a job queue system
  // For now, log the intention
  payload.logger.info(
    `Follow-up scheduled for bot ${bot.agentId} to ${peer.id} in ${followUp.delay}ms`
  )

  // TODO: Integrate with job queue (Bull, BullMQ, etc.)
  // await jobQueue.add('send-followup', {
  //   botId: bot.id,
  //   peer,
  //   message: followUp.message
  // }, {
  //   delay: followUp.delay
  // })
}
