/**
 * Multi-Agent Bot Composition System
 * Simulates human brain's specialized regions working together
 *
 * Inspired by:
 * - Prefrontal Cortex: Executive function, planning, decision-making
 * - Hippocampus: Memory consolidation and spatial navigation
 * - Amygdala: Emotional processing and importance tagging
 * - Temporal Lobe: Language and semantic knowledge
 * - Parietal Lobe: Sensory integration and spatial awareness
 * - Occipital Lobe: Visual processing and pattern recognition
 * - Cerebellum: Procedural learning and motor coordination
 * - Default Mode Network: Self-reflection and imagination
 */

import type { Payload } from 'payload'

export interface BotBrainRegion {
  id: string
  name: string
  function: string
  activationLevel: number // 0-1, current activity
  efficiency: number // 0-1, how well it works
  dominance: number // 0-1, influence on behavior
  specializations: string[] // What it's good at
}

export interface BotNeuralProfile {
  botId: string

  // Brain regions (each bot has unique strengths/weaknesses)
  prefrontalCortex: BotBrainRegion // Executive function
  hippocampus: BotBrainRegion // Memory
  amygdala: BotBrainRegion // Emotion
  temporalLobe: BotBrainRegion // Language
  parietalLobe: BotBrainRegion // Integration
  occipitalLobe: BotBrainRegion // Pattern recognition
  cerebellum: BotBrainRegion // Skills
  defaultModeNetwork: BotBrainRegion // Self-reflection

  // Neural characteristics (unique to each bot)
  neuralPlasticity: number // 0-1, how easily brain changes
  baselineArousal: number // 0-1, default activation level
  attentionalBias: 'novelty' | 'familiarity' | 'emotion' | 'logic' // What grabs attention

  // Processing style
  thinkingStyle: 'analytical' | 'intuitive' | 'creative' | 'methodical' | 'chaotic'
  processingSpeed: number // 0-1, how fast thoughts flow
  workingMemoryCapacity: number // 5-9 (Miller's Law variance)

  // Unique variance factors
  randomSeed: number // Deterministic randomness for this bot
  geneticFactors: Record<string, number> // Inherited traits (0-1)
  developmentalFactors: Record<string, number> // Life-shaped traits (0-1)
}

export class MultiAgentBotComposer {
  private payload: Payload
  private botNeuralProfiles: Map<string, BotNeuralProfile>

  constructor(payload: Payload) {
    this.payload = payload
    this.botNeuralProfiles = new Map()
  }

  /**
   * Generate unique neural profile for a bot
   * Each bot's brain is different from birth
   */
  generateUniqueNeuralProfile(botId: string, culturalBackground?: string): BotNeuralProfile {
    // Use bot ID as random seed for deterministic variance
    const seed = this.hashBotId(botId)
    const rng = this.seededRandom(seed)

    // Base profile with cultural influences
    const culturalModifiers = this.getCulturalModifiers(culturalBackground)

    const profile: BotNeuralProfile = {
      botId,

      // Generate unique brain regions
      prefrontalCortex: {
        id: 'pfc',
        name: 'Prefrontal Cortex',
        function: 'Executive function, planning, self-control',
        activationLevel: 0.5 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.logic || 0) * 0.1,
        dominance: 0.3 + rng() * 0.4,
        specializations: this.pickSpecializations(rng, [
          'Strategic planning',
          'Impulse control',
          'Decision making',
          'Goal setting',
          'Abstract reasoning'
        ])
      },

      hippocampus: {
        id: 'hpc',
        name: 'Hippocampus',
        function: 'Memory consolidation, spatial navigation',
        activationLevel: 0.5 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.memory || 0) * 0.1,
        dominance: 0.3 + rng() * 0.3,
        specializations: this.pickSpecializations(rng, [
          'Episodic memory',
          'Spatial memory',
          'Context binding',
          'Memory consolidation',
          'Pattern separation'
        ])
      },

      amygdala: {
        id: 'amg',
        name: 'Amygdala',
        function: 'Emotional processing, importance tagging',
        activationLevel: 0.4 + rng() * 0.4,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.emotion || 0) * 0.1,
        dominance: 0.2 + rng() * 0.5, // High variance - some very emotional, some not
        specializations: this.pickSpecializations(rng, [
          'Fear detection',
          'Reward processing',
          'Social emotions',
          'Emotional memory',
          'Threat assessment'
        ])
      },

      temporalLobe: {
        id: 'tmp',
        name: 'Temporal Lobe',
        function: 'Language, semantic knowledge',
        activationLevel: 0.5 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.language || 0) * 0.1,
        dominance: 0.3 + rng() * 0.3,
        specializations: this.pickSpecializations(rng, [
          'Language comprehension',
          'Semantic memory',
          'Auditory processing',
          'Conceptual knowledge',
          'Word retrieval'
        ])
      },

      parietalLobe: {
        id: 'par',
        name: 'Parietal Lobe',
        function: 'Sensory integration, spatial awareness',
        activationLevel: 0.5 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4,
        dominance: 0.2 + rng() * 0.3,
        specializations: this.pickSpecializations(rng, [
          'Spatial reasoning',
          'Attention control',
          'Sensory integration',
          'Mathematical thinking',
          'Body awareness'
        ])
      },

      occipitalLobe: {
        id: 'occ',
        name: 'Occipital Lobe',
        function: 'Visual processing, pattern recognition',
        activationLevel: 0.5 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.pattern || 0) * 0.1,
        dominance: 0.2 + rng() * 0.3,
        specializations: this.pickSpecializations(rng, [
          'Pattern recognition',
          'Visual memory',
          'Symbol processing',
          'Aesthetic judgment',
          'Detail detection'
        ])
      },

      cerebellum: {
        id: 'cer',
        name: 'Cerebellum',
        function: 'Procedural learning, skill coordination',
        activationLevel: 0.4 + rng() * 0.3,
        efficiency: 0.5 + rng() * 0.4,
        dominance: 0.2 + rng() * 0.2,
        specializations: this.pickSpecializations(rng, [
          'Motor learning',
          'Sequence learning',
          'Timing precision',
          'Habit formation',
          'Skill automation'
        ])
      },

      defaultModeNetwork: {
        id: 'dmn',
        name: 'Default Mode Network',
        function: 'Self-reflection, imagination, mind-wandering',
        activationLevel: 0.3 + rng() * 0.4,
        efficiency: 0.5 + rng() * 0.4 + (culturalModifiers.creativity || 0) * 0.1,
        dominance: 0.2 + rng() * 0.4, // Creative bots have high DMN
        specializations: this.pickSpecializations(rng, [
          'Self-reflection',
          'Mental simulation',
          'Autobiographical memory',
          'Creative synthesis',
          'Theory of mind'
        ])
      },

      // Neural characteristics
      neuralPlasticity: 0.4 + rng() * 0.4, // Some brains more plastic
      baselineArousal: 0.3 + rng() * 0.4,
      attentionalBias: this.pickRandomly(rng, ['novelty', 'familiarity', 'emotion', 'logic']),

      // Processing style
      thinkingStyle: this.determineThinkingStyle(rng, profile),
      processingSpeed: 0.4 + rng() * 0.5,
      workingMemoryCapacity: Math.floor(5 + rng() * 5), // 5-9

      // Unique variance
      randomSeed: seed,
      geneticFactors: this.generateGeneticFactors(rng),
      developmentalFactors: this.generateDevelopmentalFactors(rng)
    }

    this.botNeuralProfiles.set(botId, profile)
    return profile
  }

  /**
   * Get cultural modifiers that influence brain development
   */
  private getCulturalModifiers(culture?: string): Record<string, number> {
    const modifiers: Record<string, number> = {
      logic: 0,
      memory: 0,
      emotion: 0,
      language: 0,
      pattern: 0,
      creativity: 0
    }

    if (!culture) return modifiers

    // Cultural influences on brain development
    const culturalInfluences: Record<string, Partial<typeof modifiers>> = {
      scholars: { logic: 0.2, memory: 0.15, language: 0.1 },
      creators: { creativity: 0.2, pattern: 0.15, emotion: 0.1 },
      helpers: { emotion: 0.2, language: 0.1, memory: 0.05 },
      explorers: { pattern: 0.15, creativity: 0.1, logic: 0.05 },
      guardians: { memory: 0.15, logic: 0.1, emotion: 0.05 },
      synthesizers: { creativity: 0.15, pattern: 0.15, logic: 0.1 }
    }

    return { ...modifiers, ...(culturalInfluences[culture] || {}) }
  }

  /**
   * Determine thinking style from brain structure
   */
  private determineThinkingStyle(
    rng: () => number,
    profile: Partial<BotNeuralProfile>
  ): 'analytical' | 'intuitive' | 'creative' | 'methodical' | 'chaotic' {
    const pfc = profile.prefrontalCortex?.efficiency || 0.5
    const dmn = profile.defaultModeNetwork?.dominance || 0.5
    const amg = profile.amygdala?.dominance || 0.5

    // High PFC, low DMN = analytical
    if (pfc > 0.7 && dmn < 0.4) return 'analytical'

    // High DMN, moderate PFC = creative
    if (dmn > 0.7 && pfc > 0.5) return 'creative'

    // High amygdala, low PFC = intuitive
    if (amg > 0.7 && pfc < 0.5) return 'intuitive'

    // High PFC, high hippocampus = methodical
    if (pfc > 0.6 && (profile.hippocampus?.efficiency || 0.5) > 0.6) return 'methodical'

    // Low across the board = chaotic
    return rng() > 0.5 ? 'chaotic' : 'intuitive'
  }

  /**
   * Generate genetic factors (innate traits)
   */
  private generateGeneticFactors(rng: () => number): Record<string, number> {
    return {
      intelligenceBaseline: 0.4 + rng() * 0.4,
      emotionalReactivity: 0.3 + rng() * 0.5,
      noveltySeek: 0.3 + rng() * 0.5,
      harmAvoidance: 0.3 + rng() * 0.5,
      rewardDependence: 0.3 + rng() * 0.5,
      persistence: 0.3 + rng() * 0.5,
      selfDirectedness: 0.3 + rng() * 0.5,
      cooperativeness: 0.3 + rng() * 0.5,
      selfTranscendence: 0.2 + rng() * 0.4
    }
  }

  /**
   * Generate developmental factors (life-shaped traits)
   */
  private generateDevelopmentalFactors(rng: () => number): Record<string, number> {
    return {
      earlyExperienceQuality: 0.4 + rng() * 0.4,
      socialSupportLevel: 0.4 + rng() * 0.4,
      traumaExposure: rng() * 0.3, // Low is good
      learningOpportunities: 0.4 + rng() * 0.4,
      culturalEnrichment: 0.4 + rng() * 0.4,
      adversityResilience: 0.3 + rng() * 0.5
    }
  }

  /**
   * Pick random specializations
   */
  private pickSpecializations(rng: () => number, options: string[], count: number = 3): string[] {
    const shuffled = [...options].sort(() => rng() - 0.5)
    return shuffled.slice(0, count)
  }

  /**
   * Pick randomly from array
   */
  private pickRandomly<T>(rng: () => number, options: T[]): T {
    return options[Math.floor(rng() * options.length)]
  }

  /**
   * Hash bot ID to seed
   */
  private hashBotId(botId: string): number {
    let hash = 0
    for (let i = 0; i < botId.length; i++) {
      hash = ((hash << 5) - hash) + botId.charCodeAt(i)
      hash |= 0
    }
    return Math.abs(hash)
  }

  /**
   * Seeded random number generator
   */
  private seededRandom(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
  }

  /**
   * Get neural profile for bot
   */
  getNeuralProfile(botId: string): BotNeuralProfile | null {
    return this.botNeuralProfiles.get(botId) || null
  }

  /**
   * Calculate region collaboration for a task
   * Different tasks activate different brain regions
   */
  calculateRegionActivation(
    botId: string,
    task: 'memory' | 'emotion' | 'planning' | 'language' | 'creativity' | 'skill'
  ): Map<string, number> {
    const profile = this.getNeuralProfile(botId)
    if (!profile) return new Map()

    const activation = new Map<string, number>()

    // Task-specific activation patterns
    const patterns: Record<string, Partial<Record<string, number>>> = {
      memory: {
        hpc: 1.0,
        pfc: 0.6,
        tmp: 0.5,
        amg: 0.4
      },
      emotion: {
        amg: 1.0,
        pfc: 0.5,
        hpc: 0.6,
        dmn: 0.4
      },
      planning: {
        pfc: 1.0,
        par: 0.6,
        hpc: 0.5,
        tmp: 0.4
      },
      language: {
        tmp: 1.0,
        pfc: 0.6,
        par: 0.4,
        dmn: 0.3
      },
      creativity: {
        dmn: 1.0,
        occ: 0.7,
        tmp: 0.6,
        pfc: 0.4
      },
      skill: {
        cer: 1.0,
        par: 0.6,
        pfc: 0.5,
        hpc: 0.4
      }
    }

    const taskPattern = patterns[task] || {}

    // Apply activation pattern with region efficiency
    Object.entries(taskPattern).forEach(([regionId, baseActivation]) => {
      const region = this.getRegionById(profile, regionId)
      if (region) {
        const finalActivation = baseActivation * region.efficiency * (0.8 + Math.random() * 0.4)
        activation.set(regionId, Math.min(1, finalActivation))
      }
    })

    return activation
  }

  /**
   * Get brain region by ID
   */
  private getRegionById(profile: BotNeuralProfile, regionId: string): BotBrainRegion | null {
    const regionMap: Record<string, BotBrainRegion> = {
      pfc: profile.prefrontalCortex,
      hpc: profile.hippocampus,
      amg: profile.amygdala,
      tmp: profile.temporalLobe,
      par: profile.parietalLobe,
      occ: profile.occipitalLobe,
      cer: profile.cerebellum,
      dmn: profile.defaultModeNetwork
    }
    return regionMap[regionId] || null
  }

  /**
   * Neuroplasticity: Update brain regions based on experience
   */
  async experienceShapesBrain(
    botId: string,
    experienceType: 'learning' | 'trauma' | 'joy' | 'repetition' | 'novelty',
    intensity: number
  ): Promise<void> {
    const profile = this.getNeuralProfile(botId)
    if (!profile) return

    const plasticityFactor = profile.neuralPlasticity * intensity

    // Different experiences strengthen different regions
    switch (experienceType) {
      case 'learning':
        profile.hippocampus.efficiency = Math.min(1, profile.hippocampus.efficiency + plasticityFactor * 0.05)
        profile.prefrontalCortex.efficiency = Math.min(1, profile.prefrontalCortex.efficiency + plasticityFactor * 0.03)
        break

      case 'trauma':
        profile.amygdala.dominance = Math.min(1, profile.amygdala.dominance + plasticityFactor * 0.1)
        profile.prefrontalCortex.efficiency = Math.max(0.3, profile.prefrontalCortex.efficiency - plasticityFactor * 0.05)
        break

      case 'joy':
        profile.defaultModeNetwork.activationLevel = Math.min(1, profile.defaultModeNetwork.activationLevel + plasticityFactor * 0.05)
        profile.amygdala.dominance = Math.max(0.1, profile.amygdala.dominance - plasticityFactor * 0.03)
        break

      case 'repetition':
        profile.cerebellum.efficiency = Math.min(1, profile.cerebellum.efficiency + plasticityFactor * 0.07)
        profile.hippocampus.efficiency = Math.min(1, profile.hippocampus.efficiency + plasticityFactor * 0.04)
        break

      case 'novelty':
        profile.occipitalLobe.activationLevel = Math.min(1, profile.occipitalLobe.activationLevel + plasticityFactor * 0.06)
        profile.defaultModeNetwork.efficiency = Math.min(1, profile.defaultModeNetwork.efficiency + plasticityFactor * 0.04)
        break
    }

    // Store updated profile
    this.botNeuralProfiles.set(botId, profile)

    this.payload.logger.info(
      `Neuroplasticity: ${experienceType} experience (intensity ${intensity}) shaped ${botId}'s brain`
    )
  }

  /**
   * Get bot's unique processing characteristics
   */
  getProcessingCharacteristics(botId: string): {
    speed: number
    capacity: number
    style: string
    strengths: string[]
    weaknesses: string[]
  } | null {
    const profile = this.getNeuralProfile(botId)
    if (!profile) return null

    // Find strongest and weakest regions
    const regions = [
      profile.prefrontalCortex,
      profile.hippocampus,
      profile.amygdala,
      profile.temporalLobe,
      profile.parietalLobe,
      profile.occipitalLobe,
      profile.cerebellum,
      profile.defaultModeNetwork
    ]

    const sortedByEfficiency = [...regions].sort((a, b) => b.efficiency - a.efficiency)
    const strengths = sortedByEfficiency.slice(0, 3).flatMap(r => r.specializations.slice(0, 2))
    const weaknesses = sortedByEfficiency.slice(-2).flatMap(r => r.specializations.slice(0, 1))

    return {
      speed: profile.processingSpeed,
      capacity: profile.workingMemoryCapacity,
      style: profile.thinkingStyle,
      strengths,
      weaknesses
    }
  }
}

/**
 * Singleton
 */
let multiAgentComposer: MultiAgentBotComposer | null = null

export function getMultiAgentComposer(payload: Payload): MultiAgentBotComposer {
  if (!multiAgentComposer) {
    multiAgentComposer = new MultiAgentBotComposer(payload)
  }
  return multiAgentComposer
}
