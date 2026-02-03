import type { Payload } from 'payload'
import type { Bot } from '@/payload-types'
import { decrypt } from '../utils/encryption'

/**
 * Response Delivery Service
 *
 * Sends bot responses back to channel platforms (Telegram, Discord, Slack, etc.)
 *
 * Responsibilities:
 * - Format messages for each platform
 * - Handle media attachments
 * - Use platform-specific APIs
 * - Retry on failures
 * - Track delivery status
 */

export interface OutgoingMessage {
  channel: string
  accountId?: string
  peer: {
    kind: 'user' | 'group' | 'channel'
    id: string
  }
  message: string
  parseMode?: 'markdown' | 'html' | 'plain'
  media?: Array<{
    type: 'photo' | 'video' | 'audio' | 'document'
    url: string
    caption?: string
  }>
  replyTo?: string
  buttons?: Array<Array<{
    text: string
    url?: string
    callbackData?: string
  }>>
}

export interface DeliveryResult {
  delivered: boolean
  messageId?: string
  error?: string
  retries?: number
}

export class ResponseDeliveryService {
  constructor(private payload: Payload) {}

  /**
   * Deliver response to channel
   */
  async deliverResponse(
    bot: Bot,
    message: OutgoingMessage
  ): Promise<DeliveryResult> {
    try {
      // Get channel credentials
      const channelConfig = await this.getChannelConfig(bot, message.channel, message.accountId)

      if (!channelConfig) {
        return {
          delivered: false,
          error: 'Channel not configured for bot'
        }
      }

      // Route to appropriate channel handler
      let result: DeliveryResult

      switch (message.channel) {
        case 'telegram':
          result = await this.deliverToTelegram(channelConfig, message)
          break
        case 'discord':
          result = await this.deliverToDiscord(channelConfig, message)
          break
        case 'slack':
          result = await this.deliverToSlack(channelConfig, message)
          break
        case 'whatsapp':
          result = await this.deliverToWhatsApp(channelConfig, message)
          break
        default:
          return {
            delivered: false,
            error: `Unsupported channel: ${message.channel}`
          }
      }

      // Track delivery
      await this.trackDelivery(bot, message, result)

      return result
    } catch (error) {
      this.payload.logger.error(`Failed to deliver message: ${error}`)
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Get channel configuration
   */
  private async getChannelConfig(
    bot: Bot,
    channel: string,
    accountId?: string
  ): Promise<any | null> {
    const channels = await this.payload.find({
      collection: 'bot-channels',
      where: {
        and: [
          { bot: { equals: bot.id } },
          { channel: { equals: channel } },
          accountId ? { accountId: { equals: accountId } } : {}
        ]
      },
      limit: 1
    })

    return channels.docs[0] || null
  }

  /**
   * Deliver to Telegram
   */
  private async deliverToTelegram(
    channelConfig: any,
    message: OutgoingMessage
  ): Promise<DeliveryResult> {
    try {
      // Decrypt bot token
      const credentials = channelConfig.credentials?.telegram
      if (!credentials?.botToken) {
        throw new Error('Telegram bot token not configured')
      }

      const botToken = decrypt(credentials.botToken)
      const apiUrl = `https://api.telegram.org/bot${botToken}`

      // Send message
      const sendMessagePayload: any = {
        chat_id: message.peer.id,
        text: message.message
      }

      // Parse mode
      if (message.parseMode === 'markdown') {
        sendMessagePayload.parse_mode = 'Markdown'
      } else if (message.parseMode === 'html') {
        sendMessagePayload.parse_mode = 'HTML'
      }

      // Reply to message
      if (message.replyTo) {
        sendMessagePayload.reply_to_message_id = message.replyTo
      }

      // Inline keyboard
      if (message.buttons && message.buttons.length > 0) {
        sendMessagePayload.reply_markup = {
          inline_keyboard: message.buttons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              url: btn.url,
              callback_data: btn.callbackData
            }))
          )
        }
      }

      const response = await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendMessagePayload)
      })

      const data = await response.json()

      if (!data.ok) {
        throw new Error(data.description || 'Telegram API error')
      }

      // Send media if present
      if (message.media && message.media.length > 0) {
        for (const media of message.media) {
          await this.sendTelegramMedia(apiUrl, message.peer.id, media)
        }
      }

      return {
        delivered: true,
        messageId: String(data.result.message_id)
      }
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Send media to Telegram
   */
  private async sendTelegramMedia(
    apiUrl: string,
    chatId: string,
    media: { type: string; url: string; caption?: string }
  ): Promise<void> {
    const endpoint = {
      photo: 'sendPhoto',
      video: 'sendVideo',
      audio: 'sendAudio',
      document: 'sendDocument'
    }[media.type] || 'sendDocument'

    const fieldName = {
      photo: 'photo',
      video: 'video',
      audio: 'audio',
      document: 'document'
    }[media.type] || 'document'

    await fetch(`${apiUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        [fieldName]: media.url,
        caption: media.caption
      })
    })
  }

  /**
   * Deliver to Discord
   */
  private async deliverToDiscord(
    channelConfig: any,
    message: OutgoingMessage
  ): Promise<DeliveryResult> {
    try {
      const credentials = channelConfig.credentials?.discord
      if (!credentials?.botToken) {
        throw new Error('Discord bot token not configured')
      }

      const botToken = decrypt(credentials.botToken)

      // Send message to Discord channel/user
      const response = await fetch(
        `https://discord.com/api/v10/channels/${message.peer.id}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${botToken}`
          },
          body: JSON.stringify({
            content: message.message,
            message_reference: message.replyTo
              ? { message_id: message.replyTo }
              : undefined
          })
        }
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Discord API error')
      }

      return {
        delivered: true,
        messageId: data.id
      }
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Deliver to Slack
   */
  private async deliverToSlack(
    channelConfig: any,
    message: OutgoingMessage
  ): Promise<DeliveryResult> {
    try {
      const credentials = channelConfig.credentials?.slack
      if (!credentials?.botToken) {
        throw new Error('Slack bot token not configured')
      }

      const botToken = decrypt(credentials.botToken)

      // Send message to Slack
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`
        },
        body: JSON.stringify({
          channel: message.peer.id,
          text: message.message,
          thread_ts: message.replyTo,
          blocks: message.buttons
            ? [
                {
                  type: 'actions',
                  elements: message.buttons.flat().map((btn) => ({
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: btn.text
                    },
                    url: btn.url,
                    value: btn.callbackData
                  }))
                }
              ]
            : undefined
        })
      })

      const data = await response.json()

      if (!data.ok) {
        throw new Error(data.error || 'Slack API error')
      }

      return {
        delivered: true,
        messageId: data.ts
      }
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Deliver to WhatsApp
   */
  private async deliverToWhatsApp(
    channelConfig: any,
    message: OutgoingMessage
  ): Promise<DeliveryResult> {
    try {
      const credentials = channelConfig.credentials?.whatsapp
      if (!credentials?.phoneNumberId || !credentials?.accessToken) {
        throw new Error('WhatsApp credentials not configured')
      }

      const phoneNumberId = credentials.phoneNumberId
      const accessToken = decrypt(credentials.accessToken)

      // Send message via WhatsApp Business API
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: message.peer.id,
            text: {
              body: message.message
            }
          })
        }
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || 'WhatsApp API error')
      }

      return {
        delivered: true,
        messageId: data.messages?.[0]?.id
      }
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Track delivery in database
   */
  private async trackDelivery(
    bot: Bot,
    message: OutgoingMessage,
    result: DeliveryResult
  ): Promise<void> {
    const sessionKey = `${message.channel}:${message.peer.id}:${bot.agentId}`

    // Update session with delivery status
    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: { equals: sessionKey }
      },
      limit: 1
    })

    if (sessions.docs.length > 0) {
      const session = sessions.docs[0]
      const metadata = session.metadata || {}

      await this.payload.update({
        collection: 'sessions',
        id: session.id,
        data: {
          metadata: {
            ...metadata,
            lastDelivery: {
              timestamp: new Date().toISOString(),
              delivered: result.delivered,
              messageId: result.messageId,
              error: result.error
            }
          }
        }
      })
    }
  }

  /**
   * Retry delivery with exponential backoff
   */
  async deliverWithRetry(
    bot: Bot,
    message: OutgoingMessage,
    maxRetries = 3
  ): Promise<DeliveryResult> {
    let lastError: string | undefined

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = await this.deliverResponse(bot, message)

      if (result.delivered) {
        return {
          ...result,
          retries: attempt
        }
      }

      lastError = result.error

      // Exponential backoff: 1s, 2s, 4s
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000
        await new Promise((resolve) => setTimeout(resolve, delay))
        this.payload.logger.warn(
          `Retry ${attempt + 1}/${maxRetries} for ${message.channel}:${message.peer.id}`
        )
      }
    }

    return {
      delivered: false,
      error: lastError,
      retries: maxRetries
    }
  }
}

/**
 * Get ResponseDeliveryService instance
 */
export function getResponseDeliveryService(payload: Payload): ResponseDeliveryService {
  return new ResponseDeliveryService(payload)
}
