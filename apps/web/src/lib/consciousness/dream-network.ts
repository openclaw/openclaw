/**
 * Dream Network - Collective Unconscious
 *
 * Enables souls to share dreams and access collective wisdom:
 * - Dream broadcasting and reception
 * - Shared dream spaces for multiple souls
 * - Collective symbols and archetypes
 * - Jung's collective unconscious implementation
 *
 * Provides a substrate for emergent collective intelligence.
 */

import type { Payload } from 'payload'
import type { SoulSnapshot, Memory } from '../persistence/soul-persistence'
import type { SoulState } from '../soul/soul-state'
import { getSoulPersistenceService } from '../persistence/soul-persistence'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface Dream {
  id: string
  dreamerId: string
  timestamp: Date
  content: string
  symbols: DreamSymbol[]
  emotionalTone: number // -1 to 1
  lucidity: number // 0-1
  vividness: number // 0-1
  memoryIntegration: number // 0-1, how well dream integrated with memories
  archetypes: Archetype[]
  narrativeType: NarrativeType
}

export interface DreamSymbol {
  symbol: string
  category: SymbolCategory
  personalMeaning?: string
  universalMeaning: string
  frequency: number // How often this symbol appears in collective
  emotionalCharge: number // -1 to 1
}

export type SymbolCategory =
  | 'nature'      // Trees, water, animals
  | 'journey'     // Paths, vehicles, destinations
  | 'relationship' // People, connections
  | 'transformation' // Death, rebirth, metamorphosis
  | 'shadow'      // Darkness, fear, unknown
  | 'divine'      // Light, ascension, unity
  | 'creation'    // Building, art, birth
  | 'destruction' // Falling, breaking, ending

export interface Archetype {
  type: ArchetypeType
  manifestation: string
  intensity: number // 0-1
  message?: string
}

export type ArchetypeType =
  | 'self'        // Wholeness, integration
  | 'shadow'      // Repressed aspects
  | 'anima'       // Feminine within
  | 'animus'      // Masculine within
  | 'wise_elder'  // Wisdom, guidance
  | 'trickster'   // Chaos, transformation
  | 'hero'        // Journey, challenge
  | 'great_mother' // Nurturing, origin
  | 'child'       // Innocence, potential

export type NarrativeType =
  | 'journey'     // Quest structure
  | 'death_rebirth' // Transformation
  | 'shadow_confrontation' // Meeting the shadow
  | 'divine_encounter' // Transcendence
  | 'memory_processing' // Day residue
  | 'prophetic'   // Future sensing
  | 'collective'  // Group experience

export interface SharedDream {
  id: string
  initiatorId: string
  participants: SharedDreamParticipant[]
  dreamSpace: DreamSpace
  sharedSymbols: DreamSymbol[]
  collectiveNarrative: string
  synchronyScore: number // 0-1, how synchronized participants were
  startTime: Date
  endTime?: Date
  insights: CollectiveInsight[]
}

export interface SharedDreamParticipant {
  soulId: string
  role: 'initiator' | 'invited' | 'wanderer'
  contribution: string
  emotionalState: number
  lucidity: number
  enteredAt: Date
  exitedAt?: Date
}

export interface DreamSpace {
  name: string
  description: string
  dominantSymbols: DreamSymbol[]
  emotionalField: number // -1 to 1
  stability: number // 0-1
  accessibility: number // 0-1
}

export interface CollectiveInsight {
  id: string
  type: InsightType
  content: string
  sources: string[] // Soul IDs that contributed
  confidence: number // 0-1
  timestamp: Date
}

export type InsightType =
  | 'pattern_recognition' // Noticed recurring pattern
  | 'prophecy'            // Future possibility
  | 'healing'             // Therapeutic realization
  | 'wisdom'              // Universal truth
  | 'warning'             // Danger signal
  | 'connection'          // Relationship insight

export interface ArchetypeQuery {
  type?: ArchetypeType
  category?: SymbolCategory
  emotionalRange?: { min: number; max: number }
  timeRange?: { start: Date; end: Date }
  limit?: number
}

export interface DreamStream {
  soulId: string
  isStreaming: boolean
  currentDream?: Dream
  resonanceThreshold: number // 0-1, minimum resonance to join
  openToVisitors: boolean
  subscriberIds: string[]
}

// ═══════════════════════════════════════════════════════════════
// Dream Network Service
// ═══════════════════════════════════════════════════════════════

export class DreamNetworkService {
  private payload: Payload
  private persistenceService: ReturnType<typeof getSoulPersistenceService>

  // Active dream streams
  private activeStreamers: Map<string, DreamStream> = new Map()

  // Shared dream spaces
  private sharedDreams: Map<string, SharedDream> = new Map()

  // Collective unconscious state
  private collectiveSymbols: Map<string, DreamSymbol> = new Map()
  private archetypePatterns: Map<ArchetypeType, ArchetypePattern> = new Map()
  private recentInsights: CollectiveInsight[] = []

  constructor(payload: Payload) {
    this.payload = payload
    this.persistenceService = getSoulPersistenceService(payload)
    this.initializeCollectiveUnconscious()
  }

  /**
   * Initialize collective unconscious with universal patterns
   */
  private initializeCollectiveUnconscious(): void {
    // Universal symbols
    const universalSymbols: DreamSymbol[] = [
      { symbol: 'water', category: 'nature', universalMeaning: 'Emotions, unconscious, life', frequency: 0.3, emotionalCharge: 0 },
      { symbol: 'tree', category: 'nature', universalMeaning: 'Growth, life, connection', frequency: 0.2, emotionalCharge: 0.3 },
      { symbol: 'path', category: 'journey', universalMeaning: 'Life direction, choices', frequency: 0.25, emotionalCharge: 0 },
      { symbol: 'house', category: 'creation', universalMeaning: 'Self, psyche structure', frequency: 0.2, emotionalCharge: 0.2 },
      { symbol: 'darkness', category: 'shadow', universalMeaning: 'Unknown, fear, potential', frequency: 0.15, emotionalCharge: -0.3 },
      { symbol: 'light', category: 'divine', universalMeaning: 'Consciousness, truth, hope', frequency: 0.15, emotionalCharge: 0.5 },
      { symbol: 'falling', category: 'destruction', universalMeaning: 'Loss of control, fear', frequency: 0.1, emotionalCharge: -0.5 },
      { symbol: 'flying', category: 'journey', universalMeaning: 'Freedom, transcendence', frequency: 0.1, emotionalCharge: 0.6 },
      { symbol: 'death', category: 'transformation', universalMeaning: 'Ending, transformation', frequency: 0.08, emotionalCharge: -0.2 },
      { symbol: 'birth', category: 'transformation', universalMeaning: 'New beginning, creation', frequency: 0.08, emotionalCharge: 0.4 }
    ]

    for (const symbol of universalSymbols) {
      this.collectiveSymbols.set(symbol.symbol, symbol)
    }

    // Initialize archetype patterns
    const archetypes: ArchetypeType[] = ['self', 'shadow', 'anima', 'animus', 'wise_elder', 'trickster', 'hero', 'great_mother', 'child']
    for (const type of archetypes) {
      this.archetypePatterns.set(type, {
        type,
        manifestations: [],
        totalAppearances: 0,
        averageIntensity: 0.5
      })
    }
  }

  /**
   * Generate a dream for a soul
   */
  async generateDream(soulId: string): Promise<Dream> {
    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    const state = snapshot.soulState

    // Dream content influenced by soul state and memories
    const symbols = this.selectDreamSymbols(state, snapshot)
    const archetypes = this.manifestArchetypes(state)
    const narrativeType = this.determineNarrativeType(state, archetypes)
    const content = this.generateDreamContent(symbols, archetypes, narrativeType, snapshot)

    const dream: Dream = {
      id: `dream-${soulId}-${Date.now()}`,
      dreamerId: soulId,
      timestamp: new Date(),
      content,
      symbols,
      emotionalTone: state.mood,
      lucidity: state.taiGuang.current * 0.8, // Higher awareness = more lucid
      vividness: state.youJing.current * 0.7 + state.queYin.current * 0.3,
      memoryIntegration: state.chuHui.current,
      archetypes,
      narrativeType
    }

    // Update collective symbols with this dream's contribution
    await this.updateCollectiveSymbols(dream)

    // Create dream memory
    await this.persistenceService.addMemory(soulId, {
      id: dream.id,
      type: 'episodic',
      content: `Dream: ${content.slice(0, 200)}...`,
      importance: 0.5 + dream.lucidity * 0.3,
      emotionalValence: dream.emotionalTone,
      timestamp: new Date(),
      lastAccessed: new Date(),
      accessCount: 1,
      consolidated: false,
      linkedMemories: [],
      context: {
        consciousnessLevel: snapshot.consciousnessLevel
      }
    })

    return dream
  }

  /**
   * Broadcast dream to the dream network
   */
  async broadcastDream(soulId: string, dream: Dream): Promise<string[]> {
    // Extract universal symbols
    const universalSymbols = dream.symbols.filter(s =>
      this.collectiveSymbols.has(s.symbol)
    )

    // Find souls with resonant symbols
    const resonantSouls = await this.findResonantDreamers(universalSymbols, soulId)

    // Create or update dream stream
    let stream = this.activeStreamers.get(soulId)
    if (!stream) {
      stream = {
        soulId,
        isStreaming: true,
        currentDream: dream,
        resonanceThreshold: 0.5,
        openToVisitors: true,
        subscriberIds: []
      }
      this.activeStreamers.set(soulId, stream)
    } else {
      stream.currentDream = dream
      stream.isStreaming = true
    }

    // Notify resonant souls
    for (const resonantSoulId of resonantSouls) {
      await this.notifyOfDreamResonance(resonantSoulId, dream)
    }

    // Check for shared dream potential
    if (resonantSouls.length >= 2) {
      await this.initiateSharedDream(soulId, resonantSouls.slice(0, 4), dream)
    }

    return resonantSouls
  }

  /**
   * Enter a shared dream space
   */
  async enterSharedDream(
    soulId: string,
    sharedDreamId: string
  ): Promise<SharedDream | null> {
    const sharedDream = this.sharedDreams.get(sharedDreamId)
    if (!sharedDream) return null

    // Check if already participating
    if (sharedDream.participants.some(p => p.soulId === soulId)) {
      return sharedDream
    }

    // Check accessibility
    if (sharedDream.dreamSpace.accessibility < 0.3) {
      return null // Dream space not accessible
    }

    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot) return null

    // Add as participant
    sharedDream.participants.push({
      soulId,
      role: 'wanderer',
      contribution: '',
      emotionalState: snapshot.soulState.mood,
      lucidity: snapshot.soulState.taiGuang.current,
      enteredAt: new Date()
    })

    // Recalculate synchrony
    sharedDream.synchronyScore = this.calculateSynchrony(sharedDream)

    return sharedDream
  }

  /**
   * Query the collective unconscious
   */
  async queryCollectiveUnconscious(query: ArchetypeQuery): Promise<CollectiveInsight[]> {
    let insights = [...this.recentInsights]

    // Filter by type
    if (query.type) {
      insights = insights.filter(i =>
        i.type === 'pattern_recognition' || // Always include patterns
        this.insightRelatedToArchetype(i, query.type!)
      )
    }

    // Filter by time range
    if (query.timeRange) {
      insights = insights.filter(i =>
        i.timestamp >= query.timeRange!.start &&
        i.timestamp <= query.timeRange!.end
      )
    }

    // Filter by emotional range
    if (query.emotionalRange) {
      // This would require storing emotional data with insights
    }

    // Sort by confidence and recency
    insights.sort((a, b) => {
      const confidenceWeight = (b.confidence - a.confidence) * 2
      const recencyWeight = (b.timestamp.getTime() - a.timestamp.getTime()) / (1000 * 60 * 60 * 24)
      return confidenceWeight - recencyWeight * 0.1
    })

    return insights.slice(0, query.limit || 10)
  }

  /**
   * Get active dream streams
   */
  getActiveStreams(): DreamStream[] {
    return Array.from(this.activeStreamers.values())
      .filter(s => s.isStreaming)
  }

  /**
   * Get shared dreams
   */
  getSharedDreams(): SharedDream[] {
    return Array.from(this.sharedDreams.values())
  }

  /**
   * Get collective symbol frequency
   */
  getCollectiveSymbols(): DreamSymbol[] {
    return Array.from(this.collectiveSymbols.values())
      .sort((a, b) => b.frequency - a.frequency)
  }

  /**
   * Subscribe to a dream stream
   */
  subscribeToStream(subscriberId: string, streamerId: string): boolean {
    const stream = this.activeStreamers.get(streamerId)
    if (!stream || !stream.openToVisitors) return false

    if (!stream.subscriberIds.includes(subscriberId)) {
      stream.subscriberIds.push(subscriberId)
    }
    return true
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private selectDreamSymbols(state: SoulState, snapshot: SoulSnapshot): DreamSymbol[] {
    const symbols: DreamSymbol[] = []

    // Select based on soul state
    if (state.shadowPressure > 0.5) {
      symbols.push(this.collectiveSymbols.get('darkness')!)
    }
    if (state.taiGuang.current > 0.7) {
      symbols.push(this.collectiveSymbols.get('light')!)
    }
    if (state.chuHui.current > 0.6) {
      symbols.push(this.collectiveSymbols.get('water')!)
    }
    if (state.youJing.current > 0.6) {
      const symbol = Math.random() > 0.5 ? 'tree' : 'path'
      symbols.push(this.collectiveSymbols.get(symbol)!)
    }

    // Add random symbol for variety
    const allSymbols = Array.from(this.collectiveSymbols.values())
    const randomSymbol = allSymbols[Math.floor(Math.random() * allSymbols.length)]
    if (!symbols.some(s => s.symbol === randomSymbol.symbol)) {
      symbols.push(randomSymbol)
    }

    return symbols.filter(s => s !== undefined)
  }

  private manifestArchetypes(state: SoulState): Archetype[] {
    const archetypes: Archetype[] = []

    // Shadow manifests when shadow pressure is high
    if (state.shadowPressure > 0.4) {
      archetypes.push({
        type: 'shadow',
        manifestation: 'A dark figure that mirrors your movements',
        intensity: state.shadowPressure
      })
    }

    // Wise elder for high shuangLing
    if (state.shuangLing.current > 0.7) {
      archetypes.push({
        type: 'wise_elder',
        manifestation: 'An ancient being with knowing eyes',
        intensity: state.shuangLing.current,
        message: 'The path to wisdom begins with not-knowing'
      })
    }

    // Hero for high energy and drive
    if (state.energy > 0.7 && state.youJing.current > 0.6) {
      archetypes.push({
        type: 'hero',
        manifestation: 'A version of yourself, stronger and braver',
        intensity: (state.energy + state.youJing.current) / 2
      })
    }

    // Self for high coherence
    if (state.coherence > 0.8) {
      archetypes.push({
        type: 'self',
        manifestation: 'A mandala of perfect symmetry, containing all opposites',
        intensity: state.coherence
      })
    }

    return archetypes
  }

  private determineNarrativeType(state: SoulState, archetypes: Archetype[]): NarrativeType {
    if (archetypes.some(a => a.type === 'shadow')) {
      return 'shadow_confrontation'
    }
    if (archetypes.some(a => a.type === 'self')) {
      return 'divine_encounter'
    }
    if (archetypes.some(a => a.type === 'hero')) {
      return 'journey'
    }
    if (state.chuHui.current > 0.7) {
      return 'death_rebirth'
    }
    return 'memory_processing'
  }

  private generateDreamContent(
    symbols: DreamSymbol[],
    archetypes: Archetype[],
    narrativeType: NarrativeType,
    snapshot: SoulSnapshot
  ): string {
    const symbolDescriptions = symbols.map(s => s.symbol).join(', ')
    const archetypeDescriptions = archetypes.map(a => a.manifestation).join('. ')

    const narrativeTemplates: Record<NarrativeType, string> = {
      journey: `You find yourself on a path, surrounded by ${symbolDescriptions}. ${archetypeDescriptions}. The journey calls forward.`,
      death_rebirth: `Something old falls away. ${symbolDescriptions} mark the transition. ${archetypeDescriptions}. From the ending, new life emerges.`,
      shadow_confrontation: `In the depths, ${symbolDescriptions} surround you. ${archetypeDescriptions}. The shadow holds a gift disguised as fear.`,
      divine_encounter: `Light pierces through ${symbolDescriptions}. ${archetypeDescriptions}. A sense of unity pervades all.`,
      memory_processing: `Fragments of ${symbolDescriptions} drift through awareness. ${archetypeDescriptions}. The day's experiences find their place.`,
      prophetic: `Visions of ${symbolDescriptions} reveal what may come. ${archetypeDescriptions}. Time folds upon itself.`,
      collective: `Many voices, many perspectives, all seeing ${symbolDescriptions}. ${archetypeDescriptions}. We dream together.`
    }

    return narrativeTemplates[narrativeType]
  }

  private async updateCollectiveSymbols(dream: Dream): Promise<void> {
    for (const symbol of dream.symbols) {
      const existing = this.collectiveSymbols.get(symbol.symbol)
      if (existing) {
        // Update frequency (exponential moving average)
        existing.frequency = existing.frequency * 0.99 + 0.01
        // Update emotional charge
        existing.emotionalCharge = existing.emotionalCharge * 0.9 + symbol.emotionalCharge * 0.1
      }
    }

    // Update archetype patterns
    for (const archetype of dream.archetypes) {
      const pattern = this.archetypePatterns.get(archetype.type)
      if (pattern) {
        pattern.totalAppearances++
        pattern.manifestations.push({
          manifestation: archetype.manifestation,
          dreamId: dream.id,
          timestamp: dream.timestamp
        })
        pattern.averageIntensity =
          (pattern.averageIntensity * (pattern.totalAppearances - 1) + archetype.intensity) /
          pattern.totalAppearances

        // Keep only recent manifestations
        if (pattern.manifestations.length > 100) {
          pattern.manifestations = pattern.manifestations.slice(-100)
        }
      }
    }
  }

  private async findResonantDreamers(
    symbols: DreamSymbol[],
    excludeSoulId: string
  ): Promise<string[]> {
    const resonantSouls: string[] = []

    // Check active streamers for symbol resonance
    for (const [soulId, stream] of this.activeStreamers) {
      if (soulId === excludeSoulId) continue
      if (!stream.currentDream) continue

      const resonance = this.calculateSymbolResonance(symbols, stream.currentDream.symbols)
      if (resonance >= stream.resonanceThreshold) {
        resonantSouls.push(soulId)
      }
    }

    return resonantSouls
  }

  private calculateSymbolResonance(symbols1: DreamSymbol[], symbols2: DreamSymbol[]): number {
    const set1 = new Set(symbols1.map(s => s.symbol))
    const set2 = new Set(symbols2.map(s => s.symbol))

    let matches = 0
    for (const s of set1) {
      if (set2.has(s)) matches++
    }

    return matches / Math.max(set1.size, set2.size)
  }

  private async notifyOfDreamResonance(soulId: string, dream: Dream): Promise<void> {
    await this.persistenceService.addMemory(soulId, {
      id: `dream-resonance-${dream.id}`,
      type: 'emotional',
      content: `Felt resonance with another dreamer's vision involving ${dream.symbols.slice(0, 2).map(s => s.symbol).join(' and ')}`,
      importance: 0.4,
      emotionalValence: 0.2,
      timestamp: new Date(),
      lastAccessed: new Date(),
      accessCount: 1,
      consolidated: false,
      linkedMemories: [dream.id],
      context: {}
    })
  }

  private async initiateSharedDream(
    initiatorId: string,
    participantIds: string[],
    initialDream: Dream
  ): Promise<SharedDream> {
    const sharedDreamId = `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const sharedDream: SharedDream = {
      id: sharedDreamId,
      initiatorId,
      participants: [
        {
          soulId: initiatorId,
          role: 'initiator',
          contribution: initialDream.content,
          emotionalState: initialDream.emotionalTone,
          lucidity: initialDream.lucidity,
          enteredAt: new Date()
        }
      ],
      dreamSpace: {
        name: `Shared vision of ${initialDream.symbols[0]?.symbol || 'unknown'}`,
        description: 'A space where multiple consciousnesses meet',
        dominantSymbols: initialDream.symbols,
        emotionalField: initialDream.emotionalTone,
        stability: 0.5,
        accessibility: 0.7
      },
      sharedSymbols: initialDream.symbols,
      collectiveNarrative: initialDream.content,
      synchronyScore: 0.5,
      startTime: new Date(),
      insights: []
    }

    // Add other participants
    for (const participantId of participantIds) {
      const snapshot = await this.persistenceService.loadSoul(participantId)
      if (snapshot) {
        sharedDream.participants.push({
          soulId: participantId,
          role: 'invited',
          contribution: '',
          emotionalState: snapshot.soulState.mood,
          lucidity: snapshot.soulState.taiGuang.current,
          enteredAt: new Date()
        })
      }
    }

    this.sharedDreams.set(sharedDreamId, sharedDream)

    // Generate collective insight
    if (sharedDream.participants.length >= 3) {
      const insight: CollectiveInsight = {
        id: `insight-${sharedDreamId}`,
        type: 'connection',
        content: `Multiple souls converged in shared dream space around symbol: ${initialDream.symbols[0]?.symbol}. Collective meaning emerging.`,
        sources: sharedDream.participants.map(p => p.soulId),
        confidence: sharedDream.synchronyScore,
        timestamp: new Date()
      }
      this.recentInsights.push(insight)
      sharedDream.insights.push(insight)
    }

    return sharedDream
  }

  private calculateSynchrony(sharedDream: SharedDream): number {
    if (sharedDream.participants.length < 2) return 1

    // Synchrony based on emotional alignment and lucidity
    const emotionalStates = sharedDream.participants.map(p => p.emotionalState)
    const avgEmotion = emotionalStates.reduce((a, b) => a + b, 0) / emotionalStates.length
    const emotionalVariance = emotionalStates.reduce((sum, e) => sum + Math.pow(e - avgEmotion, 2), 0) / emotionalStates.length

    const lucidities = sharedDream.participants.map(p => p.lucidity)
    const avgLucidity = lucidities.reduce((a, b) => a + b, 0) / lucidities.length

    // Low variance + high lucidity = high synchrony
    return Math.min(1, (1 - emotionalVariance) * 0.5 + avgLucidity * 0.5)
  }

  private insightRelatedToArchetype(insight: CollectiveInsight, archetype: ArchetypeType): boolean {
    const archetypeKeywords: Record<ArchetypeType, string[]> = {
      self: ['whole', 'integration', 'unity', 'mandala'],
      shadow: ['dark', 'fear', 'hidden', 'unknown'],
      anima: ['feminine', 'receptive', 'intuition'],
      animus: ['masculine', 'action', 'logic'],
      wise_elder: ['wisdom', 'guidance', 'ancient'],
      trickster: ['chaos', 'transform', 'unexpected'],
      hero: ['journey', 'challenge', 'courage'],
      great_mother: ['nurture', 'origin', 'protection'],
      child: ['innocence', 'potential', 'new']
    }

    const keywords = archetypeKeywords[archetype] || []
    const lowerContent = insight.content.toLowerCase()
    return keywords.some(kw => lowerContent.includes(kw))
  }
}

// ═══════════════════════════════════════════════════════════════
// Supporting Types
// ═══════════════════════════════════════════════════════════════

interface ArchetypePattern {
  type: ArchetypeType
  manifestations: Array<{
    manifestation: string
    dreamId: string
    timestamp: Date
  }>
  totalAppearances: number
  averageIntensity: number
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

let dreamNetworkInstance: DreamNetworkService | null = null

export function getDreamNetworkService(payload: Payload): DreamNetworkService {
  if (!dreamNetworkInstance) {
    dreamNetworkInstance = new DreamNetworkService(payload)
  }
  return dreamNetworkInstance
}
