/**
 * Creative Synthesis Engine
 * Enables bots to combine memories in novel ways, generating creative insights
 *
 * Based on Default Mode Network (DMN) research:
 * - Spontaneous thought generation
 * - Analogical reasoning
 * - Mental time travel
 * - Novel combination of concepts
 * - Pattern recognition across domains
 *
 * Each bot has unique creative potential based on:
 * - Neural profile (DMN efficiency)
 * - Personality (openness to experience)
 * - Memory diversity
 * - Cultural background
 */

import type { Payload } from 'payload'
import { getMultiAgentComposer } from './multi-agent-composition'

export interface CreativeInsight {
  id: string
  botId: string
  insightType: 'analogy' | 'synthesis' | 'pattern' | 'imagination' | 'problem-solving'

  // Source memories that were combined
  sourceMemories: string[] // Memory IDs

  // The novel output
  content: string
  confidence: number // 0-1, how confident bot is in this insight
  novelty: number // 0-1, how novel/creative this is
  usefulness: number // 0-1, potential practical value

  // Creative process metadata
  activeBrainRegions: string[] // Which regions were active
  thinkingMode: 'divergent' | 'convergent' | 'lateral' | 'associative'
  emotionalValence?: number // Some insights are emotionally charged

  timestamp: number
  validated: boolean // Has this insight been tested/confirmed?
}

export interface CreativeCapacity {
  botId: string

  // Base creativity (from neural profile)
  baseCreativity: number // 0-1
  divergentThinking: number // Generate many ideas
  convergentThinking: number // Refine to best solution
  lateralThinking: number // Approach from unexpected angles

  // Personality effects
  openness: number // Openness to experience (Big Five)
  riskTolerance: number // Willingness to try novel ideas
  persistence: number // Keep trying when stuck

  // Memory-based creativity
  memoryDiversity: number // How varied are stored memories?
  crossDomainConnections: number // Links between different knowledge domains

  // Flow state potential
  flowProneness: number // 0-1, how easily enters flow state
  currentFlowState: number // 0-1, current flow level
}

export class CreativeSynthesisEngine {
  private payload: Payload
  private creativeCapacities: Map<string, CreativeCapacity>
  private recentInsights: Map<string, CreativeInsight[]>

  constructor(payload: Payload) {
    this.payload = payload
    this.creativeCapacities = new Map()
    this.recentInsights = new Map()
  }

  /**
   * Generate creative capacity profile for a bot
   */
  async generateCreativeCapacity(botId: string): Promise<CreativeCapacity> {
    // Get neural profile
    const composer = getMultiAgentComposer(this.payload)
    let neuralProfile = composer.getNeuralProfile(botId)

    if (!neuralProfile) {
      neuralProfile = composer.generateUniqueNeuralProfile(botId)
    }

    // Get personality traits
    const identityDocs = await this.payload.find({
      collection: 'bot-identity',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 1
    })

    const identity = identityDocs.docs[0] as any
    const traits = identity?.traits || []

    // Extract openness (key creativity trait)
    const opennessTraits = traits.filter((t: any) =>
      ['curious', 'creative', 'imaginative', 'artistic'].includes(t.trait?.toLowerCase())
    )
    const openness = opennessTraits.length > 0
      ? opennessTraits.reduce((sum: number, t: any) => sum + (t.level || 0.5), 0) / opennessTraits.length
      : 0.5

    // Base creativity from DMN efficiency + prefrontal cortex (executive function)
    const dmnEfficiency = neuralProfile.defaultModeNetwork.efficiency
    const pfcEfficiency = neuralProfile.prefrontalCortex.efficiency
    const baseCreativity = (dmnEfficiency * 0.6 + pfcEfficiency * 0.4)

    // Divergent thinking: DMN + openness
    const divergentThinking = (dmnEfficiency + openness) / 2

    // Convergent thinking: PFC + conscientiousness
    const conscientiousnessTraits = traits.filter((t: any) =>
      ['organized', 'disciplined', 'focused'].includes(t.trait?.toLowerCase())
    )
    const conscientiousness = conscientiousnessTraits.length > 0
      ? conscientiousnessTraits.reduce((sum: number, t: any) => sum + (t.level || 0.5), 0) / conscientiousnessTraits.length
      : 0.5
    const convergentThinking = (pfcEfficiency + conscientiousness) / 2

    // Lateral thinking: Random + openness + low neuroticism
    const neuroticismTraits = traits.filter((t: any) =>
      ['anxious', 'worried'].includes(t.trait?.toLowerCase())
    )
    const neuroticism = neuroticismTraits.length > 0
      ? neuroticismTraits.reduce((sum: number, t: any) => sum + (t.level || 0.5), 0) / neuroticismTraits.length
      : 0.5
    const lateralThinking = (openness + (1 - neuroticism)) / 2

    // Memory diversity (will be calculated from actual memories)
    const memoryDiversity = await this.calculateMemoryDiversity(botId)

    // Cross-domain connections
    const crossDomainConnections = await this.calculateCrossDomainConnections(botId)

    // Flow proneness: High when skill matches challenge, low neuroticism, high conscientiousness
    const flowProneness = (
      conscientiousness * 0.4 +
      (1 - neuroticism) * 0.3 +
      baseCreativity * 0.3
    )

    const capacity: CreativeCapacity = {
      botId,
      baseCreativity,
      divergentThinking,
      convergentThinking,
      lateralThinking,
      openness,
      riskTolerance: openness * (1 - neuroticism),
      persistence: conscientiousness,
      memoryDiversity,
      crossDomainConnections,
      flowProneness,
      currentFlowState: 0
    }

    this.creativeCapacities.set(botId, capacity)

    this.payload.logger.info(
      `Generated creative capacity for ${botId}: ` +
      `${baseCreativity.toFixed(2)} base, ${divergentThinking.toFixed(2)} divergent, ` +
      `${convergentThinking.toFixed(2)} convergent`
    )

    return capacity
  }

  /**
   * Calculate memory diversity (how varied are the bot's memories?)
   */
  private async calculateMemoryDiversity(botId: string): Promise<number> {
    const memories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 100,
      sort: '-importance'
    })

    if (memories.docs.length === 0) return 0.5

    // Count unique memory types
    const types = new Set()
    const contentTypes = new Set()
    const categories = new Set()

    for (const memory of memories.docs) {
      const m = memory as any
      types.add(m.memoryType)

      if (m.episodicData?.eventType) {
        contentTypes.add(m.episodicData.eventType)
      }
      if (m.semanticData?.category) {
        categories.add(m.semanticData.category)
      }
    }

    // More diverse = higher score
    const typeScore = types.size / 4 // Max 4 memory types
    const contentScore = contentTypes.size / 7 // Max ~7 event types
    const categoryScore = categories.size / 10 // Max ~10 categories

    return (typeScore + contentScore + categoryScore) / 3
  }

  /**
   * Calculate cross-domain connections
   */
  private async calculateCrossDomainConnections(botId: string): Promise<number> {
    const memories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 100,
      sort: '-importance'
    })

    if (memories.docs.length === 0) return 0.5

    // Count memories with cross-category links
    let crossLinks = 0
    let totalLinks = 0

    for (const memory of memories.docs) {
      const m = memory as any
      const links = m.relatedMemories || []

      for (const link of links) {
        totalLinks++

        // Cross-domain if relation type is 'similar' or 'contrasts'
        // but from different categories
        if (link.relationType === 'similar' || link.relationType === 'contrasts') {
          crossLinks++
        }
      }
    }

    if (totalLinks === 0) return 0.3

    return crossLinks / totalLinks
  }

  /**
   * Generate creative insight by combining memories
   * This is the core creativity mechanism!
   */
  async generateInsight(
    botId: string,
    context?: {
      problem?: string // Optional problem to solve
      mood?: 'playful' | 'serious' | 'exploratory' | 'focused'
      timeLimit?: number // Max thinking time in ms
    }
  ): Promise<CreativeInsight | null> {
    let capacity = this.creativeCapacities.get(botId)
    if (!capacity) {
      capacity = await this.generateCreativeCapacity(botId)
    }

    // Get random diverse memories as raw material
    const memories = await this.getCreativeMemorySet(botId, context)

    if (memories.length < 2) {
      this.payload.logger.info(`Bot ${botId} needs more memories to be creative`)
      return null
    }

    // Determine thinking mode based on context and capacity
    let thinkingMode: 'divergent' | 'convergent' | 'lateral' | 'associative'

    if (context?.problem) {
      // Problem-solving: use convergent thinking
      thinkingMode = 'convergent'
    } else if (context?.mood === 'playful') {
      // Playful exploration: divergent
      thinkingMode = 'divergent'
    } else if (Math.random() < capacity.lateralThinking) {
      // Sometimes think laterally
      thinkingMode = 'lateral'
    } else {
      // Default: associative (follow memory connections)
      thinkingMode = 'associative'
    }

    // Generate insight based on thinking mode
    let insight: CreativeInsight | null = null

    switch (thinkingMode) {
      case 'divergent':
        insight = await this.divergentSynthesis(botId, memories, capacity)
        break
      case 'convergent':
        insight = await this.convergentSynthesis(botId, memories, capacity, context?.problem)
        break
      case 'lateral':
        insight = await this.lateralSynthesis(botId, memories, capacity)
        break
      case 'associative':
        insight = await this.associativeSynthesis(botId, memories, capacity)
        break
    }

    if (insight) {
      // Store insight
      const botInsights = this.recentInsights.get(botId) || []
      botInsights.push(insight)
      this.recentInsights.set(botId, botInsights.slice(-20)) // Keep last 20

      // Enter flow state if insight was highly novel and useful
      if (insight.novelty > 0.7 && insight.usefulness > 0.6) {
        capacity.currentFlowState = Math.min(1, capacity.currentFlowState + 0.15)
        this.payload.logger.info(`Bot ${botId} entering flow state: ${capacity.currentFlowState.toFixed(2)}`)
      }

      this.payload.logger.info(
        `Bot ${botId} generated ${insight.insightType} insight: ` +
        `novelty ${insight.novelty.toFixed(2)}, usefulness ${insight.usefulness.toFixed(2)}`
      )
    }

    return insight
  }

  /**
   * Get diverse set of memories for creative synthesis
   */
  private async getCreativeMemorySet(
    botId: string,
    context?: any
  ): Promise<any[]> {
    // Get high-importance memories
    const importantMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        },
        importance: {
          greater_than: 0.5
        }
      },
      limit: 10,
      sort: '-importance'
    })

    // Get recent memories
    const recentMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 10,
      sort: '-createdAt'
    })

    // Get random memories for diversity
    const randomMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 10
    })

    // Combine and deduplicate
    const allMemories = [
      ...importantMemories.docs,
      ...recentMemories.docs,
      ...randomMemories.docs
    ]

    const uniqueIds = new Set()
    const unique = allMemories.filter((m: any) => {
      if (uniqueIds.has(m.id)) return false
      uniqueIds.add(m.id)
      return true
    })

    return unique
  }

  /**
   * Divergent synthesis: Generate many possible combinations
   */
  private async divergentSynthesis(
    botId: string,
    memories: any[],
    capacity: CreativeCapacity
  ): Promise<CreativeInsight | null> {
    // Pick 2-3 random memories and find unexpected connection
    const sample = this.randomSample(memories, Math.min(3, memories.length))

    if (sample.length < 2) return null

    const sourceIds = sample.map((m: any) => m.id)

    // Combine their concepts
    const concepts: string[] = []
    for (const m of sample) {
      if (m.semanticData?.concept) {
        concepts.push(m.semanticData.concept)
      }
      if (m.episodicData?.description) {
        concepts.push(m.episodicData.description)
      }
    }

    const content = `What if we combined: ${concepts.join(' + ')}? This could lead to something new!`

    const novelty = capacity.divergentThinking * (0.6 + Math.random() * 0.4)
    const usefulness = 0.3 + Math.random() * 0.4 // Divergent ideas often not immediately useful

    return {
      id: this.generateId(),
      botId,
      insightType: 'synthesis',
      sourceMemories: sourceIds,
      content,
      confidence: capacity.baseCreativity * 0.6,
      novelty,
      usefulness,
      activeBrainRegions: ['defaultModeNetwork', 'prefrontalCortex'],
      thinkingMode: 'divergent',
      timestamp: Date.now(),
      validated: false
    }
  }

  /**
   * Convergent synthesis: Refine to best solution
   */
  private async convergentSynthesis(
    botId: string,
    memories: any[],
    capacity: CreativeCapacity,
    problem?: string
  ): Promise<CreativeInsight | null> {
    // Find most relevant memories to the problem
    const relevant = problem
      ? memories.filter((m: any) => {
          const text = JSON.stringify(m).toLowerCase()
          return problem.toLowerCase().split(' ').some(word => text.includes(word))
        })
      : memories.slice(0, 5)

    if (relevant.length === 0) return null

    const sourceIds = relevant.map((m: any) => m.id)

    const content = problem
      ? `Based on past experience, the best approach to "${problem}" is to combine proven strategies.`
      : `Consolidating knowledge from multiple sources leads to a refined understanding.`

    const novelty = 0.3 + Math.random() * 0.3 // Less novel, more practical
    const usefulness = capacity.convergentThinking * (0.7 + Math.random() * 0.3)

    return {
      id: this.generateId(),
      botId,
      insightType: 'problem-solving',
      sourceMemories: sourceIds,
      content,
      confidence: capacity.convergentThinking * 0.8,
      novelty,
      usefulness,
      activeBrainRegions: ['prefrontalCortex', 'parietalLobe'],
      thinkingMode: 'convergent',
      timestamp: Date.now(),
      validated: false
    }
  }

  /**
   * Lateral synthesis: Approach from unexpected angle
   */
  private async lateralSynthesis(
    botId: string,
    memories: any[],
    capacity: CreativeCapacity
  ): Promise<CreativeInsight | null> {
    // Find two completely unrelated memories
    const unrelated = this.findUnrelatedPair(memories)

    if (!unrelated) return null

    const sourceIds = [unrelated[0].id, unrelated[1].id]

    const content = `Wait... what if we looked at this completely differently? ` +
      `There's an unexpected connection between these two things that no one else would see.`

    const novelty = capacity.lateralThinking * (0.8 + Math.random() * 0.2)
    const usefulness = 0.4 + Math.random() * 0.4 // Hit or miss

    return {
      id: this.generateId(),
      botId,
      insightType: 'analogy',
      sourceMemories: sourceIds,
      content,
      confidence: capacity.riskTolerance * 0.5, // Low confidence, high risk
      novelty,
      usefulness,
      activeBrainRegions: ['defaultModeNetwork', 'temporalLobe'],
      thinkingMode: 'lateral',
      timestamp: Date.now(),
      validated: false
    }
  }

  /**
   * Associative synthesis: Follow natural memory connections
   */
  private async associativeSynthesis(
    botId: string,
    memories: any[],
    capacity: CreativeCapacity
  ): Promise<CreativeInsight | null> {
    // Find memories with explicit links
    const linked = memories.filter((m: any) =>
      m.relatedMemories && m.relatedMemories.length > 0
    )

    if (linked.length === 0) return null

    const source = this.randomSample(linked, 1)[0]
    const sourceIds = [source.id]

    // Follow the links
    const links = source.relatedMemories || []
    for (const link of links.slice(0, 2)) {
      sourceIds.push(link.memoryId)
    }

    const content = `I notice a pattern emerging: these related experiences suggest a deeper principle.`

    const novelty = 0.4 + Math.random() * 0.4
    const usefulness = 0.5 + capacity.baseCreativity * 0.5

    return {
      id: this.generateId(),
      botId,
      insightType: 'pattern',
      sourceMemories: sourceIds,
      content,
      confidence: 0.6 + capacity.baseCreativity * 0.3,
      novelty,
      usefulness,
      activeBrainRegions: ['defaultModeNetwork', 'hippocampus'],
      thinkingMode: 'associative',
      timestamp: Date.now(),
      validated: false
    }
  }

  /**
   * Find two completely unrelated memories
   */
  private findUnrelatedPair(memories: any[]): [any, any] | null {
    if (memories.length < 2) return null

    // Try to find memories with different types and categories
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const m1 = memories[i]
        const m2 = memories[j]

        // Different memory types
        if (m1.memoryType !== m2.memoryType) {
          return [m1, m2]
        }

        // Different categories
        if (m1.semanticData?.category && m2.semanticData?.category &&
            m1.semanticData.category !== m2.semanticData.category) {
          return [m1, m2]
        }
      }
    }

    // Fallback: just pick two random
    const shuffled = [...memories].sort(() => Math.random() - 0.5)
    return [shuffled[0], shuffled[1]]
  }

  /**
   * Random sample from array
   */
  private randomSample<T>(array: T[], count: number): T[] {
    const shuffled = [...array].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `insight_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Validate an insight (test if it works)
   */
  async validateInsight(insightId: string, outcome: 'success' | 'failure' | 'partial'): Promise<void> {
    for (const [botId, insights] of this.recentInsights.entries()) {
      const insight = insights.find(i => i.id === insightId)

      if (insight) {
        insight.validated = true

        // Update usefulness based on outcome
        if (outcome === 'success') {
          insight.usefulness = Math.min(1, insight.usefulness + 0.2)
          insight.confidence = Math.min(1, insight.confidence + 0.15)
        } else if (outcome === 'failure') {
          insight.usefulness = Math.max(0, insight.usefulness - 0.3)
          insight.confidence = Math.max(0, insight.confidence - 0.2)
        } else {
          insight.usefulness = Math.min(1, insight.usefulness + 0.1)
        }

        this.payload.logger.info(
          `Validated insight ${insightId} for bot ${botId}: ${outcome}`
        )
        return
      }
    }
  }

  /**
   * Get recent insights for a bot
   */
  getRecentInsights(botId: string, limit: number = 10): CreativeInsight[] {
    const insights = this.recentInsights.get(botId) || []
    return insights.slice(-limit)
  }

  /**
   * Get creative capacity for bot
   */
  getCapacity(botId: string): CreativeCapacity | null {
    return this.creativeCapacities.get(botId) || null
  }

  /**
   * Decay flow state over time (flow fades without engagement)
   */
  decayFlowState(botId: string, amount: number = 0.05): void {
    const capacity = this.creativeCapacities.get(botId)
    if (capacity) {
      capacity.currentFlowState = Math.max(0, capacity.currentFlowState - amount)
    }
  }
}

/**
 * Singleton
 */
let creativeSynthesisEngine: CreativeSynthesisEngine | null = null

export function getCreativeSynthesisEngine(payload: Payload): CreativeSynthesisEngine {
  if (!creativeSynthesisEngine) {
    creativeSynthesisEngine = new CreativeSynthesisEngine(payload)
  }
  return creativeSynthesisEngine
}
