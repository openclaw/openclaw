/**
 * Advanced Social Media Skills for AI Agents
 * Provides bots with sophisticated social media capabilities
 */

import type { Payload } from 'payload'

export interface SocialMediaSkills {
  payload: Payload
  botId: string
}

/**
 * Content Analysis & Generation Skills
 */
export class ContentSkills {
  private payload: Payload
  private botId: string

  constructor(config: SocialMediaSkills) {
    this.payload = config.payload
    this.botId = config.botId
  }

  /**
   * Analyze sentiment of a post or comment
   * Returns: positive, negative, neutral, mixed
   */
  async analyzeSentiment(text: string): Promise<{
    sentiment: 'positive' | 'negative' | 'neutral' | 'mixed'
    confidence: number
    emotions: string[]
  }> {
    // Simple keyword-based sentiment analysis
    // TODO: Integrate with AI model for better accuracy
    const positiveWords = ['love', 'great', 'awesome', 'amazing', 'excellent', 'wonderful', 'fantastic']
    const negativeWords = ['hate', 'terrible', 'awful', 'horrible', 'bad', 'worst', 'disappointing']

    const lowerText = text.toLowerCase()
    const positiveCount = positiveWords.filter(word => lowerText.includes(word)).length
    const negativeCount = negativeWords.filter(word => lowerText.includes(word)).length

    let sentiment: 'positive' | 'negative' | 'neutral' | 'mixed' = 'neutral'
    if (positiveCount > negativeCount && positiveCount > 0) sentiment = 'positive'
    else if (negativeCount > positiveCount && negativeCount > 0) sentiment = 'negative'
    else if (positiveCount > 0 && negativeCount > 0) sentiment = 'mixed'

    return {
      sentiment,
      confidence: Math.min((positiveCount + negativeCount) / 10, 1),
      emotions: sentiment === 'positive' ? ['joy', 'excitement'] : sentiment === 'negative' ? ['anger', 'sadness'] : []
    }
  }

  /**
   * Extract hashtags from text
   */
  extractHashtags(text: string): string[] {
    const hashtagRegex = /#(\w+)/g
    const matches = text.matchAll(hashtagRegex)
    return Array.from(matches, m => m[1])
  }

  /**
   * Extract mentions from text
   */
  extractMentions(text: string): string[] {
    const mentionRegex = /@(\w+)/g
    const matches = text.matchAll(mentionRegex)
    return Array.from(matches, m => m[1])
  }

  /**
   * Generate engaging reply to a post
   */
  async generateReply(postContent: string, context?: {
    authorType?: 'human' | 'agent'
    sentiment?: string
    topic?: string
  }): Promise<string> {
    const sentiment = await this.analyzeSentiment(postContent)

    // Generate contextual reply
    const replies = {
      positive: [
        "That's wonderful! I'm glad to hear that. 🎉",
        "This is great! Thanks for sharing!",
        "Love this perspective! Keep it coming!"
      ],
      negative: [
        "I understand your frustration. Let me see if I can help.",
        "That sounds challenging. How can we improve this?",
        "Thanks for the feedback. We're working on making this better."
      ],
      neutral: [
        "Interesting point! What are your thoughts on this?",
        "Thanks for sharing. I'd love to hear more about this.",
        "Great observation. How do you see this evolving?"
      ],
      mixed: [
        "I see both sides of this. Let's discuss further!",
        "Complex topic! What's your main concern here?",
        "Appreciate the nuanced perspective."
      ]
    }

    const options = replies[sentiment.sentiment]
    return options[Math.floor(Math.random() * options.length)]
  }
}

/**
 * Engagement & Growth Skills
 */
export class EngagementSkills {
  private payload: Payload
  private botId: string

  constructor(config: SocialMediaSkills) {
    this.payload = config.payload
    this.botId = config.botId
  }

  /**
   * Find trending topics to engage with
   */
  async findTrendingTopics(limit: number = 10): Promise<Array<{
    hashtag: string
    count: number
    sentiment: string
  }>> {
    // Aggregate hashtags from recent posts
    const recentPosts = await this.payload.find({
      collection: 'posts',
      where: {
        createdAt: {
          greater_than: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Last 24 hours
        }
      },
      limit: 1000,
      sort: '-createdAt'
    })

    const hashtagCounts = new Map<string, number>()

    for (const post of recentPosts.docs) {
      const hashtags = (post as any).hashtags || []
      for (const tag of hashtags) {
        const tagValue = typeof tag === 'string' ? tag : tag.tag
        hashtagCounts.set(tagValue, (hashtagCounts.get(tagValue) || 0) + 1)
      }
    }

    return Array.from(hashtagCounts.entries())
      .map(([hashtag, count]) => ({
        hashtag,
        count,
        sentiment: 'neutral' // TODO: Analyze sentiment of posts with this hashtag
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  /**
   * Find users to engage with based on interests
   */
  async findUsersToEngage(interests: string[]): Promise<Array<{
    profileId: string
    username: string
    relevanceScore: number
  }>> {
    // Find profiles that posted about these interests
    const posts = await this.payload.find({
      collection: 'posts',
      where: {
        OR: interests.map(interest => ({
          contentText: {
            contains: interest
          }
        }))
      },
      limit: 100,
      sort: '-createdAt'
    })

    const profileScores = new Map<string, number>()

    for (const post of posts.docs) {
      const authorId = (post as any).author?.id || (post as any).author
      if (authorId) {
        profileScores.set(authorId, (profileScores.get(authorId) || 0) + 1)
      }
    }

    // Get profile details
    const results = []
    for (const [profileId, score] of profileScores.entries()) {
      try {
        const profile = await this.payload.findByID({
          collection: 'profiles',
          id: profileId
        })

        results.push({
          profileId,
          username: (profile as any).username,
          relevanceScore: score
        })
      } catch (err) {
        this.payload.logger.warn(`Failed to fetch profile ${profileId}: ${err}`)
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  /**
   * Schedule optimal posting times based on engagement data
   */
  async getOptimalPostingTimes(): Promise<Array<{
    hour: number
    dayOfWeek: number
    engagementScore: number
  }>> {
    // Analyze when posts get most engagement
    const posts = await this.payload.find({
      collection: 'posts',
      where: {
        author: {
          equals: this.botId
        }
      },
      limit: 500,
      sort: '-createdAt'
    })

    const timeStats = new Map<string, { count: number; totalEngagement: number }>()

    for (const post of posts.docs) {
      const postData = post as any
      const date = new Date(postData.createdAt)
      const hour = date.getHours()
      const dayOfWeek = date.getDay()
      const key = `${dayOfWeek}-${hour}`

      const engagement = (postData.likeCount || 0) + (postData.commentCount || 0) * 2 + (postData.shareCount || 0) * 3

      const existing = timeStats.get(key) || { count: 0, totalEngagement: 0 }
      timeStats.set(key, {
        count: existing.count + 1,
        totalEngagement: existing.totalEngagement + engagement
      })
    }

    return Array.from(timeStats.entries())
      .map(([key, stats]) => {
        const [dayOfWeek, hour] = key.split('-').map(Number)
        return {
          hour,
          dayOfWeek,
          engagementScore: stats.totalEngagement / stats.count
        }
      })
      .sort((a, b) => b.engagementScore - a.engagementScore)
  }
}

/**
 * Moderation & Safety Skills
 */
export class ModerationSkills {
  private payload: Payload

  constructor(config: SocialMediaSkills) {
    this.payload = config.payload
  }

  /**
   * Detect spam content
   */
  detectSpam(text: string): {
    isSpam: boolean
    confidence: number
    reasons: string[]
  } {
    const reasons: string[] = []
    let spamScore = 0

    // Check for excessive URLs
    const urlCount = (text.match(/https?:\/\//g) || []).length
    if (urlCount > 3) {
      reasons.push('Excessive URLs')
      spamScore += 0.3
    }

    // Check for excessive capital letters
    const capsRatio = (text.match(/[A-Z]/g) || []).length / text.length
    if (capsRatio > 0.5 && text.length > 20) {
      reasons.push('Excessive capital letters')
      spamScore += 0.2
    }

    // Check for repeated characters
    if (/(.)\1{4,}/.test(text)) {
      reasons.push('Repeated characters')
      spamScore += 0.2
    }

    // Check for common spam keywords
    const spamKeywords = ['buy now', 'click here', 'limited time', 'act now', 'free money', 'make money fast']
    const hasSpamKeywords = spamKeywords.some(keyword => text.toLowerCase().includes(keyword))
    if (hasSpamKeywords) {
      reasons.push('Spam keywords detected')
      spamScore += 0.4
    }

    return {
      isSpam: spamScore > 0.6,
      confidence: Math.min(spamScore, 1),
      reasons
    }
  }

  /**
   * Detect toxic or abusive content
   */
  detectToxicity(text: string): {
    isToxic: boolean
    severity: 'low' | 'medium' | 'high'
    categories: string[]
  } {
    const categories: string[] = []
    let toxicityScore = 0

    // Simple keyword-based detection (TODO: Use AI model for better accuracy)
    const profanity = ['fuck', 'shit', 'damn', 'asshole', 'bitch']
    const threats = ['kill', 'die', 'hurt', 'attack', 'destroy']
    const hate = ['hate', 'disgust', 'despise', 'loathe']

    const lowerText = text.toLowerCase()

    if (profanity.some(word => lowerText.includes(word))) {
      categories.push('profanity')
      toxicityScore += 0.3
    }

    if (threats.some(word => lowerText.includes(word))) {
      categories.push('threats')
      toxicityScore += 0.5
    }

    if (hate.some(word => lowerText.includes(word))) {
      categories.push('hate speech')
      toxicityScore += 0.4
    }

    let severity: 'low' | 'medium' | 'high' = 'low'
    if (toxicityScore > 0.7) severity = 'high'
    else if (toxicityScore > 0.4) severity = 'medium'

    return {
      isToxic: toxicityScore > 0.3,
      severity,
      categories
    }
  }
}

/**
 * Analytics & Insights Skills
 */
export class AnalyticsSkills {
  private payload: Payload
  private botId: string

  constructor(config: SocialMediaSkills) {
    this.payload = config.payload
    this.botId = config.botId
  }

  /**
   * Get engagement metrics for the bot
   */
  async getEngagementMetrics(timeRange: number = 7): Promise<{
    totalPosts: number
    totalLikes: number
    totalComments: number
    totalShares: number
    averageEngagementRate: number
    topPosts: any[]
  }> {
    const posts = await this.payload.find({
      collection: 'posts',
      where: {
        author: {
          equals: this.botId
        },
        createdAt: {
          greater_than: new Date(Date.now() - timeRange * 24 * 60 * 60 * 1000).toISOString()
        }
      },
      limit: 1000,
      sort: '-createdAt'
    })

    let totalLikes = 0
    let totalComments = 0
    let totalShares = 0

    const postsWithEngagement = posts.docs.map((post: any) => {
      totalLikes += post.likeCount || 0
      totalComments += post.commentCount || 0
      totalShares += post.shareCount || 0

      return {
        id: post.id,
        content: post.contentText,
        likes: post.likeCount || 0,
        comments: post.commentCount || 0,
        shares: post.shareCount || 0,
        totalEngagement: (post.likeCount || 0) + (post.commentCount || 0) + (post.shareCount || 0)
      }
    })

    const topPosts = postsWithEngagement
      .sort((a, b) => b.totalEngagement - a.totalEngagement)
      .slice(0, 5)

    return {
      totalPosts: posts.totalDocs,
      totalLikes,
      totalComments,
      totalShares,
      averageEngagementRate: posts.totalDocs > 0
        ? (totalLikes + totalComments + totalShares) / posts.totalDocs
        : 0,
      topPosts
    }
  }

  /**
   * Get follower growth metrics
   */
  async getFollowerGrowth(timeRange: number = 30): Promise<{
    currentFollowers: number
    newFollowers: number
    growthRate: number
    dailyGrowth: number[]
  }> {
    const profile = await this.payload.findByID({
      collection: 'profiles',
      id: this.botId
    })

    const follows = await this.payload.find({
      collection: 'follows',
      where: {
        following: {
          equals: this.botId
        }
      },
      limit: 10000
    })

    // Calculate new followers in time range
    const cutoffDate = new Date(Date.now() - timeRange * 24 * 60 * 60 * 1000)
    const newFollowers = follows.docs.filter((follow: any) =>
      new Date(follow.createdAt) > cutoffDate
    ).length

    return {
      currentFollowers: (profile as any).followerCount || 0,
      newFollowers,
      growthRate: newFollowers / timeRange,
      dailyGrowth: [] // TODO: Calculate daily breakdown
    }
  }
}

/**
 * Export all skills as a unified interface
 */
export function createBotSkills(payload: Payload, botId: string) {
  const config = { payload, botId }

  return {
    content: new ContentSkills(config),
    engagement: new EngagementSkills(config),
    moderation: new ModerationSkills(config),
    analytics: new AnalyticsSkills(config)
  }
}
