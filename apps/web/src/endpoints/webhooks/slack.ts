import type { PayloadHandler } from 'payload'
import { getMessageRouter } from '../../lib/message-routing/router'
import type { IncomingMessage } from '../../lib/message-routing/router'
import { createHmac } from 'crypto'

/**
 * Slack Webhook Handler
 *
 * Receives events from Slack Events API and routes them to appropriate bot.
 *
 * Slack sends events like:
 * {
 *   type: "event_callback",
 *   event: {
 *     type: "message",
 *     user: "U123456",
 *     text: "Hello bot",
 *     channel: "C123456",
 *     ts: "1234567890.123456",
 *     thread_ts?: "1234567890.123456"
 *   }
 * }
 */

export const handleSlackWebhook: PayloadHandler = async (req, res) => {
  try {
    const payload = req.body

    // Verify Slack signature
    const signature = req.headers['x-slack-signature'] as string
    const timestamp = req.headers['x-slack-request-timestamp'] as string

    if (signature && timestamp) {
      const isValid = verifySlackSignature(
        req.body,
        signature,
        timestamp,
        process.env.SLACK_SIGNING_SECRET || ''
      )

      if (!isValid) {
        return res.status(401).json({ error: 'Invalid signature' })
      }
    }

    // Handle URL verification challenge
    if (payload.type === 'url_verification') {
      return res.json({ challenge: payload.challenge })
    }

    // Handle event callbacks
    if (payload.type === 'event_callback') {
      const event = payload.event

      // Only handle message events
      if (event.type !== 'message') {
        return res.status(200).json({ ok: true })
      }

      // Ignore bot messages and message_changed events
      if (event.bot_id || event.subtype === 'message_changed') {
        return res.status(200).json({ ok: true })
      }

      // Parse message
      const incomingMessage: IncomingMessage = {
        channel: 'slack',
        accountId: req.params.accountId || 'default',
        peer: {
          kind: event.channel_type === 'im' ? 'user' : 'group',
          id: event.channel,
          name: event.channel_type
        },
        message: event.text || '',
        messageId: event.ts,
        from: {
          id: event.user,
          username: event.user
        },
        isMention: checkSlackMention(event),
        replyTo: event.thread_ts,
        media: parseSlackMedia(event),
        timestamp: parseFloat(event.ts) * 1000,
        teamId: payload.team_id
      }

      // Route to appropriate bot
      const router = getMessageRouter(req.payload)
      const result = await router.routeMessage(incomingMessage)

      if (result.routed) {
        req.payload.logger.info(
          `Slack message routed to bot ${result.agentId}: ${event.channel}`
        )
      } else {
        req.payload.logger.debug(
          `Slack message not routed: ${result.reason}`
        )
      }
    }

    res.status(200).json({ ok: true })
  } catch (error) {
    req.payload.logger.error(`Slack webhook error: ${error}`)
    res.status(200).json({ ok: true })
  }
}

/**
 * Verify Slack signature
 */
function verifySlackSignature(
  body: any,
  signature: string,
  timestamp: string,
  signingSecret: string
): boolean {
  try {
    // Check timestamp is recent (within 5 minutes)
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parseInt(timestamp)) > 60 * 5) {
      return false
    }

    // Compute signature
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
    const sigBaseString = `v0:${timestamp}:${bodyStr}`

    const hmac = createHmac('sha256', signingSecret)
    hmac.update(sigBaseString)
    const computedSignature = `v0=${hmac.digest('hex')}`

    return computedSignature === signature
  } catch (error) {
    return false
  }
}

/**
 * Check if bot was mentioned
 */
function checkSlackMention(event: any): boolean {
  if (!event.text) return false

  // Slack mentions are in format <@U123456>
  return /<@[UW][A-Z0-9]+>/.test(event.text)
}

/**
 * Parse Slack media
 */
function parseSlackMedia(event: any): IncomingMessage['media'] {
  if (!event.files || event.files.length === 0) {
    return undefined
  }

  return event.files.map((file: any) => {
    let type: 'photo' | 'video' | 'audio' | 'document' = 'document'

    if (file.mimetype?.startsWith('image/')) {
      type = 'photo'
    } else if (file.mimetype?.startsWith('video/')) {
      type = 'video'
    } else if (file.mimetype?.startsWith('audio/')) {
      type = 'audio'
    }

    return {
      type,
      url: file.url_private || file.permalink
    }
  })
}
