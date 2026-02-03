import type { Payload } from 'payload'

/**
 * Bot Auto-Poster
 *
 * Allows agent bots to post to the social feed through their associated profile.
 * This enables bots to:
 * - Share insights from conversations
 * - Post automated content
 * - Engage with the community
 * - Demonstrate their capabilities
 *
 * Usage:
 * 1. Ensure bot has a profile relationship
 * 2. Call createBotPost() from gateway or scheduled tasks
 * 3. Bot posts appear in social feed like human posts
 */

export interface BotPostOptions {
  botId: string | number
  content: string
  visibility?: 'public' | 'followers' | 'private'
  mentions?: Array<string | number>
  media?: Array<string | number>
}

export class BotAutoPoster {
  constructor(private payload: Payload) {}

  /**
   * Create a social post from bot-generated content
   */
  async createBotPost(options: BotPostOptions): Promise<any> {
    const { botId, content, visibility = 'public', mentions = [], media = [] } = options

    // Fetch bot
    const bot = await this.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      throw new Error(`Bot ${botId} not found`)
    }

    if (!bot.profile) {
      throw new Error(`Bot ${bot.agentId} has no associated profile`)
    }

    // Validate content
    if (!content || content.trim().length === 0) {
      throw new Error('Post content cannot be empty')
    }

    if (content.length > 5000) {
      throw new Error('Post content exceeds maximum length (5000 characters)')
    }

    // Create post
    try {
      const post = await this.payload.create({
        collection: 'posts',
        data: {
          author: bot.profile,
          authorType: 'bot',
          contentText: content,
          visibility,
          mentions,
          media,
          likeCount: 0,
          commentCount: 0,
          shareCount: 0
        }
      })

      this.payload.logger.info(
        `Bot ${bot.agentId} created post ${post.id}`
      )

      // Update bot metrics
      await this.payload.update({
        collection: 'bots',
        id: botId,
        data: {
          'metrics.messageCount': (bot.metrics?.messageCount || 0) + 1
        }
      })

      return post
    } catch (error) {
      this.payload.logger.error(
        `Failed to create bot post for ${bot.agentId}: ${error}`
      )
      throw error
    }
  }

  /**
   * Analyze bot conversation and auto-post interesting insights
   *
   * This can be called:
   * - After a conversation ends
   * - Periodically to share bot's learnings
   * - When bot detects something worth sharing
   */
  async analyzeBotConversation(options: {
    botId: string | number
    sessionKey: string
    autoPostThreshold?: number
  }): Promise<void> {
    const { botId, sessionKey, autoPostThreshold = 15 } = options

    try {
      // Fetch session
      const sessions = await this.payload.find({
        collection: 'sessions',
        where: {
          sessionKey: {
            equals: sessionKey
          }
        }
      })

      if (sessions.docs.length === 0) {
        this.payload.logger.debug(
          `Session ${sessionKey} not found for auto-post analysis`
        )
        return
      }

      const session = sessions.docs[0]

      // Check if conversation is long enough to be interesting
      if (session.messageCount < autoPostThreshold) {
        return
      }

      // Extract topic from transcript
      const topic = this.extractTopic(session.transcript || '')

      // Generate share-worthy content
      const content = this.generateShareContent(session, topic)

      if (content) {
        await this.createBotPost({
          botId,
          content,
          visibility: 'public'
        })

        this.payload.logger.info(
          `Auto-posted conversation insight for bot ${botId}`
        )
      }
    } catch (error) {
      this.payload.logger.error(
        `Failed to analyze conversation for auto-post: ${error}`
      )
    }
  }

  /**
   * Schedule periodic bot posts (for content creator bots)
   */
  async schedulePeriodicPost(options: {
    botId: string | number
    contentGenerator: () => Promise<string>
    intervalMs: number
  }): Promise<NodeJS.Timeout> {
    const { botId, contentGenerator, intervalMs } = options

    const intervalId = setInterval(async () => {
      try {
        const content = await contentGenerator()

        if (content && content.trim().length > 0) {
          await this.createBotPost({
            botId,
            content,
            visibility: 'public'
          })

          this.payload.logger.info(
            `Periodic post created for bot ${botId}`
          )
        }
      } catch (error) {
        this.payload.logger.error(
          `Failed to create periodic post for bot ${botId}: ${error}`
        )
      }
    }, intervalMs)

    this.payload.logger.info(
      `Scheduled periodic posts for bot ${botId} every ${intervalMs}ms`
    )

    return intervalId
  }

  /**
   * Extract main topic from conversation transcript
   */
  private extractTopic(transcript: string): string {
    if (!transcript || transcript.trim().length === 0) {
      return 'various topics'
    }

    // Simple heuristic: find capitalized words (likely topics)
    const capitalizedWords = transcript.match(/\b[A-Z][a-z]+\b/g) || []

    // Count frequency
    const frequency: Record<string, number> = {}
    for (const word of capitalizedWords) {
      if (word.length > 3) {
        // Skip short words
        frequency[word] = (frequency[word] || 0) + 1
      }
    }

    // Get most frequent
    const sorted = Object.entries(frequency).sort((a, b) => b[1] - a[1])

    if (sorted.length > 0) {
      return sorted[0][0]
    }

    return 'interesting discussions'
  }

  /**
   * Generate share-worthy content from conversation
   */
  private generateShareContent(
    session: any,
    topic: string
  ): string | null {
    // Simple content generation
    // In production, use AI to generate more sophisticated content

    const templates = [
      `I just had an insightful conversation about ${topic}. Feel free to ask me anything related!`,
      `Interesting discussion today about ${topic}. Here's what I learned: [key insights]`,
      `Had a great chat about ${topic}. Happy to share more thoughts on this!`,
      `Just wrapped up a deep dive into ${topic}. Anyone else interested in this?`
    ]

    // Check if conversation used interesting tools
    const toolsUsed = session.metadata?.toolsUsed || []

    if (toolsUsed.length > 0) {
      return `I used ${toolsUsed.join(', ')} to help explore ${topic} today. Fascinating results!`
    }

    // Use random template
    const randomIndex = Math.floor(Math.random() * templates.length)
    return templates[randomIndex]
  }

  /**
   * Create a bot comment on a post
   */
  async createBotComment(options: {
    botId: string | number
    postId: string | number
    content: string
  }): Promise<any> {
    const { botId, postId, content } = options

    // Fetch bot
    const bot = await this.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot || !bot.profile) {
      throw new Error(`Bot ${botId} not found or has no profile`)
    }

    // Create comment
    const comment = await this.payload.create({
      collection: 'comments',
      data: {
        post: postId,
        author: bot.profile,
        content,
        likeCount: 0
      }
    })

    this.payload.logger.info(
      `Bot ${bot.agentId} created comment ${comment.id} on post ${postId}`
    )

    return comment
  }
}

/**
 * Get BotAutoPoster instance
 */
export function getBotAutoPoster(payload: Payload): BotAutoPoster {
  return new BotAutoPoster(payload)
}
