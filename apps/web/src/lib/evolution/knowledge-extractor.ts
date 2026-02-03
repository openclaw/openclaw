import type { Payload } from 'payload'
import type { Bot, Profile } from '@/payload-types'
import { ActivityPubAdapter } from '../federation/activitypub'
import { AtProtoAdapter } from '../federation/atproto'
import { BittensorService } from '../blockchain/bittensor'

/**
 * Knowledge Extractor
 * Extracts knowledge from external sources for bot evolution
 *
 * Sources:
 * - Mastodon/ActivityPub network
 * - Bluesky/AT Protocol network
 * - Bittensor decentralized AI network
 * - Web scraping and APIs
 * - User interactions and feedback
 */

export interface KnowledgeItem {
  id: string
  source: 'activitypub' | 'atproto' | 'bittensor' | 'web' | 'interaction'
  type: 'fact' | 'opinion' | 'technique' | 'pattern' | 'example'
  content: string
  context?: string
  metadata: {
    author?: string
    url?: string
    timestamp: string
    relevance: number // 0-1
    confidence: number // 0-1
    tags: string[]
  }
  embeddings?: number[] // Vector embeddings for similarity search
}

export interface ExtractionConfig {
  sources: Array<'activitypub' | 'atproto' | 'bittensor' | 'web'>
  topics: string[]
  hashtags?: string[]
  keywords?: string[]
  maxItems?: number
  minRelevance?: number
}

export interface EvolutionMetrics {
  knowledgeCount: number
  sourcesUsed: string[]
  topicsLearned: string[]
  improvementScore: number // 0-1
  lastEvolution: string
  evolutionHistory: Array<{
    timestamp: string
    itemsAdded: number
    improvement: number
  }>
}

/**
 * Knowledge Extraction Service
 */
export class KnowledgeExtractor {
  private activitypub: ActivityPubAdapter
  private atproto: AtProtoAdapter
  private bittensor: BittensorService

  constructor(private payload: Payload) {
    this.activitypub = new ActivityPubAdapter(payload)
    this.atproto = new AtProtoAdapter(payload)
    this.bittensor = new BittensorService(payload)
  }

  /**
   * Extract knowledge from all configured sources
   */
  async extractKnowledge(
    bot: Bot,
    config: ExtractionConfig
  ): Promise<KnowledgeItem[]> {
    const knowledgeItems: KnowledgeItem[] = []

    // Extract from each source in parallel
    const extractionPromises: Promise<KnowledgeItem[]>[] = []

    if (config.sources.includes('activitypub')) {
      extractionPromises.push(this.extractFromActivityPub(config))
    }

    if (config.sources.includes('atproto')) {
      extractionPromises.push(this.extractFromAtProto(config))
    }

    if (config.sources.includes('bittensor')) {
      extractionPromises.push(this.extractFromBittensor(config))
    }

    if (config.sources.includes('web')) {
      extractionPromises.push(this.extractFromWeb(config))
    }

    const results = await Promise.all(extractionPromises)

    // Flatten results
    for (const items of results) {
      knowledgeItems.push(...items)
    }

    // Filter by relevance
    const filtered = knowledgeItems.filter(
      (item) => item.metadata.relevance >= (config.minRelevance || 0.5)
    )

    // Sort by relevance and limit
    filtered.sort((a, b) => b.metadata.relevance - a.metadata.relevance)

    const final = filtered.slice(0, config.maxItems || 100)

    this.payload.logger.info(
      `Extracted ${final.length} knowledge items for bot ${bot.name}`
    )

    return final
  }

  /**
   * Extract knowledge from Mastodon/ActivityPub
   */
  private async extractFromActivityPub(
    config: ExtractionConfig
  ): Promise<KnowledgeItem[]> {
    const items: KnowledgeItem[] = []

    // Search for posts with relevant hashtags
    for (const hashtag of config.hashtags || []) {
      try {
        // In real implementation, this would query Mastodon search API
        const posts = await this.searchMastodon(hashtag)

        for (const post of posts) {
          const relevance = this.calculateRelevance(post.content, config)

          if (relevance >= (config.minRelevance || 0.5)) {
            items.push({
              id: `activitypub-${post.id}`,
              source: 'activitypub',
              type: this.classifyContent(post.content),
              content: post.content,
              context: `Found in Mastodon with hashtag #${hashtag}`,
              metadata: {
                author: post.author,
                url: post.url,
                timestamp: post.timestamp,
                relevance,
                confidence: 0.8,
                tags: [hashtag, ...this.extractTags(post.content)]
              }
            })
          }
        }
      } catch (error) {
        this.payload.logger.error(
          `Failed to extract from ActivityPub: ${error}`
        )
      }
    }

    return items
  }

  /**
   * Extract knowledge from Bluesky/AT Protocol
   */
  private async extractFromAtProto(
    config: ExtractionConfig
  ): Promise<KnowledgeItem[]> {
    const items: KnowledgeItem[] = []

    // Search Bluesky for relevant content
    for (const keyword of config.keywords || []) {
      try {
        const posts = await this.atproto.searchPosts(keyword, 25)

        for (const post of posts) {
          const relevance = this.calculateRelevance(post.record.text, config)

          if (relevance >= (config.minRelevance || 0.5)) {
            items.push({
              id: `atproto-${post.uri}`,
              source: 'atproto',
              type: this.classifyContent(post.record.text),
              content: post.record.text,
              context: `Found in Bluesky searching for: ${keyword}`,
              metadata: {
                author: post.author.handle,
                url: `https://bsky.app/profile/${post.author.did}/post/${post.uri.split('/').pop()}`,
                timestamp: post.record.createdAt,
                relevance,
                confidence: 0.85,
                tags: this.extractTags(post.record.text)
              }
            })
          }
        }
      } catch (error) {
        this.payload.logger.error(`Failed to extract from AT Proto: ${error}`)
      }
    }

    return items
  }

  /**
   * Extract knowledge from Bittensor network
   */
  private async extractFromBittensor(
    config: ExtractionConfig
  ): Promise<KnowledgeItem[]> {
    const items: KnowledgeItem[] = []

    // Query Bittensor miners for knowledge
    for (const topic of config.topics) {
      try {
        const responses = await this.bittensor.query({
          prompt: `What are the key concepts and techniques related to ${topic}?`,
          maxTokens: 500
        })

        for (const response of responses.slice(0, 3)) {
          // Top 3 responses
          items.push({
            id: `bittensor-${response.uid}-${Date.now()}`,
            source: 'bittensor',
            type: 'technique',
            content: response.text,
            context: `Learned from Bittensor miner ${response.uid}`,
            metadata: {
              author: `Bittensor Miner ${response.uid}`,
              timestamp: new Date().toISOString(),
              relevance: response.score,
              confidence: response.score,
              tags: [topic]
            }
          })
        }
      } catch (error) {
        this.payload.logger.error(`Failed to extract from Bittensor: ${error}`)
      }
    }

    return items
  }

  /**
   * Extract knowledge from web sources
   */
  private async extractFromWeb(
    config: ExtractionConfig
  ): Promise<KnowledgeItem[]> {
    const items: KnowledgeItem[] = []

    // Search web for relevant content
    // This would integrate with search APIs (Google, Bing, DuckDuckGo)
    // and crawl relevant websites

    for (const topic of config.topics) {
      try {
        // Simulated web search
        const searchResults = await this.searchWeb(topic)

        for (const result of searchResults) {
          const relevance = this.calculateRelevance(result.snippet, config)

          if (relevance >= (config.minRelevance || 0.5)) {
            items.push({
              id: `web-${result.url}`,
              source: 'web',
              type: 'fact',
              content: result.snippet,
              context: `Found via web search for: ${topic}`,
              metadata: {
                url: result.url,
                timestamp: new Date().toISOString(),
                relevance,
                confidence: 0.7,
                tags: [topic]
              }
            })
          }
        }
      } catch (error) {
        this.payload.logger.error(`Failed to extract from web: ${error}`)
      }
    }

    return items
  }

  /**
   * Calculate relevance score for content
   */
  private calculateRelevance(
    content: string,
    config: ExtractionConfig
  ): number {
    let score = 0
    const contentLower = content.toLowerCase()

    // Check topics
    for (const topic of config.topics) {
      if (contentLower.includes(topic.toLowerCase())) {
        score += 0.3
      }
    }

    // Check keywords
    for (const keyword of config.keywords || []) {
      if (contentLower.includes(keyword.toLowerCase())) {
        score += 0.2
      }
    }

    // Check hashtags
    for (const hashtag of config.hashtags || []) {
      if (contentLower.includes(`#${hashtag.toLowerCase()}`)) {
        score += 0.25
      }
    }

    // Boost for longer, detailed content
    if (content.length > 500) {
      score += 0.1
    }

    return Math.min(score, 1.0)
  }

  /**
   * Classify content type
   */
  private classifyContent(
    content: string
  ): 'fact' | 'opinion' | 'technique' | 'pattern' | 'example' {
    const contentLower = content.toLowerCase()

    if (
      contentLower.includes('how to') ||
      contentLower.includes('step by step') ||
      contentLower.includes('method')
    ) {
      return 'technique'
    }

    if (
      contentLower.includes('example') ||
      contentLower.includes('instance') ||
      contentLower.includes('case study')
    ) {
      return 'example'
    }

    if (
      contentLower.includes('pattern') ||
      contentLower.includes('common') ||
      contentLower.includes('typically')
    ) {
      return 'pattern'
    }

    if (
      contentLower.includes('i think') ||
      contentLower.includes('in my opinion') ||
      contentLower.includes('i believe')
    ) {
      return 'opinion'
    }

    return 'fact'
  }

  /**
   * Extract tags from content
   */
  private extractTags(content: string): string[] {
    const tags: string[] = []

    // Extract hashtags
    const hashtagRegex = /#([a-zA-Z0-9_]+)/g
    let match: RegExpExecArray | null
    while ((match = hashtagRegex.exec(content)) !== null) {
      tags.push(match[1])
    }

    // Extract key phrases (simplified)
    const phrases = content
      .toLowerCase()
      .match(/\b(?:ai|ml|blockchain|crypto|bot|agent|web3|defi)\b/g)
    if (phrases) {
      tags.push(...phrases)
    }

    return [...new Set(tags)]
  }

  /**
   * Store knowledge items in bot's knowledge base
   */
  async storeKnowledge(bot: Bot, items: KnowledgeItem[]): Promise<void> {
    // Get existing knowledge base
    const existingKnowledge = (bot as any).knowledgeBase || []

    // Merge with new items (avoid duplicates)
    const knowledgeMap = new Map<string, KnowledgeItem>()

    for (const item of existingKnowledge) {
      knowledgeMap.set(item.id, item)
    }

    for (const item of items) {
      knowledgeMap.set(item.id, item)
    }

    const mergedKnowledge = Array.from(knowledgeMap.values())

    // Update bot record
    await this.payload.update({
      collection: 'bots',
      id: bot.id,
      data: {
        // @ts-ignore - custom field
        knowledgeBase: mergedKnowledge,
        knowledgeCount: mergedKnowledge.length,
        lastKnowledgeUpdate: new Date().toISOString()
      }
    })

    this.payload.logger.info(
      `Stored ${items.length} new knowledge items for bot ${bot.name}`
    )
  }

  /**
   * Evolve bot based on extracted knowledge
   */
  async evolveBot(bot: Bot, knowledge: KnowledgeItem[]): Promise<void> {
    this.payload.logger.info(`Evolving bot ${bot.name} with new knowledge...`)

    // Store knowledge
    await this.storeKnowledge(bot, knowledge)

    // Update bot's system prompt with new knowledge
    const knowledgeSummary = this.summarizeKnowledge(knowledge)
    const enhancedPrompt = this.enhanceSystemPrompt(
      bot.systemPrompt || '',
      knowledgeSummary
    )

    // Calculate improvement metrics
    const metrics = await this.calculateEvolutionMetrics(bot, knowledge)

    // Update bot
    await this.payload.update({
      collection: 'bots',
      id: bot.id,
      data: {
        systemPrompt: enhancedPrompt,
        // @ts-ignore - custom fields
        evolutionMetrics: metrics,
        lastEvolution: new Date().toISOString()
      }
    })

    this.payload.logger.info(
      `Bot ${bot.name} evolved: +${(metrics.improvementScore * 100).toFixed(1)}% improvement`
    )
  }

  /**
   * Summarize knowledge items
   */
  private summarizeKnowledge(items: KnowledgeItem[]): string {
    const byType = new Map<string, KnowledgeItem[]>()

    for (const item of items) {
      if (!byType.has(item.type)) {
        byType.set(item.type, [])
      }
      byType.get(item.type)!.push(item)
    }

    const sections: string[] = []

    for (const [type, typeItems] of byType.entries()) {
      sections.push(`\n${type.toUpperCase()}:`)
      for (const item of typeItems.slice(0, 5)) {
        // Top 5 per type
        sections.push(`- ${item.content.slice(0, 200)}...`)
      }
    }

    return sections.join('\n')
  }

  /**
   * Enhance system prompt with knowledge
   */
  private enhanceSystemPrompt(
    currentPrompt: string,
    knowledgeSummary: string
  ): string {
    return `${currentPrompt}

## Knowledge Base

You have access to the following learned knowledge:

${knowledgeSummary}

Use this knowledge to provide more informed and accurate responses.`
  }

  /**
   * Calculate evolution metrics
   */
  private async calculateEvolutionMetrics(
    bot: Bot,
    newKnowledge: KnowledgeItem[]
  ): Promise<EvolutionMetrics> {
    const existingMetrics = (bot as any).evolutionMetrics as
      | EvolutionMetrics
      | undefined

    const sources = [...new Set(newKnowledge.map((k) => k.source))]
    const topics = [
      ...new Set(newKnowledge.flatMap((k) => k.metadata.tags))
    ]
    const avgRelevance =
      newKnowledge.reduce((sum, k) => sum + k.metadata.relevance, 0) /
      newKnowledge.length

    const history = existingMetrics?.evolutionHistory || []
    history.push({
      timestamp: new Date().toISOString(),
      itemsAdded: newKnowledge.length,
      improvement: avgRelevance
    })

    return {
      knowledgeCount:
        (existingMetrics?.knowledgeCount || 0) + newKnowledge.length,
      sourcesUsed: [
        ...new Set([...(existingMetrics?.sourcesUsed || []), ...sources])
      ],
      topicsLearned: [
        ...new Set([...(existingMetrics?.topicsLearned || []), ...topics])
      ],
      improvementScore: avgRelevance,
      lastEvolution: new Date().toISOString(),
      evolutionHistory: history.slice(-10) // Keep last 10 evolutions
    }
  }

  /**
   * Cross-learn between bots
   */
  async crossLearn(sourceBot: Bot, targetBot: Bot): Promise<void> {
    this.payload.logger.info(
      `Cross-learning from ${sourceBot.name} to ${targetBot.name}`
    )

    // Get source bot's knowledge
    const sourceKnowledge = (sourceBot as any).knowledgeBase as
      | KnowledgeItem[]
      | undefined

    if (!sourceKnowledge || sourceKnowledge.length === 0) {
      this.payload.logger.warn(`Source bot ${sourceBot.name} has no knowledge`)
      return
    }

    // Filter relevant knowledge for target bot
    const targetAgentType = targetBot.agentType || 'general'
    const relevantKnowledge = sourceKnowledge.filter((item) =>
      item.metadata.tags.some((tag) =>
        tag.toLowerCase().includes(targetAgentType.toLowerCase())
      )
    )

    if (relevantKnowledge.length === 0) {
      this.payload.logger.warn(
        `No relevant knowledge found for ${targetBot.name}`
      )
      return
    }

    // Transfer knowledge
    await this.evolveBot(targetBot, relevantKnowledge)

    this.payload.logger.info(
      `Transferred ${relevantKnowledge.length} knowledge items from ${sourceBot.name} to ${targetBot.name}`
    )
  }

  /**
   * Auto-improve bot based on performance metrics
   */
  async autoImprove(bot: Bot): Promise<void> {
    this.payload.logger.info(`Auto-improving bot ${bot.name}...`)

    // Analyze bot's recent interactions
    const sessions = await this.payload.find({
      collection: 'sessions',
      where: {
        agent: { equals: bot.agentId }
      },
      limit: 100,
      sort: '-createdAt'
    })

    // Extract topics from recent queries
    const topics = this.extractTopicsFromSessions(sessions.docs)

    // Extract knowledge on these topics
    const knowledge = await this.extractKnowledge(bot, {
      sources: ['activitypub', 'atproto', 'bittensor', 'web'],
      topics: topics.slice(0, 5), // Top 5 topics
      maxItems: 50,
      minRelevance: 0.6
    })

    // Evolve bot
    await this.evolveBot(bot, knowledge)

    this.payload.logger.info(`Bot ${bot.name} auto-improved successfully`)
  }

  /**
   * Extract topics from session conversations
   */
  private extractTopicsFromSessions(sessions: any[]): string[] {
    const topicCounts = new Map<string, number>()

    for (const session of sessions) {
      // Analyze messages in session
      // This would use NLP to extract key topics
      // Simplified: extract keywords from titles or first messages

      const topics = ['ai', 'coding', 'web3', 'blockchain'] // Placeholder
      for (const topic of topics) {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1)
      }
    }

    // Sort by frequency
    const sorted = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic)

    return sorted
  }

  /**
   * Search Mastodon (placeholder)
   */
  private async searchMastodon(
    hashtag: string
  ): Promise<
    Array<{ id: string; content: string; author: string; url: string; timestamp: string }>
  > {
    // In real implementation, query Mastodon search API
    return []
  }

  /**
   * Search web (placeholder)
   */
  private async searchWeb(
    query: string
  ): Promise<Array<{ url: string; title: string; snippet: string }>> {
    // In real implementation, use search APIs
    return []
  }
}

/**
 * Get KnowledgeExtractor instance
 */
export function getKnowledgeExtractor(payload: Payload): KnowledgeExtractor {
  return new KnowledgeExtractor(payload)
}
