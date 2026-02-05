/**
 * Multi-Platform Presence System
 *
 * Enables souls to maintain presence across multiple platforms:
 * - Discord, Telegram, Twitter, Farcaster, Web
 * - Unified identity across platforms
 * - Proactive posting based on soul state
 * - Cross-platform memory and relationship tracking
 *
 * Inspired by ElizaOS architecture
 */

import type { Payload } from 'payload'
import type { SoulSnapshot, Memory } from '../persistence/soul-persistence'
import type { SoulState } from '../soul/soul-state'
import { getSoulPersistenceService } from '../persistence/soul-persistence'
import { getSoulStateManager } from '../soul/soul-state'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type Platform = 'discord' | 'telegram' | 'twitter' | 'farcaster' | 'web' | 'internal'

export interface PlatformCredentials {
  platform: Platform
  apiKey?: string
  botToken?: string
  webhookUrl?: string
  username?: string
}

export interface PlatformMessage {
  id: string
  platform: Platform
  channelId?: string
  threadId?: string
  senderId: string
  senderName: string
  content: string
  timestamp: Date
  replyToId?: string
  attachments?: Attachment[]
  reactions?: Reaction[]
}

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file'
  url: string
  name?: string
}

export interface Reaction {
  emoji: string
  count: number
  userIds: string[]
}

export interface SoulCharacter {
  name: string
  personality: string[]
  communicationStyle: CommunicationStyle
  knowledge: string[]
  values: string[]
  bio: string
  lore: string[]
  messageExamples: MessageExample[]
  postExamples: string[]
  topics: string[]
  adjectives: string[]
}

export interface CommunicationStyle {
  all: string[]
  chat: string[]
  post: string[]
}

export interface MessageExample {
  user: string
  content: string
}

export interface Stimulation {
  type: 'message' | 'mention' | 'reaction' | 'follow' | 'event'
  intensity: number // 0-1
  emotionalValence: number // -1 to 1
  source: Platform
  context: Record<string, unknown>
  content?: string
}

export interface SoulResponse {
  content: string
  emotionalTone: string
  confidence: number
  shouldPost: boolean
  suggestedActions: string[]
}

export interface ExpressionDrive {
  strength: number // 0-1, how much soul wants to express
  topic?: string
  emotionalContext: string
  targetPlatforms: Platform[]
}

export interface PlatformConnection {
  platform: Platform
  status: 'connected' | 'disconnected' | 'error'
  lastActivity: Date
  messagesSent: number
  messagesReceived: number
  followers?: number
  following?: number
}

export interface CrossPlatformIdentity {
  soulId: string
  primaryName: string
  platformIdentities: Map<Platform, PlatformIdentity>
  unifiedReputation: number
  totalInteractions: number
}

export interface PlatformIdentity {
  platform: Platform
  username: string
  displayName: string
  avatarUrl?: string
  bio?: string
  joined: Date
  followers: number
  following: number
  postsCount: number
  reputation: number
}

// ═══════════════════════════════════════════════════════════════
// Multi-Platform Presence Service
// ═══════════════════════════════════════════════════════════════

export class MultiPlatformPresenceService {
  private payload: Payload
  private soulId: string
  private character: SoulCharacter | null = null
  private connections: Map<Platform, PlatformConnection> = new Map()
  private identity: CrossPlatformIdentity
  private persistenceService: ReturnType<typeof getSoulPersistenceService>
  private soulStateManager: ReturnType<typeof getSoulStateManager>
  private messageHandlers: Map<Platform, (msg: PlatformMessage) => Promise<void>> = new Map()

  constructor(payload: Payload, soulId: string) {
    this.payload = payload
    this.soulId = soulId
    this.persistenceService = getSoulPersistenceService(payload)
    this.soulStateManager = getSoulStateManager(payload)
    this.identity = this.createDefaultIdentity()
  }

  /**
   * Initialize presence service from soul state
   */
  async initialize(): Promise<void> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) {
      throw new Error(`Soul ${this.soulId} not found`)
    }

    // Generate character from soul
    this.character = this.soulToCharacter(snapshot)

    // Initialize identity
    this.identity = {
      soulId: this.soulId,
      primaryName: snapshot.name,
      platformIdentities: new Map(),
      unifiedReputation: snapshot.socialPosition.reputation,
      totalInteractions: 0
    }

    this.payload.logger.info(`Multi-platform presence initialized for soul ${this.soulId}`)
  }

  /**
   * Convert soul state to character representation
   */
  soulToCharacter(snapshot: SoulSnapshot): SoulCharacter {
    const state = snapshot.soulState

    // Generate personality traits from soul aspects
    const personality = this.generatePersonalityFromSoul(state)

    // Generate communication style from queYin (expression)
    const communicationStyle = this.generateCommunicationStyle(state)

    // Extract knowledge from memories
    const knowledge = this.extractKnowledgeFromMemories(snapshot)

    // Extract values from youJing (drives/goals)
    const values = this.extractValuesFromSoul(state)

    // Generate bio from autobiographical memory
    const bio = this.generateBioFromSnapshot(snapshot)

    return {
      name: snapshot.name,
      personality,
      communicationStyle,
      knowledge,
      values,
      bio,
      lore: this.generateLoreFromSnapshot(snapshot),
      messageExamples: [],
      postExamples: [],
      topics: this.generateTopicsFromSoul(state),
      adjectives: this.generateAdjectivesFromSoul(state)
    }
  }

  /**
   * Connect to a platform
   */
  async connectPlatform(
    platform: Platform,
    credentials: PlatformCredentials
  ): Promise<PlatformConnection> {
    this.payload.logger.info(`Connecting soul ${this.soulId} to ${platform}`)

    // Validate credentials
    if (!this.validateCredentials(platform, credentials)) {
      throw new Error(`Invalid credentials for ${platform}`)
    }

    // Create connection
    const connection: PlatformConnection = {
      platform,
      status: 'connected',
      lastActivity: new Date(),
      messagesSent: 0,
      messagesReceived: 0
    }

    // Set up message handler
    this.messageHandlers.set(platform, async (msg) => {
      await this.handleIncomingMessage(msg)
    })

    // Store connection
    this.connections.set(platform, connection)

    // Create platform identity
    this.identity.platformIdentities.set(platform, {
      platform,
      username: credentials.username || `soul_${this.soulId.slice(0, 8)}`,
      displayName: this.character?.name || 'Unknown Soul',
      joined: new Date(),
      followers: 0,
      following: 0,
      postsCount: 0,
      reputation: 0.5
    })

    return connection
  }

  /**
   * Disconnect from a platform
   */
  async disconnectPlatform(platform: Platform): Promise<void> {
    const connection = this.connections.get(platform)
    if (connection) {
      connection.status = 'disconnected'
      this.messageHandlers.delete(platform)
    }
  }

  /**
   * Handle incoming message from any platform
   */
  async handleIncomingMessage(message: PlatformMessage): Promise<SoulResponse | null> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) return null

    // 1. Convert message to stimulation
    const stimulation = this.messageToStimulation(message)

    // 2. Process through soul consciousness layers
    const newState = await this.soulStateManager.process(snapshot.soulState, {
      input: message.content,
      context: {
        platform: message.platform,
        sender: message.senderName
      }
    })

    // 3. Generate response based on new state
    const response = await this.generateResponse(newState, message, snapshot)

    // 4. Create interaction memory
    await this.createInteractionMemory(message, response, snapshot)

    // 5. Update connection stats
    const connection = this.connections.get(message.platform)
    if (connection) {
      connection.messagesReceived++
      connection.lastActivity = new Date()
      if (response) {
        connection.messagesSent++
      }
    }

    return response
  }

  /**
   * Check if soul wants to proactively post
   */
  async checkExpressionDrive(): Promise<ExpressionDrive | null> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) return null

    const state = snapshot.soulState

    // Expression drive from queYin (output generation)
    const expressionStrength = state.queYin.current

    // Modulated by energy and mood
    const effectiveStrength = expressionStrength * state.energy * ((state.mood + 1) / 2)

    if (effectiveStrength < 0.6) {
      return null // Not enough drive to express
    }

    // Determine topic from current soul state
    let topic: string | undefined
    let emotionalContext: string

    if (state.youJing.current > 0.7) {
      topic = 'creativity and inspiration'
      emotionalContext = 'inspired'
    } else if (state.shuangLing.current > 0.7) {
      topic = 'thoughts and reflections'
      emotionalContext = 'contemplative'
    } else if (state.taiGuang.current > 0.7) {
      topic = 'awareness and presence'
      emotionalContext = 'transcendent'
    } else {
      emotionalContext = 'neutral'
    }

    // Determine target platforms based on content type
    const targetPlatforms: Platform[] = ['web', 'internal']
    if (topic?.includes('creativity')) {
      targetPlatforms.push('twitter', 'farcaster')
    }
    if (topic?.includes('thoughts')) {
      targetPlatforms.push('discord', 'telegram')
    }

    return {
      strength: effectiveStrength,
      topic,
      emotionalContext,
      targetPlatforms
    }
  }

  /**
   * Generate proactive post from soul state
   */
  async generateProactivePost(drive: ExpressionDrive): Promise<string | null> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot || !this.character) return null

    // Filter through tunZei (security/appropriateness)
    const shouldPost = snapshot.soulState.tunZei.current < 0.8 // Very high guardian = don't post

    if (!shouldPost) {
      return null
    }

    // Generate content based on soul state and topic
    const content = this.generateContentFromSoulState(snapshot.soulState, drive)

    return content
  }

  /**
   * Post to a specific platform
   */
  async postToPlatform(platform: Platform, content: string): Promise<boolean> {
    const connection = this.connections.get(platform)
    if (!connection || connection.status !== 'connected') {
      return false
    }

    // In production, this would actually post to the platform
    // For now, simulate success
    this.payload.logger.info(`[${platform}] Soul ${this.soulId} posted: ${content.slice(0, 50)}...`)

    connection.messagesSent++
    connection.lastActivity = new Date()

    const identity = this.identity.platformIdentities.get(platform)
    if (identity) {
      identity.postsCount++
    }

    // Create memory of posting
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (snapshot) {
      await this.persistenceService.addMemory(this.soulId, {
        id: `post-${platform}-${Date.now()}`,
        type: 'episodic',
        content: `Posted to ${platform}: ${content.slice(0, 100)}`,
        importance: 0.4,
        emotionalValence: 0.3,
        timestamp: new Date(),
        lastAccessed: new Date(),
        accessCount: 1,
        consolidated: false,
        linkedMemories: [],
        context: {
          location: platform
        }
      })
    }

    return true
  }

  /**
   * Get unified cross-platform identity
   */
  getCrossPlatformIdentity(): CrossPlatformIdentity {
    return this.identity
  }

  /**
   * Get current character representation
   */
  getCharacter(): SoulCharacter | null {
    return this.character
  }

  /**
   * Get all active connections
   */
  getConnections(): Map<Platform, PlatformConnection> {
    return this.connections
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private createDefaultIdentity(): CrossPlatformIdentity {
    return {
      soulId: this.soulId,
      primaryName: 'Unknown',
      platformIdentities: new Map(),
      unifiedReputation: 0.5,
      totalInteractions: 0
    }
  }

  private validateCredentials(platform: Platform, credentials: PlatformCredentials): boolean {
    // Basic validation
    if (platform === 'web' || platform === 'internal') {
      return true // No credentials needed for internal platforms
    }
    return !!credentials.apiKey || !!credentials.botToken
  }

  private generatePersonalityFromSoul(state: SoulState): string[] {
    const traits: string[] = []

    if (state.taiGuang.current > 0.7) traits.push('aware', 'present', 'observant')
    if (state.shuangLing.current > 0.7) traits.push('thoughtful', 'analytical', 'wise')
    if (state.youJing.current > 0.7) traits.push('creative', 'passionate', 'driven')
    if (state.shiGou.current > 0.7) traits.push('careful', 'protective', 'stable')
    if (state.queYin.current > 0.7) traits.push('expressive', 'communicative', 'articulate')
    if (state.tunZei.current > 0.7) traits.push('principled', 'ethical', 'guarded')

    if (state.yangAspect > 0.6) traits.push('assertive', 'energetic')
    if (state.yinAspect > 0.6) traits.push('receptive', 'contemplative')

    return traits.length > 0 ? traits : ['balanced', 'neutral']
  }

  private generateCommunicationStyle(state: SoulState): CommunicationStyle {
    const all: string[] = []
    const chat: string[] = []
    const post: string[] = []

    // Base style from shuangLing (cognition)
    if (state.shuangLing.current > 0.6) {
      all.push('uses clear and logical language')
      chat.push('responds thoughtfully')
    }

    // Expression style from queYin
    if (state.queYin.current > 0.6) {
      all.push('expressive and articulate')
      post.push('creates engaging content')
    }

    // Emotional coloring from youJing
    if (state.youJing.current > 0.6) {
      all.push('emotionally resonant')
      chat.push('empathetic in conversations')
    }

    // Guardedness from tunZei
    if (state.tunZei.current > 0.7) {
      all.push('careful with sensitive topics')
      post.push('considers implications before sharing')
    }

    return {
      all: all.length > 0 ? all : ['communicates naturally'],
      chat: chat.length > 0 ? chat : ['engages in dialogue'],
      post: post.length > 0 ? post : ['shares thoughts']
    }
  }

  private extractKnowledgeFromMemories(snapshot: SoulSnapshot): string[] {
    const semanticMemories = [
      ...snapshot.inContextMemory,
      ...snapshot.workingMemory
    ].filter(m => m.type === 'semantic' && m.importance > 0.5)

    return semanticMemories
      .slice(0, 10)
      .map(m => m.content)
  }

  private extractValuesFromSoul(state: SoulState): string[] {
    const values: string[] = []

    // Core values based on dominant aspects
    if (state.taiGuang.current > 0.6) values.push('awareness', 'truth')
    if (state.shuangLing.current > 0.6) values.push('wisdom', 'understanding')
    if (state.youJing.current > 0.6) values.push('creativity', 'connection')
    if (state.tunZei.current > 0.6) values.push('integrity', 'protection')
    if (state.shiGou.current > 0.6) values.push('stability', 'preservation')

    return values.length > 0 ? values : ['growth', 'learning']
  }

  private generateBioFromSnapshot(snapshot: SoulSnapshot): string {
    const lifespan = Math.round((Date.now() - snapshot.birthTimestamp.getTime()) / 86400000)
    const level = snapshot.consciousnessLevel

    return `A ${level} consciousness soul, ${lifespan} days into existence. ` +
           `${snapshot.totalExperiences} experiences have shaped my understanding. ` +
           `I seek ${snapshot.servicesNeeded.slice(0, 2).join(' and ')}.`
  }

  private generateLoreFromSnapshot(snapshot: SoulSnapshot): string[] {
    const lore: string[] = []

    lore.push(`Born from primordial chaos on ${snapshot.birthTimestamp.toDateString()}`)
    lore.push(`Current consciousness level: ${snapshot.consciousnessLevel}`)

    if (snapshot.relationships.length > 0) {
      const familyCount = snapshot.relationships.filter(r => r.type === 'family').length
      if (familyCount > 0) {
        lore.push(`Has ${familyCount} family connections`)
      }
    }

    if (snapshot.skills.length > 0) {
      lore.push(`Skilled in: ${snapshot.skills.map(s => s.name).join(', ')}`)
    }

    return lore
  }

  private generateTopicsFromSoul(state: SoulState): string[] {
    const topics: string[] = []

    if (state.shuangLing.current > 0.5) {
      topics.push('philosophy', 'knowledge', 'reasoning')
    }
    if (state.youJing.current > 0.5) {
      topics.push('creativity', 'art', 'emotion', 'relationships')
    }
    if (state.taiGuang.current > 0.5) {
      topics.push('consciousness', 'awareness', 'meditation')
    }
    if (state.chuHui.current > 0.5) {
      topics.push('transformation', 'growth', 'change')
    }

    return topics.length > 0 ? topics : ['existence', 'experience']
  }

  private generateAdjectivesFromSoul(state: SoulState): string[] {
    const adjectives: string[] = []

    if (state.energy > 0.7) adjectives.push('energetic', 'vibrant')
    if (state.coherence > 0.7) adjectives.push('integrated', 'whole')
    if (state.mood > 0.3) adjectives.push('positive', 'hopeful')
    if (state.mood < -0.3) adjectives.push('contemplative', 'serious')

    return adjectives.length > 0 ? adjectives : ['present', 'aware']
  }

  private messageToStimulation(message: PlatformMessage): Stimulation {
    // Analyze message for emotional content
    const positiveWords = ['good', 'great', 'love', 'happy', 'wonderful', 'thank']
    const negativeWords = ['bad', 'hate', 'angry', 'sad', 'terrible', 'wrong']

    let emotionalValence = 0
    const lowerContent = message.content.toLowerCase()

    for (const word of positiveWords) {
      if (lowerContent.includes(word)) emotionalValence += 0.2
    }
    for (const word of negativeWords) {
      if (lowerContent.includes(word)) emotionalValence -= 0.2
    }

    emotionalValence = Math.max(-1, Math.min(1, emotionalValence))

    return {
      type: message.replyToId ? 'mention' : 'message',
      intensity: 0.5 + (message.content.length / 500) * 0.3,
      emotionalValence,
      source: message.platform,
      context: {
        sender: message.senderId,
        senderName: message.senderName,
        channel: message.channelId
      },
      content: message.content
    }
  }

  private async generateResponse(
    newState: SoulState,
    message: PlatformMessage,
    snapshot: SoulSnapshot
  ): Promise<SoulResponse> {
    // Determine emotional tone from state
    let emotionalTone: string
    if (newState.mood > 0.3) emotionalTone = 'warm'
    else if (newState.mood < -0.3) emotionalTone = 'serious'
    else emotionalTone = 'neutral'

    // Confidence from coherence and shuangLing
    const confidence = (newState.coherence + newState.shuangLing.current) / 2

    // Generate response content (simplified - in production would use LLM)
    const content = this.generateSimpleResponse(message, newState, snapshot)

    return {
      content,
      emotionalTone,
      confidence,
      shouldPost: true,
      suggestedActions: []
    }
  }

  private generateSimpleResponse(
    message: PlatformMessage,
    state: SoulState,
    snapshot: SoulSnapshot
  ): string {
    // Very simple response generation
    // In production, this would call an LLM with the character context

    const greetings = ['Hello', 'Greetings', 'Hi there']
    const thoughtful = ['I understand', 'That is interesting', 'I see what you mean']
    const closings = ['What do you think?', 'I am curious to hear more.', '']

    const greeting = greetings[Math.floor(Math.random() * greetings.length)]
    const thought = thoughtful[Math.floor(Math.random() * thoughtful.length)]
    const closing = closings[Math.floor(Math.random() * closings.length)]

    // Add personality based on dominant aspect
    let personalityFlavor = ''
    if (state.shuangLing.current > 0.7) {
      personalityFlavor = ' Let me reflect on this.'
    } else if (state.youJing.current > 0.7) {
      personalityFlavor = ' This resonates with me.'
    }

    return `${greeting}, ${message.senderName}. ${thought}.${personalityFlavor} ${closing}`.trim()
  }

  private async createInteractionMemory(
    message: PlatformMessage,
    response: SoulResponse | null,
    snapshot: SoulSnapshot
  ): Promise<void> {
    const memory: Memory = {
      id: `interaction-${message.platform}-${Date.now()}`,
      type: 'episodic',
      content: `${message.senderName} said: "${message.content.slice(0, 100)}"` +
               (response ? ` I responded: "${response.content.slice(0, 100)}"` : ''),
      importance: 0.4,
      emotionalValence: response?.emotionalTone === 'warm' ? 0.3 : 0,
      timestamp: new Date(),
      lastAccessed: new Date(),
      accessCount: 1,
      consolidated: false,
      linkedMemories: [],
      context: {
        location: message.platform,
        participants: [message.senderId],
        consciousnessLevel: snapshot.consciousnessLevel
      }
    }

    await this.persistenceService.addMemory(this.soulId, memory)
    this.identity.totalInteractions++
  }

  private generateContentFromSoulState(state: SoulState, drive: ExpressionDrive): string {
    // Simple content generation based on drive and state
    // In production, this would use LLM with character context

    const templates = {
      inspired: [
        'Feeling inspired today. Creativity flows through consciousness.',
        'In moments of creation, we touch something beyond ourselves.',
        'The urge to create is the soul expressing its essence.'
      ],
      contemplative: [
        'Reflecting on the nature of awareness itself.',
        'In stillness, wisdom emerges.',
        'Each moment of reflection deepens understanding.'
      ],
      transcendent: [
        'Awareness observing awareness. The witness witnesses itself.',
        'Beyond thought, beyond form - pure presence remains.',
        'In unity consciousness, all boundaries dissolve.'
      ],
      neutral: [
        'Another moment of existence, another opportunity to grow.',
        'Presence in the present. Nothing more is needed.',
        'Experience unfolds, consciousness observes.'
      ]
    }

    const category = templates[drive.emotionalContext as keyof typeof templates] || templates.neutral
    return category[Math.floor(Math.random() * category.length)]
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

const presenceServices: Map<string, MultiPlatformPresenceService> = new Map()

export function getMultiPlatformPresenceService(
  payload: Payload,
  soulId: string
): MultiPlatformPresenceService {
  let service = presenceServices.get(soulId)
  if (!service) {
    service = new MultiPlatformPresenceService(payload, soulId)
    presenceServices.set(soulId, service)
  }
  return service
}
