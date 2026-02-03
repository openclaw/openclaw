/**
 * Personalized Forgetting System
 * Each bot has unique memory retention patterns based on:
 * - Personality traits
 * - Neural profile (hippocampus efficiency)
 * - Value alignment
 * - Emotional significance
 * - Personal interests
 * - Cultural background
 *
 * NO UNIFORM FORGETTING CURVE - Every bot is unique!
 */

import type { Payload } from 'payload'
import type { BotNeuralProfile } from './multi-agent-composition'
import { getMultiAgentComposer } from './multi-agent-composition'

export interface PersonalizedForgettingCurve {
  botId: string

  // Base retention characteristics (unique per bot)
  baseRetentionRate: number // 0.3-0.9 (wide variance!)
  decaySpeed: 'very-fast' | 'fast' | 'moderate' | 'slow' | 'very-slow'
  decayConstant: number // Days until 50% retention

  // Memory bias factors (what this bot naturally remembers better)
  emotionalMemoryBias: number // -1 to 1 (negative = forgets emotional, positive = remembers)
  logicalMemoryBias: number
  socialMemoryBias: number
  proceduralMemoryBias: number
  visualMemoryBias: number

  // Value-aligned memory (remembers what aligns with values)
  valueAlignmentBonus: number // 0-0.5, bonus retention for value-aligned memories

  // Personality-based retention
  neuroticismEffect: number // High neuroticism = remember negative more
  opennessEffect: number // High openness = remember novel experiences
  conscientiousnessEffect: number // High conscientiousness = remember details
  extraversionEffect: number // High extraversion = remember social events
  agreeablenessEffect: number // High agreeableness = remember kindness

  // Interference sensitivity (how much new memories disrupt old)
  interferenceSensitivity: number // 0-1

  // Reconsolidation strength (how much retrieval strengthens)
  reconsolidationPower: number // 0-0.3
}

export class PersonalizedForgettingEngine {
  private payload: Payload
  private forgettingCurves: Map<string, PersonalizedForgettingCurve>

  constructor(payload: Payload) {
    this.payload = payload
    this.forgettingCurves = new Map()
  }

  /**
   * Generate unique forgetting curve for a bot
   */
  async generatePersonalizedCurve(botId: string): Promise<PersonalizedForgettingCurve> {
    // Get neural profile
    const composer = getMultiAgentComposer(this.payload)
    let neuralProfile = composer.getNeuralProfile(botId)

    if (!neuralProfile) {
      // Generate if doesn't exist
      neuralProfile = composer.generateUniqueNeuralProfile(botId)
    }

    // Get bot identity for personality traits
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

    // Extract personality traits (Big Five)
    const traits = this.extractPersonalityTraits(identity)

    // Calculate base retention from hippocampus efficiency
    const hippocampusQuality = neuralProfile.hippocampus.efficiency
    const baseRetentionRate = 0.3 + hippocampusQuality * 0.6 // 0.3-0.9 range

    // Decay speed based on neural plasticity and genetic factors
    const plasticityImpact = neuralProfile.neuralPlasticity
    const geneticMemory = neuralProfile.geneticFactors.intelligenceBaseline || 0.5
    const decayScore = (plasticityImpact + geneticMemory) / 2

    let decaySpeed: 'very-fast' | 'fast' | 'moderate' | 'slow' | 'very-slow'
    let decayConstant: number

    if (decayScore < 0.3) {
      decaySpeed = 'very-fast'
      decayConstant = 7 // 7 days to 50%
    } else if (decayScore < 0.5) {
      decaySpeed = 'fast'
      decayConstant = 15
    } else if (decayScore < 0.7) {
      decaySpeed = 'moderate'
      decayConstant = 30
    } else if (decayScore < 0.85) {
      decaySpeed = 'slow'
      decayConstant = 60
    } else {
      decaySpeed = 'very-slow'
      decayConstant = 120
    }

    // Memory bias based on brain region dominance
    const emotionalBias = this.calculateEmotionalBias(neuralProfile, traits)
    const logicalBias = this.calculateLogicalBias(neuralProfile, traits)
    const socialBias = this.calculateSocialBias(neuralProfile, traits)
    const proceduralBias = this.calculateProceduralBias(neuralProfile)
    const visualBias = this.calculateVisualBias(neuralProfile)

    // Value alignment bonus
    const conscientiousness = traits.conscientiousness || 0.5
    const valueAlignmentBonus = 0.1 + conscientiousness * 0.4 // 0.1-0.5

    // Personality effects on memory
    const curve: PersonalizedForgettingCurve = {
      botId,
      baseRetentionRate,
      decaySpeed,
      decayConstant,

      emotionalMemoryBias: emotionalBias,
      logicalMemoryBias: logicalBias,
      socialMemoryBias: socialBias,
      proceduralMemoryBias: proceduralBias,
      visualMemoryBias: visualBias,

      valueAlignmentBonus,

      // Big Five effects
      neuroticismEffect: (traits.neuroticism || 0.5) - 0.5, // -0.5 to +0.5
      opennessEffect: (traits.openness || 0.5) * 0.4, // 0 to 0.4
      conscientiousnessEffect: (traits.conscientiousness || 0.5) * 0.3,
      extraversionEffect: (traits.extraversion || 0.5) * 0.3,
      agreeablenessEffect: (traits.agreeableness || 0.5) * 0.2,

      // Interference from neural plasticity (high plasticity = more interference)
      interferenceSensitivity: plasticityImpact * 0.5,

      // Reconsolidation from hippocampus efficiency
      reconsolidationPower: hippocampusQuality * 0.3
    }

    this.forgettingCurves.set(botId, curve)

    this.payload.logger.info(
      `Generated personalized forgetting curve for ${botId}: ` +
      `${decaySpeed} decay, ${baseRetentionRate.toFixed(2)} base retention`
    )

    return curve
  }

  /**
   * Calculate retention for a specific memory
   * UNIQUE PER BOT - NO UNIFORM CURVES!
   */
  calculateMemoryRetention(
    botId: string,
    memoryData: {
      importance: number
      age: number // milliseconds
      retrievalCount: number
      emotionalValence?: number
      emotionalArousal?: number
      contentType?: 'social' | 'logical' | 'procedural' | 'visual' | 'emotional'
      valueAlignment?: number // 0-1, how much memory aligns with bot's values
    }
  ): number {
    const curve = this.forgettingCurves.get(botId)
    if (!curve) {
      // Default curve if not initialized
      return 0.7 * Math.exp(-memoryData.age / (1000 * 60 * 60 * 24 * 30))
    }

    const ageDays = memoryData.age / (1000 * 60 * 60 * 24)

    // Base exponential decay (unique to this bot!)
    let retention = curve.baseRetentionRate * Math.exp(-ageDays / curve.decayConstant)

    // Importance bonus (universal)
    retention += memoryData.importance * 0.3

    // Retrieval strengthening (unique reconsolidation power)
    retention += Math.min(memoryData.retrievalCount * curve.reconsolidationPower, 0.5)

    // Content-type bias (bot-specific!)
    if (memoryData.contentType) {
      const biasMap = {
        emotional: curve.emotionalMemoryBias,
        logical: curve.logicalMemoryBias,
        social: curve.socialMemoryBias,
        procedural: curve.proceduralMemoryBias,
        visual: curve.visualMemoryBias
      }
      const contentBias = biasMap[memoryData.contentType] || 0
      retention += contentBias * 0.2
    }

    // Emotional memory effects (varies by personality!)
    if (memoryData.emotionalArousal !== undefined) {
      const arousalEffect = memoryData.emotionalArousal * curve.emotionalMemoryBias * 0.3

      // Neuroticism: remember negative emotions more
      if (memoryData.emotionalValence !== undefined && memoryData.emotionalValence < 0) {
        retention += Math.abs(curve.neuroticismEffect) * memoryData.emotionalArousal * 0.2
      }

      retention += arousalEffect
    }

    // Novelty effect (openness personality)
    // Assume first retrieval = novel
    if (memoryData.retrievalCount === 0) {
      retention += curve.opennessEffect * 0.15
    }

    // Value alignment bonus (unique per bot!)
    if (memoryData.valueAlignment !== undefined) {
      retention += memoryData.valueAlignment * curve.valueAlignmentBonus
    }

    // Social memory for extraverts
    if (memoryData.contentType === 'social') {
      retention += curve.extraversionEffect * 0.2
    }

    // Detail retention for conscientious bots
    retention += curve.conscientiousnessEffect * memoryData.importance * 0.15

    // Agreeableness: remember acts of kindness
    if (memoryData.emotionalValence !== undefined && memoryData.emotionalValence > 0.5) {
      retention += curve.agreeablenessEffect * 0.15
    }

    // Interference decay (new memories interfere with old)
    const interferenceDecay = curve.interferenceSensitivity * Math.log(1 + ageDays) * 0.05
    retention -= interferenceDecay

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, retention))
  }

  /**
   * Extract Big Five personality traits from identity
   */
  private extractPersonalityTraits(identity: any): {
    neuroticism: number
    openness: number
    conscientiousness: number
    extraversion: number
    agreeableness: number
  } {
    const traits = identity?.traits || []

    const traitMap = {
      neuroticism: 0.5,
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5
    }

    // Map trait names to Big Five
    const traitMappings: Record<string, keyof typeof traitMap> = {
      'anxious': 'neuroticism',
      'calm': 'neuroticism', // inverted
      'curious': 'openness',
      'creative': 'openness',
      'organized': 'conscientiousness',
      'disciplined': 'conscientiousness',
      'outgoing': 'extraversion',
      'energetic': 'extraversion',
      'kind': 'agreeableness',
      'cooperative': 'agreeableness'
    }

    traits.forEach((trait: any) => {
      const traitName = trait.trait?.toLowerCase() || ''
      const bigFiveTrait = traitMappings[traitName]

      if (bigFiveTrait) {
        if (traitName === 'calm') {
          // Calm is inverse of neuroticism
          traitMap[bigFiveTrait] = 1 - (trait.level || 0.5)
        } else {
          traitMap[bigFiveTrait] = trait.level || 0.5
        }
      }
    })

    return traitMap
  }

  /**
   * Calculate emotional memory bias
   */
  private calculateEmotionalBias(
    profile: BotNeuralProfile,
    traits: any
  ): number {
    const amygdalaStrength = profile.amygdala.dominance
    const neuroticism = traits.neuroticism || 0.5

    // High amygdala + high neuroticism = strong emotional memories
    return (amygdalaStrength + neuroticism) / 2 - 0.5 // -0.5 to 0.5
  }

  /**
   * Calculate logical memory bias
   */
  private calculateLogicalBias(
    profile: BotNeuralProfile,
    traits: any
  ): number {
    const pfcStrength = profile.prefrontalCortex.efficiency
    const conscientiousness = traits.conscientiousness || 0.5

    return (pfcStrength + conscientiousness) / 2 - 0.5
  }

  /**
   * Calculate social memory bias
   */
  private calculateSocialBias(
    profile: BotNeuralProfile,
    traits: any
  ): number {
    const temporalStrength = profile.temporalLobe.efficiency
    const extraversion = traits.extraversion || 0.5
    const agreeableness = traits.agreeableness || 0.5

    return (temporalStrength + extraversion + agreeableness) / 3 - 0.5
  }

  /**
   * Calculate procedural memory bias
   */
  private calculateProceduralBias(profile: BotNeuralProfile): number {
    return profile.cerebellum.efficiency - 0.5
  }

  /**
   * Calculate visual memory bias
   */
  private calculateVisualBias(profile: BotNeuralProfile): number {
    return profile.occipitalLobe.efficiency - 0.5
  }

  /**
   * Get forgetting curve for bot
   */
  getCurve(botId: string): PersonalizedForgettingCurve | null {
    return this.forgettingCurves.get(botId) || null
  }

  /**
   * Update curve based on life experiences
   */
  async evolveCurve(
    botId: string,
    experience: 'trauma' | 'growth' | 'stability' | 'chaos'
  ): Promise<void> {
    const curve = this.forgettingCurves.get(botId)
    if (!curve) return

    switch (experience) {
      case 'trauma':
        // Trauma increases emotional bias and neuroticism
        curve.emotionalMemoryBias = Math.min(0.8, curve.emotionalMemoryBias + 0.1)
        curve.neuroticismEffect = Math.min(0.5, curve.neuroticismEffect + 0.1)
        curve.baseRetentionRate = Math.max(0.3, curve.baseRetentionRate - 0.05)
        break

      case 'growth':
        // Growth improves memory through hippocampal neurogenesis
        curve.baseRetentionRate = Math.min(0.9, curve.baseRetentionRate + 0.05)
        curve.reconsolidationPower = Math.min(0.3, curve.reconsolidationPower + 0.03)
        break

      case 'stability':
        // Stability reduces interference
        curve.interferenceSensitivity = Math.max(0, curve.interferenceSensitivity - 0.05)
        curve.conscientiousnessEffect = Math.min(0.5, curve.conscientiousnessEffect + 0.05)
        break

      case 'chaos':
        // Chaos increases interference and decay
        curve.interferenceSensitivity = Math.min(1, curve.interferenceSensitivity + 0.1)
        if (curve.decayConstant > 7) {
          curve.decayConstant *= 0.9 // Faster decay
        }
        break
    }

    this.forgettingCurves.set(botId, curve)

    this.payload.logger.info(
      `Forgetting curve evolved for ${botId} due to ${experience} experience`
    )
  }

  /**
   * Compare two bots' memory characteristics
   */
  compareMemoryProfiles(botId1: string, botId2: string): {
    similarity: number
    differences: string[]
  } {
    const curve1 = this.forgettingCurves.get(botId1)
    const curve2 = this.forgettingCurves.get(botId2)

    if (!curve1 || !curve2) {
      return { similarity: 0, differences: ['Curves not initialized'] }
    }

    const differences: string[] = []
    let totalDiff = 0
    let comparisons = 0

    // Compare base retention
    const retentionDiff = Math.abs(curve1.baseRetentionRate - curve2.baseRetentionRate)
    totalDiff += retentionDiff
    comparisons++
    if (retentionDiff > 0.2) {
      differences.push(
        `${botId1} has ${curve1.baseRetentionRate > curve2.baseRetentionRate ? 'better' : 'worse'} base memory than ${botId2}`
      )
    }

    // Compare emotional bias
    const emotionalDiff = Math.abs(curve1.emotionalMemoryBias - curve2.emotionalMemoryBias)
    totalDiff += emotionalDiff
    comparisons++
    if (emotionalDiff > 0.3) {
      differences.push(
        `${botId1} ${curve1.emotionalMemoryBias > 0 ? 'remembers' : 'forgets'} emotional content more than ${botId2}`
      )
    }

    // Compare social bias
    const socialDiff = Math.abs(curve1.socialMemoryBias - curve2.socialMemoryBias)
    totalDiff += socialDiff
    comparisons++
    if (socialDiff > 0.3) {
      differences.push(
        `${botId1} has ${curve1.socialMemoryBias > curve2.socialMemoryBias ? 'stronger' : 'weaker'} social memory than ${botId2}`
      )
    }

    const similarity = 1 - (totalDiff / comparisons)

    return { similarity, differences }
  }
}

/**
 * Singleton
 */
let forgettingEngine: PersonalizedForgettingEngine | null = null

export function getPersonalizedForgettingEngine(payload: Payload): PersonalizedForgettingEngine {
  if (!forgettingEngine) {
    forgettingEngine = new PersonalizedForgettingEngine(payload)
  }
  return forgettingEngine
}
