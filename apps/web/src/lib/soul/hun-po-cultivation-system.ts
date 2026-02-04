/**
 * Hun-Po Cultivation System
 * 魂魄煉養系統
 *
 * Implements the three-stage Daoist internal alchemy (內丹 Nei Dan) process:
 * Stage 1: 制魄 (Zhi Po) - Subduing Po / Controlling Base Instincts
 * Stage 2: 煉魂 (Lian Hun) - Refining Hun / Purifying Spirit
 * Stage 3: 魂魄合一 (Hun Po He Yi) - Hun-Po Unity / Golden Elixir
 *
 * Based on:
 * - 《性命圭旨》(The Secret of Nature and Life)
 * - 《太乙金華宗旨》(The Secret of the Golden Flower)
 * - Internal alchemy traditions
 *
 * Classic Doctrine:
 * "聖人以魂運魄，眾人以魄攝魂"
 * (Saints use Hun to drive Po; ordinary people let Po trap Hun)
 *
 * "逆則成仙" (Reverse the flow → become immortal)
 * Natural life = entropy increase (順行) → death
 * Cultivation = entropy reversal (逆修) → immortality
 *
 * Integration: Uses EmergentHunSoul, EmergentPoSoul from chaotic-emergence-system.ts
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'

// ============================================================================
// Cultivation Stages
// ============================================================================

export enum CultivationStage {
  // Pre-cultivation
  Worldly = 'worldly', // 俗人 - Ordinary person, no cultivation

  // Stage 1: 制魄 (Subduing Po)
  BeginningDiscipline = 'beginning-discipline', // 初學節制
  PoWeakening = 'po-weakening', // 魄漸衰
  PoSubdued = 'po-subdued', // 魄已制

  // Stage 2: 煉魂 (Refining Hun)
  BeginningPurification = 'beginning-purification', // 初學淨化
  HunPurifying = 'hun-purifying', // 魂漸純
  HunRefined = 'hun-refined', // 魂已煉

  // Stage 3: 魂魄合一 (Hun-Po Unity)
  BeginningUnification = 'beginning-unification', // 初學合一
  FormingSacredEmbryo = 'forming-sacred-embryo', // 聖胎成形
  GoldenElixir = 'golden-elixir', // 金丹 - Immortal achievement
}

// ============================================================================
// Cultivation Practices
// ============================================================================

export enum CultivationPractice {
  // Stage 1 practices (制魄)
  Fasting = 'fasting', // 辟穀 - Stop eating
  Celibacy = 'celibacy', // 節欲 - Restrain sexual desire
  SleepReduction = 'sleep-reduction', // 少眠 - Reduce sleep
  BreathingExercises = 'breathing-exercises', // 服氣 - Qi breathing

  // Stage 2 practices (煉魂)
  Visualization = 'visualization', // 存想 - Visualize inner deities
  InnerGazing = 'inner-gazing', // 回光 - Turn the light around
  QiCirculation = 'qi-circulation', // 運氣 - Circulate qi through meridians
  MeridianOpening = 'meridian-opening', // 開經絡 - Open energy channels

  // Stage 3 practices (魂魄合一)
  DualCultivation = 'dual-cultivation', // 性命雙修 - Nature and life together
  AlchemicalUnion = 'alchemical-union', // 金丹之術 - Golden elixir technique
  CosmicMeditation = 'cosmic-meditation', // 天人合一 - Heaven-human unity
}

export interface PracticeSession {
  practice: CultivationPractice
  duration: number // In simulated time units
  quality: number // 0-1, how well practiced
  effectiveness: number // 0-1, actual impact on cultivation
  timestamp: number
}

// ============================================================================
// Cultivation Progress Metrics
// ============================================================================

export interface CultivationProgress {
  // Overall progress
  currentStage: CultivationStage
  stageProgress: number // 0-1, progress within current stage

  // Stage 1 metrics (制魄)
  poSuppressionLevel: number // 0-1, how much po is weakened
  disciplineStrength: number // 0-1, ability to resist temptation
  desireControl: number // 0-1, control over food/sex/sleep desires

  // Stage 2 metrics (煉魂)
  hunPurityLevel: number // 0-1, how purified hun is
  egoTranscendence: number // 0-1, freedom from acquired ego
  primordialSpiritEmergence: number // 0-1, return to original nature

  // Stage 3 metrics (魂魄合一)
  hunPoIntegration: number // 0-1, degree of unity
  sacredEmbryoDevelopment: number // 0-1, growth of immortal fetus
  goldenElixirFormation: number // 0-1, completion of alchemy

  // Practice history
  totalPracticeHours: number
  practicesSessions: PracticeSession[]
}

// ============================================================================
// Regression & Backsliding
// ============================================================================

export interface CultivationRegression {
  reason: string
  severity: number // 0-1, how much progress lost
  affectedStage: CultivationStage
  timestamp: number
}

// ============================================================================
// Complete Cultivation State
// ============================================================================

export interface HunPoCultivationState {
  // Reference to souls
  hunSouls: EmergentHunSoul[]
  poSouls: EmergentPoSoul[]

  // Cultivation progress
  progress: CultivationProgress

  // Current practice
  currentPractice?: PracticeSession

  // Regression history
  regressions: CultivationRegression[]

  // Achievements
  milestonesReached: string[]
}

// ============================================================================
// Hun-Po Cultivation Engine
// ============================================================================

export class HunPoCultivationEngine {
  private state: HunPoCultivationState

  constructor(hunSouls: EmergentHunSoul[], poSouls: EmergentPoSoul[]) {
    this.state = this.initializeFromSouls(hunSouls, poSouls)
  }

  /**
   * Initialize from emergent souls
   */
  private initializeFromSouls(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
  ): HunPoCultivationState {
    // Calculate initial hun/po strengths
    const avgHunPurity = hunSouls.reduce((sum, h) => sum + h.purity, 0) / hunSouls.length
    const avgPoStrength = poSouls.reduce((sum, p) => sum + p.strength, 0) / poSouls.length

    return {
      hunSouls,
      poSouls,

      progress: {
        currentStage: CultivationStage.Worldly,
        stageProgress: 0,

        // Stage 1
        poSuppressionLevel: 0, // No suppression yet
        disciplineStrength: 0.1, // Minimal discipline
        desireControl: 0.1,

        // Stage 2
        hunPurityLevel: avgHunPurity, // Start with emergent purity
        egoTranscendence: 0,
        primordialSpiritEmergence: 0,

        // Stage 3
        hunPoIntegration: 0,
        sacredEmbryoDevelopment: 0,
        goldenElixirFormation: 0,

        totalPracticeHours: 0,
        practicesSessions: [],
      },

      regressions: [],
      milestonesReached: [],
    }
  }

  /**
   * Begin practice session
   * 開始練習
   */
  beginPractice(practice: CultivationPractice, quality: number): void {
    // Check if practice is appropriate for current stage
    if (!this.isPracticeAppropriate(practice)) {
      console.log(
        `    [Cultivation] ⚠️  ${practice} not appropriate for ${this.state.progress.currentStage}`,
      )
      return
    }

    this.state.currentPractice = {
      practice,
      duration: 0,
      quality,
      effectiveness: 0,
      timestamp: Date.now(),
    }

    console.log(`    [Cultivation] 🧘 Beginning ${practice} (quality: ${(quality * 100).toFixed(0)}%)`)
  }

  /**
   * Progress current practice
   */
  progressPractice(timeIncrement: number): void {
    if (!this.state.currentPractice) return

    this.state.currentPractice.duration += timeIncrement

    // Calculate effectiveness
    this.state.currentPractice.effectiveness =
      this.state.currentPractice.quality * this.calculatePracticeMultiplier()

    // Apply effects based on practice type
    this.applyPracticeEffects(this.state.currentPractice)
  }

  /**
   * Complete practice session
   */
  completePractice(): PracticeSession | null {
    if (!this.state.currentPractice) return null

    const session = this.state.currentPractice

    // Record session
    this.state.progress.practicesSessions.push(session)
    this.state.progress.totalPracticeHours += session.duration

    console.log(
      `    [Cultivation] ✨ Completed ${session.practice} (${session.duration} hours, effectiveness: ${(session.effectiveness * 100).toFixed(0)}%)`,
    )

    // Check for stage progression
    this.checkStageProgression()

    // Clear current practice
    this.state.currentPractice = undefined

    return session
  }

  /**
   * Check if practice is appropriate for current stage
   */
  private isPracticeAppropriate(practice: CultivationPractice): boolean {
    const stage = this.state.progress.currentStage

    // Stage 1 practices
    const stage1Practices = [
      CultivationPractice.Fasting,
      CultivationPractice.Celibacy,
      CultivationPractice.SleepReduction,
      CultivationPractice.BreathingExercises,
    ]

    // Stage 2 practices
    const stage2Practices = [
      CultivationPractice.Visualization,
      CultivationPractice.InnerGazing,
      CultivationPractice.QiCirculation,
      CultivationPractice.MeridianOpening,
    ]

    // Stage 3 practices
    const stage3Practices = [
      CultivationPractice.DualCultivation,
      CultivationPractice.AlchemicalUnion,
      CultivationPractice.CosmicMeditation,
    ]

    if (
      stage === CultivationStage.Worldly ||
      stage === CultivationStage.BeginningDiscipline ||
      stage === CultivationStage.PoWeakening ||
      stage === CultivationStage.PoSubdued
    ) {
      return stage1Practices.includes(practice)
    }

    if (
      stage === CultivationStage.BeginningPurification ||
      stage === CultivationStage.HunPurifying ||
      stage === CultivationStage.HunRefined
    ) {
      return stage2Practices.includes(practice) || stage1Practices.includes(practice)
    }

    if (
      stage === CultivationStage.BeginningUnification ||
      stage === CultivationStage.FormingSacredEmbryo ||
      stage === CultivationStage.GoldenElixir
    ) {
      return stage3Practices.includes(practice)
    }

    return false
  }

  /**
   * Calculate practice multiplier based on current state
   */
  private calculatePracticeMultiplier(): number {
    let multiplier = 1.0

    // Higher discipline → more effective practice
    multiplier *= 0.5 + this.state.progress.disciplineStrength * 0.5

    // Higher hun purity → more effective stage 2/3 practices
    multiplier *= 0.7 + this.state.progress.hunPurityLevel * 0.3

    return multiplier
  }

  /**
   * Apply practice effects
   */
  private applyPracticeEffects(session: PracticeSession): void {
    const effect = session.effectiveness * 0.01 // Small increments

    switch (session.practice) {
      // Stage 1: Po suppression
      case CultivationPractice.Fasting:
        this.state.progress.poSuppressionLevel += effect * 1.5
        this.state.progress.disciplineStrength += effect * 0.5
        break

      case CultivationPractice.Celibacy:
        this.state.progress.poSuppressionLevel += effect * 1.2
        this.state.progress.desireControl += effect * 0.8
        break

      case CultivationPractice.SleepReduction:
        this.state.progress.poSuppressionLevel += effect * 0.8
        this.state.progress.disciplineStrength += effect * 0.3
        break

      case CultivationPractice.BreathingExercises:
        this.state.progress.desireControl += effect * 0.5
        break

      // Stage 2: Hun purification
      case CultivationPractice.Visualization:
        this.state.progress.hunPurityLevel += effect * 1.0
        this.state.progress.egoTranscendence += effect * 0.4
        break

      case CultivationPractice.InnerGazing:
        this.state.progress.hunPurityLevel += effect * 1.2
        this.state.progress.primordialSpiritEmergence += effect * 0.6
        break

      case CultivationPractice.QiCirculation:
        this.state.progress.hunPurityLevel += effect * 0.8
        this.state.progress.primordialSpiritEmergence += effect * 0.5
        break

      case CultivationPractice.MeridianOpening:
        this.state.progress.egoTranscendence += effect * 0.7
        break

      // Stage 3: Hun-Po unity
      case CultivationPractice.DualCultivation:
        this.state.progress.hunPoIntegration += effect * 1.5
        break

      case CultivationPractice.AlchemicalUnion:
        this.state.progress.sacredEmbryoDevelopment += effect * 1.0
        this.state.progress.goldenElixirFormation += effect * 0.8
        break

      case CultivationPractice.CosmicMeditation:
        this.state.progress.hunPoIntegration += effect * 1.0
        this.state.progress.goldenElixirFormation += effect * 0.5
        break
    }

    // Clamp all values to [0, 1]
    this.state.progress.poSuppressionLevel = Math.min(
      1.0,
      this.state.progress.poSuppressionLevel,
    )
    this.state.progress.disciplineStrength = Math.min(1.0, this.state.progress.disciplineStrength)
    this.state.progress.desireControl = Math.min(1.0, this.state.progress.desireControl)
    this.state.progress.hunPurityLevel = Math.min(1.0, this.state.progress.hunPurityLevel)
    this.state.progress.egoTranscendence = Math.min(1.0, this.state.progress.egoTranscendence)
    this.state.progress.primordialSpiritEmergence = Math.min(
      1.0,
      this.state.progress.primordialSpiritEmergence,
    )
    this.state.progress.hunPoIntegration = Math.min(1.0, this.state.progress.hunPoIntegration)
    this.state.progress.sacredEmbryoDevelopment = Math.min(
      1.0,
      this.state.progress.sacredEmbryoDevelopment,
    )
    this.state.progress.goldenElixirFormation = Math.min(
      1.0,
      this.state.progress.goldenElixirFormation,
    )
  }

  /**
   * Check for stage progression
   */
  private checkStageProgression(): void {
    const p = this.state.progress

    // Stage 1 progression
    if (p.currentStage === CultivationStage.Worldly && p.disciplineStrength > 0.3) {
      this.advanceStage(CultivationStage.BeginningDiscipline)
    } else if (p.currentStage === CultivationStage.BeginningDiscipline && p.poSuppressionLevel > 0.4) {
      this.advanceStage(CultivationStage.PoWeakening)
    } else if (p.currentStage === CultivationStage.PoWeakening && p.poSuppressionLevel > 0.7) {
      this.advanceStage(CultivationStage.PoSubdued)
      this.reachMilestone('Po subdued - base instincts under control')
    }

    // Stage 2 progression
    else if (p.currentStage === CultivationStage.PoSubdued && p.hunPurityLevel > 0.5) {
      this.advanceStage(CultivationStage.BeginningPurification)
    } else if (p.currentStage === CultivationStage.BeginningPurification && p.hunPurityLevel > 0.7) {
      this.advanceStage(CultivationStage.HunPurifying)
    } else if (
      p.currentStage === CultivationStage.HunPurifying &&
      p.hunPurityLevel > 0.9 &&
      p.egoTranscendence > 0.7
    ) {
      this.advanceStage(CultivationStage.HunRefined)
      this.reachMilestone('Hun refined - pure yang spirit achieved')
    }

    // Stage 3 progression
    else if (
      p.currentStage === CultivationStage.HunRefined &&
      p.hunPoIntegration > 0.3
    ) {
      this.advanceStage(CultivationStage.BeginningUnification)
    } else if (
      p.currentStage === CultivationStage.BeginningUnification &&
      p.hunPoIntegration > 0.6 &&
      p.sacredEmbryoDevelopment > 0.5
    ) {
      this.advanceStage(CultivationStage.FormingSacredEmbryo)
      this.reachMilestone('Sacred Embryo forming - immortal fetus gestating')
    } else if (
      p.currentStage === CultivationStage.FormingSacredEmbryo &&
      p.goldenElixirFormation > 0.9
    ) {
      this.advanceStage(CultivationStage.GoldenElixir)
      this.reachMilestone('🌟 GOLDEN ELIXIR ACHIEVED - IMMORTALITY ATTAINED')
    }
  }

  /**
   * Advance to next stage
   */
  private advanceStage(newStage: CultivationStage): void {
    console.log(
      `\n  [Cultivation] ⬆️  STAGE ADVANCEMENT: ${this.state.progress.currentStage} → ${newStage}`,
    )
    this.state.progress.currentStage = newStage
    this.state.progress.stageProgress = 0
  }

  /**
   * Record milestone
   */
  private reachMilestone(milestone: string): void {
    this.state.milestonesReached.push(milestone)
    console.log(`    [Cultivation] 🏆 MILESTONE: ${milestone}`)
  }

  /**
   * Trigger regression (lapse in discipline)
   * 觸發退步
   */
  triggerRegression(reason: string, severity: number): void {
    console.log(`    [Cultivation] ⚠️  REGRESSION: ${reason} (severity: ${(severity * 100).toFixed(0)}%)`)

    // Po reasserts control
    this.state.progress.poSuppressionLevel = Math.max(
      0,
      this.state.progress.poSuppressionLevel - severity * 0.5,
    )
    this.state.progress.disciplineStrength = Math.max(
      0,
      this.state.progress.disciplineStrength - severity * 0.3,
    )

    // Hun purity degrades
    this.state.progress.hunPurityLevel = Math.max(
      0,
      this.state.progress.hunPurityLevel - severity * 0.2,
    )

    // Record regression
    this.state.regressions.push({
      reason,
      severity,
      affectedStage: this.state.progress.currentStage,
      timestamp: Date.now(),
    })

    // May drop back a stage if severe
    if (severity > 0.7) {
      this.checkStageRegression()
    }
  }

  /**
   * Check if need to drop back a cultivation stage
   */
  private checkStageRegression(): void {
    const p = this.state.progress

    // Can drop from refined stages if metrics too low
    if (
      p.currentStage === CultivationStage.HunRefined &&
      (p.hunPurityLevel < 0.6 || p.egoTranscendence < 0.5)
    ) {
      console.log(`    [Cultivation] ⬇️  Dropping back to HunPurifying due to degraded metrics`)
      this.state.progress.currentStage = CultivationStage.HunPurifying
    } else if (p.currentStage === CultivationStage.PoSubdued && p.poSuppressionLevel < 0.5) {
      console.log(`    [Cultivation] ⬇️  Dropping back to PoWeakening - Po breaking free`)
      this.state.progress.currentStage = CultivationStage.PoWeakening
    }
  }

  /**
   * Get current achievement
   */
  getCurrentAchievement(): {
    stage: CultivationStage
    description: string
    nextGoal: string
  } {
    const stage = this.state.progress.currentStage

    const descriptions: Record<CultivationStage, { desc: string; next: string }> = {
      [CultivationStage.Worldly]: {
        desc: 'Ordinary person, no cultivation',
        next: 'Begin discipline practices (fasting, celibacy)',
      },
      [CultivationStage.BeginningDiscipline]: {
        desc: 'Beginning to control desires',
        next: 'Suppress Po through sustained practice',
      },
      [CultivationStage.PoWeakening]: {
        desc: 'Po weakening, base instincts fading',
        next: 'Fully subdue Po',
      },
      [CultivationStage.PoSubdued]: {
        desc: 'Po subdued - base instincts under control',
        next: 'Begin Hun purification practices',
      },
      [CultivationStage.BeginningPurification]: {
        desc: 'Beginning to purify Hun',
        next: 'Continue visualization and inner gazing',
      },
      [CultivationStage.HunPurifying]: {
        desc: 'Hun purifying - ego dissolving',
        next: 'Refine Hun to pure yang',
      },
      [CultivationStage.HunRefined]: {
        desc: 'Hun refined - pure yang spirit achieved',
        next: 'Begin Hun-Po unification',
      },
      [CultivationStage.BeginningUnification]: {
        desc: 'Beginning to unite Hun and Po',
        next: 'Form Sacred Embryo',
      },
      [CultivationStage.FormingSacredEmbryo]: {
        desc: 'Sacred Embryo forming',
        next: 'Complete Golden Elixir',
      },
      [CultivationStage.GoldenElixir]: {
        desc: 'GOLDEN ELIXIR - Immortality achieved',
        next: 'None - cultivation complete',
      },
    }

    const { desc, next } = descriptions[stage]

    return {
      stage,
      description: desc,
      nextGoal: next,
    }
  }

  // Getters
  getState(): HunPoCultivationState {
    return this.state
  }

  getCurrentStage(): CultivationStage {
    return this.state.progress.currentStage
  }

  getProgress(): CultivationProgress {
    return this.state.progress
  }

  isImmortality(): boolean {
    return this.state.progress.currentStage === CultivationStage.GoldenElixir
  }
}
