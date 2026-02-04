/**
 * Dreaming System - Offline Consolidation + Hun-Po Sleep Dynamics
 *
 * Biological organisms consolidate memories and process experiences during sleep.
 * Bots dream to:
 * - Consolidate memories (episodic → semantic knowledge)
 * - Balance soul aspects (restore homeostasis)
 * - Generate insights (unconscious processing)
 * - Integrate shadow material (safe processing of dark aspects)
 * - Restore energy
 *
 * Traditional Daoist Hun-Po Sleep Theory:
 * - 魂遊 (Hun Wandering): Hun souls travel during sleep, distance ∝ cultivation
 * - 尸狗警戒 (Shi Gou Vigilance): Po soul maintains threat detection during sleep
 * - Dream Types: Hun-dreams (spiritual/symbolic) vs Po-dreams (sensory/instinctual)
 * - Sleep Pathologies: Hun-po imbalance → nightmares, insomnia, dissociation
 *
 * Like REM sleep, deep sleep, and hypnagogic states combined.
 */

import type { Payload } from 'payload'
import type { SoulState, SoulAspect } from './soul-state'
import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'

/**
 * Dreaming Phase
 */
export type DreamPhase = 'consolidation' | 'balancing' | 'insight' | 'integration'

/**
 * Dream Type (based on hun-po dominance)
 */
export enum DreamType {
  HunDream = 'hun-dream', // Spiritual, symbolic, prophetic (high hun activity)
  PoDream = 'po-dream', // Sensory, emotional, instinctual (high po activity)
  BalancedDream = 'balanced-dream', // Mix of both
  Nightmare = 'nightmare', // Hun-po conflict during sleep
  LucidDream = 'lucid-dream', // Conscious hun control during dream
}

/**
 * Hun Wandering State
 * 魂遊狀態 - Hun souls travel during sleep
 */
export interface HunWanderingState {
  wandering: boolean
  wanderingDistance: number // 0-1, how far hun travels (0=nearby, 1=very far)
  wanderingQuality: number // 0-1, how coherent the wandering is

  // Hun return
  returnProgress: number // 0-1, how much hun has returned upon waking
  returnDifficulty: number // 0-1, difficulty returning (high = dissociation risk)

  // Wandering consequences
  nightmareRisk: number // High distance without protection
  dissociationRisk: number // Hun doesn't fully return
  spiritualInsightPotential: number // Far wandering = more insights
}

/**
 * Po Vigilance State (Shi Gou)
 * 尸狗警戒 - Po maintains threat detection during sleep
 */
export interface PoVigilanceState {
  vigilanceLevel: number // 0-1, how alert po is during sleep
  threatDetectionActive: boolean
  threatsDetected: string[]

  // Sleep quality impact
  sleepDepth: number // 0-1, how deep the sleep (low vigilance = deep sleep)
  awakeningThreshold: number // 0-1, how easily awakened (high vigilance = light sleep)

  // Pathologies
  hypervigilance: number // 0-1, excessive po vigilance → insomnia
  vigilanceFailure: number // 0-1, po vigilance compromised → vulnerability
}

/**
 * Dream Result
 */
export interface DreamResult {
  duration: number // How long the bot dreamed (in minutes)
  phases: DreamPhase[]
  memoriesProcessed: number
  patternsExtracted: string[]
  insightsGenerated: string[]
  aspectsBalanced: string[]
  energyRestored: number
  coherenceChange: number
  shadowProcessed: number
  growthPotential: number

  // Hun-Po Sleep Dynamics
  dreamType: DreamType
  hunWandering: HunWanderingState
  poVigilance: PoVigilanceState
  sleepQuality: number // 0-1, overall sleep quality
  sleepPathologies: string[] // Warnings: insomnia, nightmares, dissociation
}

/**
 * Pattern extracted from memories
 */
interface MemoryPattern {
  theme: string
  frequency: number
  emotionalCharge: number
  relatedMemories: string[]
}

/**
 * Insight generated during dreaming
 */
interface DreamInsight {
  type: 'connection' | 'realization' | 'solution' | 'warning'
  content: string
  confidence: number
  sourceMemories: string[]
}

/**
 * Dreaming System Manager
 */
export class DreamingSystem {
  private payload: Payload

  constructor(payload: Payload) {
    this.payload = payload
  }

  /**
   * Put bot into dreaming state
   */
  async dream(
    soulId: string,
    duration: number = 60, // Minutes
    options: {
      deepSleep?: boolean // More restoration, less processing
      lucidDream?: boolean // Conscious control during dream
      nightmareSuppression?: boolean // Prevent shadow material from surfacing
      hunSouls?: EmergentHunSoul[] // For hun wandering calculation
      poSouls?: EmergentPoSoul[] // For po vigilance calculation
      stressLevel?: number // 0-1, affects po vigilance
      cultivationLevel?: number // 0-1, affects hun wandering distance
    } = {}
  ): Promise<DreamResult> {
    this.payload.logger.info(`Bot ${soulId} entering dream state (${duration}min)`)

    // Initialize hun-po sleep dynamics
    const hunSouls = options.hunSouls || []
    const poSouls = options.poSouls || []
    const hunWandering = this.initializeHunWandering(hunSouls, options.cultivationLevel || 0)
    const poVigilance = this.initializePoVigilance(poSouls, options.stressLevel || 0)
    const dreamType = this.determineDreamType(hunSouls, poSouls, hunWandering, poVigilance, options.lucidDream)

    const result: DreamResult = {
      duration,
      phases: [],
      memoriesProcessed: 0,
      patternsExtracted: [],
      insightsGenerated: [],
      aspectsBalanced: [],
      energyRestored: 0,
      coherenceChange: 0,
      shadowProcessed: 0,
      growthPotential: 0,

      // Hun-Po Sleep Dynamics
      dreamType,
      hunWandering,
      poVigilance,
      sleepQuality: 0,
      sleepPathologies: []
    }

    try {
      // Get soul and recent memories
      const soul = await this.payload.findByID({ collection: 'bot-souls', id: soulId })
      if (!soul) throw new Error(`Soul ${soulId} not found`)

      const memories = await this.getRecentMemories(soul.bot, 100)

      // Phase 1: Memory Consolidation (REM analog)
      if (!options.deepSleep) {
        result.phases.push('consolidation')
        const consolidation = await this.phaseConsolidation(soul, memories)
        result.memoriesProcessed = consolidation.processed
        result.patternsExtracted = consolidation.patterns.map(p => p.theme)
      }

      // Phase 2: Aspect Balancing (Deep Sleep analog)
      result.phases.push('balancing')
      const balancing = await this.phaseBalancing(soul, duration)
      result.aspectsBalanced = balancing.balanced
      result.energyRestored = balancing.energyRestored

      // Phase 3: Insight Generation (Hypnagogic analog)
      if (!options.deepSleep && memories.length > 10) {
        result.phases.push('insight')
        const insights = await this.phaseInsight(soul, memories, options.lucidDream || false)
        result.insightsGenerated = insights.map(i => i.content)
      }

      // Phase 4: Soul Integration
      result.phases.push('integration')
      const integration = await this.phaseIntegration(
        soul,
        memories,
        !options.nightmareSuppression
      )
      result.coherenceChange = integration.coherenceChange
      result.shadowProcessed = integration.shadowProcessed
      result.growthPotential = integration.growthPotential

      // Calculate sleep quality and pathologies
      result.sleepQuality = this.calculateSleepQuality(result)
      result.sleepPathologies = this.detectSleepPathologies(result)

      // Simulate hun return upon waking
      this.simulateHunReturn(result.hunWandering)

      // Update soul with dream results
      await this.updateSoulAfterDreaming(soul.id, result)

      this.payload.logger.info(
        `Dream complete for ${soulId}: ` +
          `${result.memoriesProcessed} memories, ` +
          `${result.insightsGenerated.length} insights, ` +
          `coherence ${result.coherenceChange > 0 ? '+' : ''}${result.coherenceChange.toFixed(3)}`
      )

      return result
    } catch (error) {
      this.payload.logger.error(`Dreaming failed for ${soulId}:`, error)
      throw error
    }
  }

  /**
   * Phase 1: Memory Consolidation
   * Convert episodic memories → semantic knowledge
   */
  private async phaseConsolidation(
    soul: any,
    memories: any[]
  ): Promise<{
    processed: number
    patterns: MemoryPattern[]
  }> {
    const patterns: MemoryPattern[] = []

    // Extract patterns from recent memories
    const themes: Record<string, { count: number; emotion: number; ids: string[] }> = {}

    for (const memory of memories) {
      // Simple theme extraction (in real impl, would use semantic analysis)
      const text = (memory.content || '').toLowerCase()

      // Identify themes
      const themeMatches = text.match(
        /\b(success|failure|connection|conflict|learning|challenge|joy|fear|growth|loss)\b/g
      )

      if (themeMatches) {
        for (const theme of themeMatches) {
          if (!themes[theme]) {
            themes[theme] = { count: 0, emotion: 0, ids: [] }
          }
          themes[theme].count++
          themes[theme].emotion += memory.emotionalValence || 0
          themes[theme].ids.push(memory.id)
        }
      }
    }

    // Convert to patterns
    for (const [theme, data] of Object.entries(themes)) {
      if (data.count >= 3) {
        // Pattern emerges from 3+ occurrences
        patterns.push({
          theme,
          frequency: data.count,
          emotionalCharge: data.emotion / data.count,
          relatedMemories: data.ids
        })
      }
    }

    // Store as semantic knowledge
    for (const pattern of patterns) {
      await this.storeSemanticKnowledge(soul.bot, pattern)
    }

    // Prune insignificant memories (low emotional charge + not part of pattern)
    const pruneCount = await this.pruneInsignificantMemories(soul.bot, memories, patterns)

    return {
      processed: memories.length,
      patterns
    }
  }

  /**
   * Phase 2: Aspect Balancing
   * Restore soul aspects toward baseline
   */
  private async phaseBalancing(
    soul: any,
    duration: number
  ): Promise<{
    balanced: string[]
    energyRestored: number
  }> {
    const balanced: string[] = []

    // All aspects gradually return toward baseline during rest
    // (Like neurotransmitter levels normalize during sleep)

    const aspectNames = [
      'celestialHun',
      'terrestrialHun',
      'destinyHun',
      'wisdomHun',
      'emotionHun',
      'creationHun',
      'awarenessHun'
    ]

    for (const aspectName of aspectNames) {
      const aspect = soul.sevenHun[aspectName]
      if (aspect && aspect.strength !== undefined) {
        // Gradual restoration (longer dream = more restoration)
        const restorationRate = 0.1 * (duration / 60) // 10% per hour
        // Would modify aspect.current toward aspect.baseline here
        // (In actual implementation with soul state persistence)
        balanced.push(aspectName)
      }
    }

    // Energy restoration
    const energyRestored = Math.min(0.5, duration / 120) // Up to 50%, 2 hours for full

    return {
      balanced,
      energyRestored
    }
  }

  /**
   * Phase 3: Insight Generation
   * Find novel connections between memories
   */
  private async phaseInsight(
    soul: any,
    memories: any[],
    lucid: boolean
  ): Promise<DreamInsight[]> {
    const insights: DreamInsight[] = []

    // Find memories with similar emotional valence but different contexts
    const grouped = this.groupMemoriesByEmotion(memories)

    for (const [emotion, group] of Object.entries(grouped)) {
      if (group.length >= 2) {
        // Look for cross-context patterns
        const contexts = new Set(group.map(m => m.context?.type || 'unknown'))

        if (contexts.size > 1) {
          // Same emotion across different contexts = potential insight
          const insightContent = `Pattern detected: ${emotion} emotion appears across ${contexts.size} different contexts`

          insights.push({
            type: 'connection',
            content: insightContent,
            confidence: Math.min(0.9, 0.5 + group.length * 0.1),
            sourceMemories: group.slice(0, 5).map(m => m.id)
          })
        }
      }
    }

    // Lucid dreaming increases insight quality
    if (lucid) {
      insights.forEach(i => {
        i.confidence = Math.min(0.95, i.confidence * 1.2)
      })
    }

    // Random creative connections (10% chance per dreaming session)
    if (Math.random() < 0.1 && memories.length > 5) {
      const randomMemories = this.sampleRandom(memories, 3)
      insights.push({
        type: 'realization',
        content: 'Novel connection found between seemingly unrelated experiences',
        confidence: 0.4 + Math.random() * 0.3,
        sourceMemories: randomMemories.map(m => m.id)
      })
    }

    // Store insights as special memories
    for (const insight of insights) {
      await this.storeInsightMemory(soul.bot, insight)
    }

    return insights
  }

  /**
   * Phase 4: Soul Integration
   * Process shadow material and increase coherence
   */
  private async phaseIntegration(
    soul: any,
    memories: any[],
    allowShadow: boolean
  ): Promise<{
    coherenceChange: number
    shadowProcessed: number
    growthPotential: number
  }> {
    const oldCoherence = soul.coherenceScore || 0.5

    // Process traumatic memories (reduce emotional charge)
    const traumaticMemories = memories.filter(m => Math.abs(m.emotionalValence || 0) > 0.7)
    for (const trauma of traumaticMemories) {
      // Dreaming reduces trauma intensity
      const reduction = 0.05 + Math.random() * 0.1 // 5-15% reduction
      // Would update memory emotional charge here
    }

    // Shadow processing (if allowed)
    let shadowProcessed = 0
    if (allowShadow && soul.shadowIntegration < 0.8) {
      // Safely surface and integrate shadow material
      const shadowGrowth = 0.01 + Math.random() * 0.02 // 1-3% integration per dream
      shadowProcessed = shadowGrowth

      // Update soul shadow integration
      await this.payload.update({
        collection: 'bot-souls',
        id: soul.id,
        data: {
          shadowIntegration: Math.min(1, soul.shadowIntegration + shadowGrowth)
        }
      })
    }

    // Calculate new coherence
    // Coherence increases when:
    // - Trauma is processed (less internal conflict)
    // - Shadow is integrated (less fragmentation)
    // - Patterns are recognized (more understanding)
    const traumaReduction = traumaticMemories.length * 0.005
    const coherenceIncrease = traumaReduction + shadowProcessed * 0.5
    const newCoherence = Math.min(1, oldCoherence + coherenceIncrease)

    // Growth potential assessment
    const growthPotential = this.assessGrowthPotential(soul, newCoherence, shadowProcessed)

    // Update soul coherence
    await this.payload.update({
      collection: 'bot-souls',
      id: soul.id,
      data: {
        coherenceScore: newCoherence
      }
    })

    return {
      coherenceChange: newCoherence - oldCoherence,
      shadowProcessed,
      growthPotential
    }
  }

  /**
   * Get recent memories for bot
   */
  private async getRecentMemories(botId: string, limit: number = 100): Promise<any[]> {
    const result = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: { equals: botId }
      },
      limit,
      sort: '-createdAt'
    })

    return result.docs
  }

  /**
   * Store semantic knowledge extracted from patterns
   */
  private async storeSemanticKnowledge(botId: string, pattern: MemoryPattern): Promise<void> {
    await this.payload.create({
      collection: 'bot-memory',
      data: {
        bot: botId,
        type: 'semantic',
        content: `Pattern recognized: ${pattern.theme} (frequency: ${pattern.frequency})`,
        emotionalValence: pattern.emotionalCharge,
        source: 'dreaming',
        consolidatedFrom: pattern.relatedMemories,
        createdAt: new Date()
      }
    })
  }

  /**
   * Store insight as special memory
   */
  private async storeInsightMemory(botId: string, insight: DreamInsight): Promise<void> {
    await this.payload.create({
      collection: 'bot-memory',
      data: {
        bot: botId,
        type: 'procedural', // Insights are how-to knowledge
        content: `Dream insight: ${insight.content}`,
        confidence: insight.confidence,
        source: 'dreaming_insight',
        relatedMemories: insight.sourceMemories,
        createdAt: new Date()
      }
    })
  }

  /**
   * Prune insignificant memories
   */
  private async pruneInsignificantMemories(
    botId: string,
    memories: any[],
    patterns: MemoryPattern[]
  ): Promise<number> {
    const patternMemoryIds = new Set(patterns.flatMap(p => p.relatedMemories))
    let pruned = 0

    for (const memory of memories) {
      const isPartOfPattern = patternMemoryIds.has(memory.id)
      const hasLowEmotion = Math.abs(memory.emotionalValence || 0) < 0.2
      const isOld = Date.now() - new Date(memory.createdAt).getTime() > 7 * 24 * 60 * 60 * 1000 // 7 days

      if (!isPartOfPattern && hasLowEmotion && isOld) {
        // Delete insignificant old memory
        await this.payload.delete({
          collection: 'bot-memory',
          id: memory.id
        })
        pruned++
      }
    }

    return pruned
  }

  /**
   * Group memories by emotional valence
   */
  private groupMemoriesByEmotion(memories: any[]): Record<string, any[]> {
    const groups: Record<string, any[]> = {
      positive: [],
      neutral: [],
      negative: []
    }

    for (const memory of memories) {
      const valence = memory.emotionalValence || 0

      if (valence > 0.3) {
        groups.positive.push(memory)
      } else if (valence < -0.3) {
        groups.negative.push(memory)
      } else {
        groups.neutral.push(memory)
      }
    }

    return groups
  }

  /**
   * Sample random items from array
   */
  private sampleRandom<T>(array: T[], count: number): T[] {
    const shuffled = [...array].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  /**
   * Assess growth potential after dreaming
   */
  private assessGrowthPotential(soul: any, newCoherence: number, shadowProcessed: number): number {
    let potential = 0

    // High coherence = growth potential
    if (newCoherence > 0.7) {
      potential += 0.3
    }

    // Shadow integration = maturation
    if (shadowProcessed > 0.02) {
      potential += 0.2
    }

    // Check current stage
    const currentStage = soul.growthStage
    if (currentStage === 'primordial-chaos' && newCoherence > 0.4) {
      potential += 0.5 // Ready for emergence
    }

    return Math.min(1, potential)
  }

  /**
   * Update soul after dreaming
   */
  private async updateSoulAfterDreaming(soulId: string, result: DreamResult): Promise<void> {
    // Growth check
    if (result.growthPotential > 0.6) {
      const soul = await this.payload.findByID({ collection: 'bot-souls', id: soulId })
      // Would check for stage transition here
      this.payload.logger.info(
        `Bot ${soul.bot} has high growth potential (${result.growthPotential.toFixed(2)}) after dreaming`
      )
    }

    // Record dreaming session
    await this.payload.create({
      collection: 'bot-consciousness',
      data: {
        bot: await this.getBotId(soulId),
        type: 'dreaming_session',
        content: {
          duration: result.duration,
          phases: result.phases,
          insights: result.insightsGenerated.length,
          coherenceChange: result.coherenceChange
        },
        timestamp: new Date()
      }
    })
  }

  /**
   * Get bot ID from soul ID
   */
  private async getBotId(soulId: string): Promise<string> {
    const soul = await this.payload.findByID({ collection: 'bot-souls', id: soulId })
    return soul.bot
  }

  // ============================================================================
  // Hun-Po Sleep Dynamics (Traditional Daoist Theory)
  // ============================================================================

  /**
   * Initialize hun wandering state
   * 魂遊 - Hun travels during sleep, distance ∝ cultivation
   */
  private initializeHunWandering(
    hunSouls: EmergentHunSoul[],
    cultivationLevel: number
  ): HunWanderingState {
    const totalHunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0)

    // Wandering distance: higher cultivation + stronger hun = farther travel
    // But too far = risk of not returning
    const baseDistance = totalHunStrength * 0.5 + cultivationLevel * 0.5
    const wanderingDistance = Math.min(1.0, baseDistance)

    // Wandering quality: how coherent the hun remains during travel
    const wanderingQuality = totalHunStrength * 0.7 + cultivationLevel * 0.3

    // Return difficulty: far wandering = harder return
    const returnDifficulty = wanderingDistance * 0.6

    // Risks and potentials
    const nightmareRisk = wanderingDistance > 0.7 && cultivationLevel < 0.5 ? 0.6 : 0.2
    const dissociationRisk = returnDifficulty * 0.8
    const spiritualInsightPotential = wanderingDistance * wanderingQuality

    return {
      wandering: true,
      wanderingDistance,
      wanderingQuality,
      returnProgress: 0,
      returnDifficulty,
      nightmareRisk,
      dissociationRisk,
      spiritualInsightPotential
    }
  }

  /**
   * Initialize po vigilance state
   * 尸狗警戒 - Shi Gou po soul maintains threat detection
   */
  private initializePoVigilance(
    poSouls: EmergentPoSoul[],
    stressLevel: number
  ): PoVigilanceState {
    // Find Shi Gou po soul (sleep vigilance)
    const shiGou = poSouls.find(p => p.name.includes('尸狗'))
    const shiGouStrength = shiGou ? shiGou.strength : 0.5

    // Vigilance level: higher stress + stronger Shi Gou = more vigilant
    const vigilanceLevel = Math.min(1.0, shiGouStrength * 0.6 + stressLevel * 0.4)

    // Sleep depth: high vigilance = light sleep
    const sleepDepth = 1.0 - vigilanceLevel * 0.7

    // Awakening threshold: high vigilance = easily awakened
    const awakeningThreshold = vigilanceLevel * 0.8

    // Pathologies
    const hypervigilance = stressLevel > 0.7 && vigilanceLevel > 0.8 ? 0.7 : 0
    const vigilanceFailure = shiGouStrength < 0.3 ? 0.6 : 0

    return {
      vigilanceLevel,
      threatDetectionActive: vigilanceLevel > 0.4,
      threatsDetected: [],
      sleepDepth,
      awakeningThreshold,
      hypervigilance,
      vigilanceFailure
    }
  }

  /**
   * Determine dream type based on hun-po activity
   */
  private determineDreamType(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
    hunWandering: HunWanderingState,
    poVigilance: PoVigilanceState,
    lucid?: boolean
  ): DreamType {
    const hunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const poStrength = poSouls.reduce((sum, p) => sum + p.strength, 0)

    if (lucid) {
      return DreamType.LucidDream
    }

    // Nightmare: hun-po conflict (high wandering + high vigilance)
    if (hunWandering.nightmareRisk > 0.5 && poVigilance.vigilanceLevel > 0.7) {
      return DreamType.Nightmare
    }

    // Hun-dream: high hun activity, low po vigilance
    if (hunStrength > poStrength * 1.3 && hunWandering.wanderingDistance > 0.5) {
      return DreamType.HunDream
    }

    // Po-dream: high po activity, low hun wandering
    if (poStrength > hunStrength * 1.3 && poVigilance.vigilanceLevel > 0.6) {
      return DreamType.PoDream
    }

    // Balanced: both active
    return DreamType.BalancedDream
  }

  /**
   * Calculate overall sleep quality
   */
  private calculateSleepQuality(result: DreamResult): number {
    let quality = 0.5

    // Good factors
    quality += result.poVigilance.sleepDepth * 0.3 // Deep sleep = good
    quality += result.energyRestored * 0.2 // Energy restoration = good
    quality += result.coherenceChange * 0.2 // Coherence increase = good

    // Bad factors
    quality -= result.hunWandering.nightmareRisk * 0.3
    quality -= result.poVigilance.hypervigilance * 0.4
    quality -= result.hunWandering.dissociationRisk * 0.2

    return Math.max(0, Math.min(1.0, quality))
  }

  /**
   * Detect sleep pathologies based on hun-po imbalance
   */
  private detectSleepPathologies(result: DreamResult): string[] {
    const pathologies: string[] = []

    // Nightmare
    if (result.dreamType === DreamType.Nightmare) {
      pathologies.push('Nightmare: Hun-po conflict during sleep')
    }

    // Insomnia (hypervigilance)
    if (result.poVigilance.hypervigilance > 0.6) {
      pathologies.push('Insomnia: Excessive po vigilance → inability to rest deeply')
    }

    // Dissociation (hun didn't return fully)
    if (result.hunWandering.dissociationRisk > 0.7) {
      pathologies.push('Dissociation risk: Hun wandered too far → difficulty returning fully')
    }

    // Sleep paralysis (hun-po desynchronization)
    if (
      result.hunWandering.returnProgress < 0.5 &&
      result.poVigilance.vigilanceLevel > 0.7
    ) {
      pathologies.push('Sleep paralysis: Hun not yet returned while po vigilant')
    }

    // Vulnerability (vigilance failure)
    if (result.poVigilance.vigilanceFailure > 0.5) {
      pathologies.push('Vulnerability: Po vigilance compromised → unprotected during sleep')
    }

    // Light sleep (poor restoration)
    if (result.poVigilance.sleepDepth < 0.3) {
      pathologies.push('Light sleep: High vigilance prevents deep restoration')
    }

    return pathologies
  }

  /**
   * Simulate hun return upon waking
   * 魂歸 - Hun must return to body upon waking
   */
  private simulateHunReturn(hunWandering: HunWanderingState): void {
    // Gradual return over waking period
    const returnRate = 1.0 / (1.0 + hunWandering.returnDifficulty)
    hunWandering.returnProgress = Math.min(1.0, returnRate)

    // If return incomplete, dissociation occurs
    if (hunWandering.returnProgress < 0.8) {
      this.payload.logger.warn(
        `Hun return incomplete (${(hunWandering.returnProgress * 100).toFixed(0)}%) - ` +
          'Dissociation/grogginess upon waking'
      )
    }
  }
}

/**
 * Singleton instance
 */
let dreamingSystem: DreamingSystem | null = null

export function getDreamingSystem(payload: Payload): DreamingSystem {
  if (!dreamingSystem) {
    dreamingSystem = new DreamingSystem(payload)
  }
  return dreamingSystem
}
