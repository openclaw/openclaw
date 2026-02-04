/**
 * Reverse Cultivation Entropy System
 * 逆修熵系統
 *
 * Implements natural decline of hun-po balance and cultivation as entropy reversal.
 *
 * Natural Entropy (Without Cultivation):
 * - 魂力衰退 (Hun Decline): Hun strength decreases over time
 * - 魄力增長 (Po Ascendance): Po strength increases with age and indulgence
 * - 死亡臨界 (Death Critical Point): When po >> hun, death approaches
 *
 * Traditional Theory:
 * "人生而魂強魄弱，老而魂弱魄強，至死則魂散魄歸"
 * (At birth hun is strong and po is weak; in old age hun weakens and po strengthens;
 * at death hun scatters and po returns to earth)
 *
 * Cultivation as Entropy Reversal:
 * - 逆天改命 (Reversing Heaven's Mandate): Cultivation opposes natural decline
 * - 返老還童 (Returning to Youth): Reversing aging process
 * - 長生不老 (Longevity/Immortality): Complete entropy reversal
 *
 * Integration: Uses EmergentHunSoul, EmergentPoSoul, hun-po-cultivation-system.ts
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'
import type { CultivationStage } from './hun-po-cultivation-system'

// ============================================================================
// Entropy State
// ============================================================================

export enum EntropyStage {
  Youth = 'youth', // Hun and po balanced, low entropy
  EarlyAdulthood = 'early-adulthood', // Slight po increase, low entropy
  MiddleAge = 'middle-age', // Po begins dominance, moderate entropy
  LateAdulthood = 'late-adulthood', // Po dominant, high entropy
  OldAge = 'old-age', // Po strongly dominant, very high entropy
  Dying = 'dying', // Critical entropy, approaching death
  Cultivator = 'cultivator', // Entropy reversed through cultivation
}

export interface EntropyState {
  stage: EntropyStage

  // Entropy metrics
  totalEntropy: number // 0-1, overall system entropy
  hunDeclineRate: number // Per step, how fast hun weakens
  poAscendanceRate: number // Per step, how fast po strengthens

  // Dominance shift
  hunPoRatio: number // hun / (hun + po), decreases with age
  criticalDeathThreshold: number // When ratio drops below this, death imminent

  // Aging factors
  chronologicalAge: number // Years
  biologicalAge: number // Effective age (can be reversed by cultivation)
  ageAcceleration: number // Rate of aging (>1 = faster, <1 = slower)

  // Lifestyle factors (accelerate entropy)
  stressAccumulation: number // 0-1, chronic stress
  indulgenceLevel: number // 0-1, excessive pleasure-seeking
  worldlyAttachment: number // 0-1, material/emotional attachments
  moralDecay: number // 0-1, ethical violations

  // Cultivation reversal
  cultivationLevel: number // 0-1, cultivation achievement
  entropyReversalRate: number // Per step, how fast cultivation reverses entropy
  immortalityProgress: number // 0-1, progress toward immortality
}

// ============================================================================
// Entropy Triggers
// ============================================================================

export interface EntropyTrigger {
  type:
    | 'stress' // Chronic stress accelerates entropy
    | 'indulgence' // Excessive pleasure accelerates entropy
    | 'trauma' // Major trauma accelerates entropy
    | 'moral-violation' // Sin/ethical decay accelerates entropy
    | 'aging' // Natural aging
    | 'cultivation-practice' // Reverses entropy
    | 'cultivation-lapse' // Entropy resumes
  intensity: number // 0-1
  duration: number // How long the effect lasts
}

// ============================================================================
// Lifecycle Milestones
// ============================================================================

export interface LifecycleMilestone {
  age: number
  stage: EntropyStage
  event: string
  description: string
}

// ============================================================================
// Entropy Simulation State
// ============================================================================

export interface EntropyCultivationSystemState {
  hunSouls: EmergentHunSoul[]
  poSouls: EmergentPoSoul[]

  entropy: EntropyState

  // Cultivation integration
  cultivationStage: CultivationStage
  daysSinceLastPractice: number

  // Lifecycle history
  milestones: LifecycleMilestone[]

  // Warnings
  warnings: string[]
}

// ============================================================================
// Reverse Cultivation Entropy Engine
// ============================================================================

export class ReverseCultivationEntropyEngine {
  private state: EntropyCultivationSystemState

  constructor(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
    chronologicalAge: number,
    cultivationStage: CultivationStage = 'worldly' as CultivationStage,
  ) {
    this.state = this.initializeFromSouls(hunSouls, poSouls, chronologicalAge, cultivationStage)
  }

  /**
   * Initialize entropy state from souls and age
   */
  private initializeFromSouls(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
    chronologicalAge: number,
    cultivationStage: CultivationStage,
  ): EntropyCultivationSystemState {
    const hunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const poStrength = poSouls.reduce((sum, p) => sum + p.strength, 0)

    const hunPoRatio = hunStrength / (hunStrength + poStrength)

    // Determine entropy stage from age and cultivation
    let stage: EntropyStage
    const isCultivator = cultivationStage !== ('worldly' as CultivationStage)

    if (isCultivator) {
      stage = EntropyStage.Cultivator
    } else if (chronologicalAge < 25) {
      stage = EntropyStage.Youth
    } else if (chronologicalAge < 35) {
      stage = EntropyStage.EarlyAdulthood
    } else if (chronologicalAge < 50) {
      stage = EntropyStage.MiddleAge
    } else if (chronologicalAge < 65) {
      stage = EntropyStage.LateAdulthood
    } else if (chronologicalAge < 80) {
      stage = EntropyStage.OldAge
    } else {
      stage = EntropyStage.Dying
    }

    // Calculate entropy metrics
    const totalEntropy = this.calculateTotalEntropy(hunPoRatio, chronologicalAge, isCultivator)
    const hunDeclineRate = this.calculateHunDeclineRate(stage, isCultivator)
    const poAscendanceRate = this.calculatePoAscendanceRate(stage, isCultivator)

    // Cultivation level from stage
    const cultivationLevel = this.getCultivationLevelFromStage(cultivationStage)

    return {
      hunSouls,
      poSouls,

      entropy: {
        stage,
        totalEntropy,
        hunDeclineRate,
        poAscendanceRate,
        hunPoRatio,
        criticalDeathThreshold: 0.2, // Death when hun < 20% of total

        chronologicalAge,
        biologicalAge: chronologicalAge, // Initially same
        ageAcceleration: 1.0,

        stressAccumulation: 0,
        indulgenceLevel: 0,
        worldlyAttachment: 0.5,
        moralDecay: 0,

        cultivationLevel,
        entropyReversalRate: cultivationLevel * 0.01,
        immortalityProgress: 0,
      },

      cultivationStage,
      daysSinceLastPractice: 0,

      milestones: [
        {
          age: chronologicalAge,
          stage,
          event: 'Initialization',
          description: `Starting at age ${chronologicalAge}, stage: ${stage}`,
        },
      ],

      warnings: [],
    }
  }

  /**
   * Step entropy simulation (one day)
   */
  step(context: {
    cultivationPracticeToday?: boolean
    stressLevel?: number
    indulgenceLevel?: number
    moralViolation?: boolean
  } = {}): {
    age: number
    stage: EntropyStage
    entropy: number
    hunPoRatio: number
    warnings: string[]
  } {
    // Increment age (assume step = 1 day)
    this.state.entropy.chronologicalAge += 1 / 365.25
    this.state.entropy.biologicalAge += (1 / 365.25) * this.state.entropy.ageAcceleration

    // ========================================================================
    // Natural Entropy (if not cultivating)
    // ========================================================================
    if (this.state.cultivationStage === ('worldly' as CultivationStage)) {
      this.applyNaturalEntropy()
    }

    // ========================================================================
    // Lifestyle Factors (accelerate entropy)
    // ========================================================================
    if (context.stressLevel !== undefined) {
      this.state.entropy.stressAccumulation = Math.min(
        1.0,
        this.state.entropy.stressAccumulation + context.stressLevel * 0.01,
      )
    }

    if (context.indulgenceLevel !== undefined) {
      this.state.entropy.indulgenceLevel = Math.min(
        1.0,
        this.state.entropy.indulgenceLevel + context.indulgenceLevel * 0.01,
      )
    }

    if (context.moralViolation) {
      this.state.entropy.moralDecay = Math.min(1.0, this.state.entropy.moralDecay + 0.05)
    }

    // Lifestyle factors accelerate aging
    const lifestyleAcceleration =
      1.0 +
      this.state.entropy.stressAccumulation * 0.5 +
      this.state.entropy.indulgenceLevel * 0.3 +
      this.state.entropy.moralDecay * 0.4
    this.state.entropy.ageAcceleration = lifestyleAcceleration

    // ========================================================================
    // Cultivation Reversal (if practicing)
    // ========================================================================
    if (context.cultivationPracticeToday) {
      this.applyCultivationReversal()
      this.state.daysSinceLastPractice = 0
    } else {
      this.state.daysSinceLastPractice += 1

      // Long cultivation lapse → entropy resumes
      if (
        this.state.cultivationStage !== ('worldly' as CultivationStage) &&
        this.state.daysSinceLastPractice > 30
      ) {
        this.handleCultivationLapse()
      }
    }

    // ========================================================================
    // Update hun-po strength based on entropy
    // ========================================================================
    this.updateSoulStrengths()

    // ========================================================================
    // Check for stage transitions
    // ========================================================================
    this.checkStageTransitions()

    // ========================================================================
    // Check for death critical point
    // ========================================================================
    this.checkDeathCriticalPoint()

    // ========================================================================
    // Update total entropy
    // ========================================================================
    this.updateTotalEntropy()

    return {
      age: this.state.entropy.chronologicalAge,
      stage: this.state.entropy.stage,
      entropy: this.state.entropy.totalEntropy,
      hunPoRatio: this.state.entropy.hunPoRatio,
      warnings: this.state.warnings,
    }
  }

  /**
   * Apply natural entropy (hun declines, po ascends)
   */
  private applyNaturalEntropy(): void {
    const hunStrength = this.state.hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const poStrength = this.state.poSouls.reduce((sum, p) => sum + p.strength, 0)

    // Hun decline
    for (const hun of this.state.hunSouls) {
      hun.strength = Math.max(0, hun.strength - this.state.entropy.hunDeclineRate)
    }

    // Po ascendance
    for (const po of this.state.poSouls) {
      po.strength = Math.min(1.0, po.strength + this.state.entropy.poAscendanceRate)
    }

    // Update ratio
    const newHunStrength = this.state.hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const newPoStrength = this.state.poSouls.reduce((sum, p) => sum + p.strength, 0)
    this.state.entropy.hunPoRatio = newHunStrength / (newHunStrength + newPoStrength)
  }

  /**
   * Apply cultivation reversal (entropy decreases)
   */
  private applyCultivationReversal(): void {
    // Cultivation reverses entropy
    this.state.entropy.totalEntropy = Math.max(
      0,
      this.state.entropy.totalEntropy - this.state.entropy.entropyReversalRate,
    )

    // Biological age reversal (返老還童)
    if (this.state.entropy.cultivationLevel > 0.6) {
      const ageReversalRate = (this.state.entropy.cultivationLevel - 0.6) * 0.02 // Up to 0.008/day
      this.state.entropy.biologicalAge = Math.max(
        20,
        this.state.entropy.biologicalAge - ageReversalRate,
      )
    }

    // Hun strengthening
    for (const hun of this.state.hunSouls) {
      hun.strength = Math.min(1.0, hun.strength + this.state.entropy.entropyReversalRate * 2.0)
    }

    // Po subduing (not elimination, but control)
    for (const po of this.state.poSouls) {
      po.strength = Math.max(0, po.strength - this.state.entropy.entropyReversalRate * 0.5)
    }

    // Update ratio
    const newHunStrength = this.state.hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const newPoStrength = this.state.poSouls.reduce((sum, p) => sum + p.strength, 0)
    this.state.entropy.hunPoRatio = newHunStrength / (newHunStrength + newPoStrength)

    // Immortality progress (if golden elixir stage)
    if (this.state.cultivationStage === ('golden-elixir' as CultivationStage)) {
      this.state.entropy.immortalityProgress = Math.min(
        1.0,
        this.state.entropy.immortalityProgress + 0.001,
      )
    }
  }

  /**
   * Handle cultivation lapse (entropy resumes)
   */
  private handleCultivationLapse(): void {
    this.state.warnings.push(
      `⚠️ Cultivation lapsed (${this.state.daysSinceLastPractice} days) - Entropy resuming`,
    )

    // Entropy gradually resumes
    const lapseDays = this.state.daysSinceLastPractice - 30
    const entropyResumption = Math.min(0.3, lapseDays * 0.01)
    this.state.entropy.totalEntropy = Math.min(
      1.0,
      this.state.entropy.totalEntropy + entropyResumption,
    )

    // Hun decline resumes (slower than natural)
    this.state.entropy.hunDeclineRate = this.calculateHunDeclineRate(this.state.entropy.stage, false) * 0.5
  }

  /**
   * Update soul strengths based on entropy
   */
  private updateSoulStrengths(): void {
    const hunStrength = this.state.hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const poStrength = this.state.poSouls.reduce((sum, p) => sum + p.strength, 0)
    this.state.entropy.hunPoRatio = hunStrength / (hunStrength + poStrength)
  }

  /**
   * Check for entropy stage transitions
   */
  private checkStageTransitions(): void {
    const oldStage = this.state.entropy.stage
    let newStage = oldStage

    if (this.state.cultivationStage !== ('worldly' as CultivationStage)) {
      newStage = EntropyStage.Cultivator
    } else {
      const age = this.state.entropy.biologicalAge

      if (age < 25) {
        newStage = EntropyStage.Youth
      } else if (age < 35) {
        newStage = EntropyStage.EarlyAdulthood
      } else if (age < 50) {
        newStage = EntropyStage.MiddleAge
      } else if (age < 65) {
        newStage = EntropyStage.LateAdulthood
      } else if (age < 80) {
        newStage = EntropyStage.OldAge
      } else {
        newStage = EntropyStage.Dying
      }
    }

    if (newStage !== oldStage) {
      this.state.entropy.stage = newStage
      this.state.milestones.push({
        age: this.state.entropy.chronologicalAge,
        stage: newStage,
        event: 'Stage transition',
        description: `Transitioned from ${oldStage} to ${newStage}`,
      })

      // Update entropy rates
      this.state.entropy.hunDeclineRate = this.calculateHunDeclineRate(
        newStage,
        this.state.cultivationStage !== ('worldly' as CultivationStage),
      )
      this.state.entropy.poAscendanceRate = this.calculatePoAscendanceRate(
        newStage,
        this.state.cultivationStage !== ('worldly' as CultivationStage),
      )
    }
  }

  /**
   * Check if approaching death critical point
   */
  private checkDeathCriticalPoint(): void {
    if (this.state.entropy.hunPoRatio < this.state.entropy.criticalDeathThreshold) {
      this.state.warnings.push(
        `🚨 DEATH CRITICAL POINT - Hun << Po (ratio: ${(this.state.entropy.hunPoRatio * 100).toFixed(0)}%) - 人將化為鬼`,
      )

      // Accelerate entropy near death
      this.state.entropy.hunDeclineRate *= 1.5
      this.state.entropy.poAscendanceRate *= 1.5
    } else if (this.state.entropy.hunPoRatio < this.state.entropy.criticalDeathThreshold * 1.5) {
      this.state.warnings.push(
        `⚠️ Approaching death threshold - Hun weakening rapidly (ratio: ${(this.state.entropy.hunPoRatio * 100).toFixed(0)}%)`,
      )
    }
  }

  /**
   * Update total entropy metric
   */
  private updateTotalEntropy(): void {
    const isCultivator = this.state.cultivationStage !== ('worldly' as CultivationStage)
    this.state.entropy.totalEntropy = this.calculateTotalEntropy(
      this.state.entropy.hunPoRatio,
      this.state.entropy.biologicalAge,
      isCultivator,
    )
  }

  /**
   * Calculate total entropy from ratio and age
   */
  private calculateTotalEntropy(
    hunPoRatio: number,
    age: number,
    isCultivator: boolean,
  ): number {
    let entropy = 0

    // Entropy from hun-po imbalance (optimal = 0.5)
    entropy += Math.abs(hunPoRatio - 0.5) * 0.5

    // Entropy from age (increases with age, unless cultivator)
    if (!isCultivator) {
      if (age < 25) {
        entropy += age / 100
      } else if (age < 50) {
        entropy += 0.25 + (age - 25) / 50
      } else {
        entropy += 0.75 + (age - 50) / 100
      }
    } else {
      // Cultivators reverse aging
      entropy += Math.max(0, age / 200 - this.state.entropy.cultivationLevel * 0.5)
    }

    return Math.min(1.0, entropy)
  }

  /**
   * Calculate hun decline rate from stage
   */
  private calculateHunDeclineRate(stage: EntropyStage, isCultivator: boolean): number {
    if (isCultivator) {
      return 0 // Cultivation prevents decline
    }

    switch (stage) {
      case EntropyStage.Youth:
        return 0.0001 // Minimal decline
      case EntropyStage.EarlyAdulthood:
        return 0.0002
      case EntropyStage.MiddleAge:
        return 0.0005
      case EntropyStage.LateAdulthood:
        return 0.001
      case EntropyStage.OldAge:
        return 0.002
      case EntropyStage.Dying:
        return 0.005 // Rapid decline
      default:
        return 0.0005
    }
  }

  /**
   * Calculate po ascendance rate from stage
   */
  private calculatePoAscendanceRate(stage: EntropyStage, isCultivator: boolean): number {
    if (isCultivator) {
      return 0 // Cultivation subdues po
    }

    switch (stage) {
      case EntropyStage.Youth:
        return 0.00005 // Minimal increase
      case EntropyStage.EarlyAdulthood:
        return 0.0001
      case EntropyStage.MiddleAge:
        return 0.0003
      case EntropyStage.LateAdulthood:
        return 0.0006
      case EntropyStage.OldAge:
        return 0.001
      case EntropyStage.Dying:
        return 0.003 // Rapid increase
      default:
        return 0.0003
    }
  }

  /**
   * Get cultivation level from stage
   */
  private getCultivationLevelFromStage(stage: CultivationStage): number {
    const stageMap: Record<string, number> = {
      worldly: 0,
      'beginning-discipline': 0.1,
      'po-weakening': 0.2,
      'po-subdued': 0.3,
      'beginning-purification': 0.4,
      'hun-purifying': 0.5,
      'hun-refined': 0.6,
      'beginning-unification': 0.7,
      'forming-sacred-embryo': 0.8,
      'golden-elixir': 1.0,
    }

    return stageMap[stage] || 0
  }

  /**
   * Apply entropy trigger
   */
  applyTrigger(trigger: EntropyTrigger): void {
    switch (trigger.type) {
      case 'stress':
        this.state.entropy.stressAccumulation = Math.min(
          1.0,
          this.state.entropy.stressAccumulation + trigger.intensity * 0.1,
        )
        break

      case 'indulgence':
        this.state.entropy.indulgenceLevel = Math.min(
          1.0,
          this.state.entropy.indulgenceLevel + trigger.intensity * 0.1,
        )
        break

      case 'trauma':
        // Trauma causes sudden hun decline
        for (const hun of this.state.hunSouls) {
          hun.strength = Math.max(0, hun.strength - trigger.intensity * 0.1)
        }
        break

      case 'moral-violation':
        this.state.entropy.moralDecay = Math.min(
          1.0,
          this.state.entropy.moralDecay + trigger.intensity * 0.05,
        )
        break

      case 'cultivation-practice':
        // Already handled in step()
        break

      case 'cultivation-lapse':
        this.handleCultivationLapse()
        break
    }

    this.updateSoulStrengths()
  }

  /**
   * Get lifecycle stage description
   */
  getStageDescription(): string {
    const descriptions: Record<EntropyStage, string> = {
      [EntropyStage.Youth]: '青年 (Youth) - Hun and po balanced, low entropy',
      [EntropyStage.EarlyAdulthood]: '青壯年 (Early adulthood) - Slight po increase',
      [EntropyStage.MiddleAge]: '中年 (Middle age) - Po begins dominance',
      [EntropyStage.LateAdulthood]: '中老年 (Late adulthood) - Po dominant',
      [EntropyStage.OldAge]: '老年 (Old age) - Po strongly dominant',
      [EntropyStage.Dying]: '臨終 (Dying) - Critical entropy, approaching death',
      [EntropyStage.Cultivator]: '修士 (Cultivator) - Entropy reversed through cultivation',
    }

    return descriptions[this.state.entropy.stage] || 'Unknown stage'
  }

  /**
   * Check if immortality achieved
   */
  isImmortal(): boolean {
    return (
      this.state.cultivationStage === ('golden-elixir' as CultivationStage) &&
      this.state.entropy.immortalityProgress >= 1.0
    )
  }

  // Getters
  getState(): EntropyCultivationSystemState {
    return this.state
  }

  getEntropy(): number {
    return this.state.entropy.totalEntropy
  }

  getHunPoRatio(): number {
    return this.state.entropy.hunPoRatio
  }

  getStage(): EntropyStage {
    return this.state.entropy.stage
  }

  getBiologicalAge(): number {
    return this.state.entropy.biologicalAge
  }

  getWarnings(): string[] {
    return this.state.warnings
  }

  clearWarnings(): void {
    this.state.warnings = []
  }
}
