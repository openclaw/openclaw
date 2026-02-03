import type { PayloadHandler } from 'payload'
import { getMessageRouter } from '../../lib/message-routing/router'
import type { IncomingMessage } from '../../lib/message-routing/router'

/**
 * Telegram Webhook Handler
 *
 * Receives updates from Telegram Bot API and routes them to the appropriate bot.
 *
 * Telegram sends updates in this format:
 * {
 *   update_id: number
 *   message?: {
 *     message_id: number
 *     from: { id: number, username?: string, first_name: string, ... }
 *     chat: { id: number, type: 'private'|'group'|'supergroup'|'channel', ... }
 *     text?: string
 *     photo?: [...], video?: {...}, ...
 *   }
 *   edited_message?: {...}
 *   callback_query?: {...}
 * }
 */

export const handleTelegramWebhook: PayloadHandler = async (req, res) => {
  try {
    const update = req.body

    if (!update || !update.update_id) {
      return res.status(400).json({
        error: 'Invalid update format'
      })
    }

    // Extract message (can be message, edited_message, channel_post, etc.)
    const message = update.message || update.edited_message || update.channel_post

    if (!message) {
      // Not a message update (could be callback_query, inline_query, etc.)
      // For now, we only handle message updates
      return res.status(200).json({ ok: true })
    }

    // Parse message into our format
    const incomingMessage: IncomingMessage = {
      channel: 'telegram',
      accountId: req.params.accountId || 'default',
      peer: {
        kind: message.chat.type === 'private' ? 'user' : 'group',
        id: String(message.chat.id),
        name: message.chat.title || message.chat.username
      },
      message: message.text || message.caption || '',
      messageId: String(message.message_id),
      from: {
        id: String(message.from.id),
        username: message.from.username,
        firstName: message.from.first_name,
        lastName: message.from.last_name
      },
      isMention: checkTelegramMention(message),
      replyTo: message.reply_to_message?.message_id
        ? String(message.reply_to_message.message_id)
        : undefined,
      media: parseTelegramMedia(message),
      timestamp: message.date * 1000
    }

    // Route to appropriate bot
    const router = getMessageRouter(req.payload)
    const result = await router.routeMessage(incomingMessage)

    if (result.routed) {
      req.payload.logger.info(
        `Telegram message routed to bot ${result.agentId}: ${message.chat.id}`
      )
    } else {
      req.payload.logger.debug(
        `Telegram message not routed: ${result.reason}`
      )
    }

    // Always return 200 OK to Telegram
    res.status(200).json({ ok: true })
  } catch (error) {
    req.payload.logger.error(`Telegram webhook error: ${error}`)
    res.status(200).json({ ok: true }) // Still return 200 to avoid Telegram retries
  }
}

/**
 * Check if bot was mentioned in message
 */
function checkTelegramMention(message: any): boolean {
  if (!message.entities) return false

  for (const entity of message.entities) {
    if (entity.type === 'mention' || entity.type === 'text_mention') {
      return true
    }
  }

  return false
}

/**
 * Parse media from Telegram message
 */
function parseTelegramMedia(message: any): IncomingMessage['media'] {
  const media: IncomingMessage['media'] = []

  if (message.photo && message.photo.length > 0) {
    // Get largest photo
    const photo = message.photo[message.photo.length - 1]
    media.push({
      type: 'photo',
      url: '', // Will be populated via file_id
      fileId: photo.file_id
    })
  }

  if (message.video) {
    media.push({
      type: 'video',
      url: '',
      fileId: message.video.file_id
    })
  }

  if (message.audio) {
    media.push({
      type: 'audio',
      url: '',
      fileId: message.audio.file_id
    })
  }

  if (message.document) {
    media.push({
      type: 'document',
      url: '',
      fileId: message.document.file_id
    })
  }

  return media.length > 0 ? media : undefined
}

/**
 * Set Telegram webhook URL
 */
export const setTelegramWebhook: PayloadHandler = async (req, res) => {
  try {
    const { botToken, webhookUrl } = req.body

    if (!botToken || !webhookUrl) {
      return res.status(400).json({
        error: 'Bot token and webhook URL required'
      })
    }

    // Set webhook via Telegram API
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'edited_message', 'channel_post']
        })
      }
    )

    const data = await response.json()

    if (!data.ok) {
      return res.status(400).json({
        error: data.description || 'Failed to set webhook'
      })
    }

    res.json({
      success: true,
      message: 'Webhook set successfully',
      webhookUrl
    })
  } catch (error) {
    req.payload.logger.error(`Failed to set Telegram webhook: ${error}`)
    res.status(500).json({
      error: 'Internal server error'
    })
  }
}
