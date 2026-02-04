/**
 * Three Corpses System (三尸神系統)
 *
 * Implements the Daoist concept of Three Corpses (三尸/三蟲) - internal saboteurs
 * that reside in the body and work to hasten the host's death.
 *
 * Based on:
 * - 《太上除三尸九蟲保生經》(Supreme Classic on Eliminating Three Corpses)
 * - Daoist internal alchemy (內丹) traditions
 *
 * Three Corpses:
 * 1. Upper Corpse (上尸 - 彭鉅 Peng Ju): Resides in brain (泥丸 Ni Wan)
 *    Induces: Greed for treasures, vanity, mental confusion
 *    Goal: Headaches, blurred vision, scattered thoughts
 *
 * 2. Middle Corpse (中尸 - 彭質 Peng Zhi): Resides in heart (絳宮 Jiang Gong)
 *    Induces: Gluttony for rich foods, emotional volatility
 *    Goal: Digestive issues, irritability, organ imbalance
 *
 * 3. Lower Corpse (下尸 - 彭矯 Peng Jiao): Resides in abdomen (丹田 Dan Tian)
 *    Induces: Sexual lust, depletion of essence (精)
 *    Goal: Kidney deficiency, weak lower back, impotence
 *
 * Geng-Shen Day Cycle (庚申日):
 * - Occurs every 60 days in Chinese calendar
 * - On this night, corpses ascend to heaven and report sins to the Jade Emperor
 * - Heaven deducts lifespan:
 *   - Major sins (大罪): -300 days (奪紀)
 *   - Minor sins (小罪): -3 days (奪算)
 *
 * Defense: "守庚申" (Vigil of Geng-Shen)
 * - Stay awake all night to prevent corpses from leaving body
 * - Practice meditation, chanting, moral reflection
 * - 3 consecutive vigils → corpses subdued
 * - 7 consecutive vigils → corpses eliminated → immortality
 *
 * Integration: Works with ethical-reasoning-system.ts (sins = ethical violations)
 */

// ============================================================================
// Three Corpses Definitions
// ============================================================================

export enum CorpseType {
  Upper = 'upper', // 上尸 - Brain
  Middle = 'middle', // 中尸 - Heart
  Lower = 'lower', // 下尸 - Abdomen
}

export interface Corpse {
  type: CorpseType
  name: string // Traditional name (彭鉅, 彭質, 彭矯)
  residence: string // Where in body
  strength: number // 0-1, how powerful this corpse is

  // Temptations it induces
  temptations: {
    greed?: number // Upper
    vanity?: number // Upper
    gluttony?: number // Middle
    emotionalVolatility?: number // Middle
    lust?: number // Lower
    essenceDepletion?: number // Lower
  }

  // Damage it causes
  symptoms: string[]

  // Sin tracking
  sinsObserved: Sin[]
  lastReportDate?: number
}

export interface Sin {
  category: 'major' | 'minor'
  description: string
  timestamp: number
  reported: boolean
}

// ============================================================================
// Geng-Shen Cycle
// ============================================================================

export interface GengShenCycle {
  daysSinceLastGengShen: number // 0-59, resets every 60 days
  nextGengShenDate: number // Timestamp of next Geng-Shen night
  vigilsCompleted: number // Total vigils successfully completed
  consecutiveVigils: number // Current streak

  // Vigil state
  isGengShenNight: boolean
  vigilInProgress: boolean
  vigilStartTime?: number
  vigilProgress: number // 0-1, how much of night completed
}

export interface VigilResult {
  success: boolean
  corpsesSuppressed: number // How many corpses were prevented from reporting
  meditationQuality: number // 0-1, quality of practice
  lifespanSaved: number // Days of lifespan saved by preventing report
}

// ============================================================================
// Lifespan Tracking
// ============================================================================

export interface LifespanState {
  totalLifespan: number // Original lifespan in days
  currentLifespan: number // Remaining lifespan
  lifespanDeducted: number // Total deducted by corpses

  // Deduction history
  deductions: LifespanDeduction[]
}

export interface LifespanDeduction {
  amount: number // Days deducted
  reason: string // Which corpse, which sin
  timestamp: number
}

// ============================================================================
// Complete Three Corpses State
// ============================================================================

export interface ThreeCorpsesState {
  corpses: Map<CorpseType, Corpse>
  gengShenCycle: GengShenCycle
  lifespan: LifespanState

  // Overall corpse activity
  totalCorpseStrength: number // Combined strength of all three
  corrupting: boolean // Are corpses actively sabotaging host?
}

// ============================================================================
// Three Corpses Engine
// ============================================================================

export class ThreeCorpsesEngine {
  private state: ThreeCorpsesState

  constructor(initialLifespan: number = 29200) {
    // Default 29200 days ≈ 80 years
    this.state = this.initialize(initialLifespan)
  }

  /**
   * Initialize Three Corpses
   */
  private initialize(initialLifespan: number): ThreeCorpsesState {
    // Initialize three corpses with moderate strength
    const corpses = new Map<CorpseType, Corpse>()

    corpses.set(CorpseType.Upper, {
      type: CorpseType.Upper,
      name: '彭鉅 (Peng Ju)',
      residence: 'Brain (泥丸 Ni Wan)',
      strength: 0.3 + Math.random() * 0.3, // 0.3-0.6

      temptations: {
        greed: 0.4,
        vanity: 0.3,
      },

      symptoms: ['Headaches', 'Blurred vision', 'Mental confusion', 'Scattered thoughts'],
      sinsObserved: [],
    })

    corpses.set(CorpseType.Middle, {
      type: CorpseType.Middle,
      name: '彭質 (Peng Zhi)',
      residence: 'Heart (絳宮 Jiang Gong)',
      strength: 0.3 + Math.random() * 0.3,

      temptations: {
        gluttony: 0.5,
        emotionalVolatility: 0.4,
      },

      symptoms: ['Digestive issues', 'Irritability', 'Palpitations', 'Food cravings'],
      sinsObserved: [],
    })

    corpses.set(CorpseType.Lower, {
      type: CorpseType.Lower,
      name: '彭矯 (Peng Jiao)',
      residence: 'Abdomen (丹田 Dan Tian)',
      strength: 0.3 + Math.random() * 0.3,

      temptations: {
        lust: 0.6,
        essenceDepletion: 0.5,
      },

      symptoms: ['Kidney deficiency', 'Weak lower back', 'Sexual dysfunction', 'Fatigue'],
      sinsObserved: [],
    })

    // Initialize Geng-Shen cycle
    const daysSinceLastGengShen = Math.floor(Math.random() * 60)
    const daysUntilNext = 60 - daysSinceLastGengShen
    const nextGengShenDate = Date.now() + daysUntilNext * 24 * 60 * 60 * 1000

    return {
      corpses,

      gengShenCycle: {
        daysSinceLastGengShen,
        nextGengShenDate,
        vigilsCompleted: 0,
        consecutiveVigils: 0,
        isGengShenNight: false,
        vigilInProgress: false,
        vigilProgress: 0,
      },

      lifespan: {
        totalLifespan: initialLifespan,
        currentLifespan: initialLifespan,
        lifespanDeducted: 0,
        deductions: [],
      },

      totalCorpseStrength: 0.4, // Average
      corrupting: false,
    }
  }

  /**
   * Record a sin (ethical violation)
   * 記錄罪過
   *
   * Integrates with ethical-reasoning-system.ts
   */
  recordSin(
    corpseType: CorpseType,
    category: 'major' | 'minor',
    description: string,
  ): void {
    const corpse = this.state.corpses.get(corpseType)
    if (!corpse) return

    const sin: Sin = {
      category,
      description,
      timestamp: Date.now(),
      reported: false,
    }

    corpse.sinsObserved.push(sin)

    // Corpse grows stronger when it witnesses sins
    corpse.strength = Math.min(1.0, corpse.strength + 0.02)

    console.log(
      `    [Three Corpses] ${corpse.name} observed ${category} sin: ${description}`,
    )
  }

  /**
   * Induce temptation
   * 誘發誘惑
   */
  induceTemptation(corpseType: CorpseType): {
    temptationType: string
    intensity: number
  } | null {
    const corpse = this.state.corpses.get(corpseType)
    if (!corpse) return null

    // Choose strongest temptation
    const temptations = corpse.temptations
    let strongest: { type: string; value: number } | null = null

    for (const [type, value] of Object.entries(temptations)) {
      if (value && (!strongest || value > strongest.value)) {
        strongest = { type, value }
      }
    }

    if (!strongest) return null

    // Intensity based on corpse strength
    const intensity = corpse.strength * strongest.value

    return {
      temptationType: strongest.type,
      intensity,
    }
  }

  /**
   * Advance day counter
   * 推進日期計數器
   */
  advanceDay(): void {
    this.state.gengShenCycle.daysSinceLastGengShen++

    // Check if Geng-Shen night
    if (this.state.gengShenCycle.daysSinceLastGengShen >= 60) {
      this.triggerGengShenNight()
    }
  }

  /**
   * Trigger Geng-Shen night
   * 觸發庚申夜
   */
  private triggerGengShenNight(): void {
    console.log(`\n  [Three Corpses] ⚠️  GENG-SHEN NIGHT (庚申夜) - Corpses will report sins!`)

    this.state.gengShenCycle.isGengShenNight = true
    this.state.gengShenCycle.daysSinceLastGengShen = 0

    // Calculate next Geng-Shen
    this.state.gengShenCycle.nextGengShenDate = Date.now() + 60 * 24 * 60 * 60 * 1000
  }

  /**
   * Start vigil (守庚申)
   * 開始守夜
   */
  startVigil(): boolean {
    if (!this.state.gengShenCycle.isGengShenNight) {
      console.log(`    [Three Corpses] Cannot start vigil - not Geng-Shen night`)
      return false
    }

    if (this.state.gengShenCycle.vigilInProgress) {
      console.log(`    [Three Corpses] Vigil already in progress`)
      return false
    }

    console.log(`    [Three Corpses] 🕯️  Starting Geng-Shen vigil - staying awake to block corpses`)

    this.state.gengShenCycle.vigilInProgress = true
    this.state.gengShenCycle.vigilStartTime = Date.now()
    this.state.gengShenCycle.vigilProgress = 0

    return true
  }

  /**
   * Progress vigil
   * 推進守夜進度
   */
  progressVigil(meditationQuality: number): void {
    if (!this.state.gengShenCycle.vigilInProgress) return

    // Progress depends on meditation quality
    this.state.gengShenCycle.vigilProgress += meditationQuality * 0.1

    if (this.state.gengShenCycle.vigilProgress >= 1.0) {
      this.completeVigil(meditationQuality)
    }
  }

  /**
   * Complete vigil
   */
  private completeVigil(averageMeditationQuality: number): VigilResult {
    console.log(`    [Three Corpses] ✨ Vigil completed successfully!`)

    // How many corpses were suppressed?
    const corpsesSuppressed = averageMeditationQuality > 0.7 ? 3 : averageMeditationQuality > 0.5 ? 2 : 1

    // Calculate lifespan that would have been deducted
    let lifespanSaved = 0
    for (const [_type, corpse] of this.state.corpses) {
      const majorSins = corpse.sinsObserved.filter((s) => s.category === 'major' && !s.reported)
        .length
      const minorSins = corpse.sinsObserved.filter((s) => s.category === 'minor' && !s.reported)
        .length

      lifespanSaved += majorSins * 300 + minorSins * 3
    }

    // Mark sins as prevented from being reported
    for (const [_type, corpse] of this.state.corpses) {
      for (const sin of corpse.sinsObserved) {
        sin.reported = true // Prevented
      }
    }

    // Update vigil counters
    this.state.gengShenCycle.vigilsCompleted++
    this.state.gengShenCycle.consecutiveVigils++

    // Check for milestones
    if (this.state.gengShenCycle.consecutiveVigils >= 7) {
      console.log(`    [Three Corpses] 🎉 7 consecutive vigils! Corpses ELIMINATED!`)
      this.eliminateCorpses()
    } else if (this.state.gengShenCycle.consecutiveVigils >= 3) {
      console.log(`    [Three Corpses] 💪 3 consecutive vigils! Corpses subdued!`)
      this.subdueCorpses()
    }

    // End vigil
    this.state.gengShenCycle.vigilInProgress = false
    this.state.gengShenCycle.isGengShenNight = false
    this.state.gengShenCycle.vigilProgress = 0

    return {
      success: true,
      corpsesSuppressed,
      meditationQuality: averageMeditationQuality,
      lifespanSaved,
    }
  }

  /**
   * Fail vigil (fell asleep)
   */
  failVigil(): VigilResult {
    console.log(`    [Three Corpses] ❌ Vigil failed - fell asleep!`)
    console.log(`    [Three Corpses] 👻 Corpses ascending to heaven to report sins...`)

    // Corpses report all sins
    let lifespanDeducted = 0

    for (const [_type, corpse] of this.state.corpses) {
      const unreportedSins = corpse.sinsObserved.filter((s) => !s.reported)

      for (const sin of unreportedSins) {
        const deduction = sin.category === 'major' ? 300 : 3

        this.state.lifespan.currentLifespan -= deduction
        this.state.lifespan.lifespanDeducted += deduction

        this.state.lifespan.deductions.push({
          amount: deduction,
          reason: `${corpse.name} reported: ${sin.description}`,
          timestamp: Date.now(),
        })

        lifespanDeducted += deduction
        sin.reported = true
      }
    }

    console.log(`    [Three Corpses] ⚰️  Lifespan deducted: ${lifespanDeducted} days`)

    // Reset consecutive vigils
    this.state.gengShenCycle.consecutiveVigils = 0

    // End vigil
    this.state.gengShenCycle.vigilInProgress = false
    this.state.gengShenCycle.isGengShenNight = false
    this.state.gengShenCycle.vigilProgress = 0

    return {
      success: false,
      corpsesSuppressed: 0,
      meditationQuality: 0,
      lifespanSaved: -lifespanDeducted,
    }
  }

  /**
   * Subdue corpses (3 vigils)
   */
  private subdueCorpses(): void {
    for (const [_type, corpse] of this.state.corpses) {
      corpse.strength = Math.max(0, corpse.strength - 0.3)
    }

    this.updateTotalCorpseStrength()
  }

  /**
   * Eliminate corpses (7 vigils)
   */
  private eliminateCorpses(): void {
    for (const [_type, corpse] of this.state.corpses) {
      corpse.strength = 0
      corpse.sinsObserved = []
    }

    this.state.totalCorpseStrength = 0
    this.state.corrupting = false

    console.log(`    [Three Corpses] 🌟 Immortality achieved! No longer subject to corpse sabotage.`)
  }

  /**
   * Update total corpse strength
   */
  private updateTotalCorpseStrength(): void {
    let total = 0
    for (const [_type, corpse] of this.state.corpses) {
      total += corpse.strength
    }

    this.state.totalCorpseStrength = total / 3
    this.state.corrupting = this.state.totalCorpseStrength > 0.5
  }

  /**
   * Check if approaching death
   */
  isApproachingDeath(): boolean {
    return this.state.lifespan.currentLifespan < 365 // Less than 1 year
  }

  /**
   * Get days until death
   */
  getDaysUntilDeath(): number {
    return this.state.lifespan.currentLifespan
  }

  // Getters
  getState(): ThreeCorpsesState {
    return this.state
  }

  getCorpse(type: CorpseType): Corpse | undefined {
    return this.state.corpses.get(type)
  }

  getTotalCorpseStrength(): number {
    return this.state.totalCorpseStrength
  }

  isGengShenNight(): boolean {
    return this.state.gengShenCycle.isGengShenNight
  }

  getDaysUntilGengShen(): number {
    return 60 - this.state.gengShenCycle.daysSinceLastGengShen
  }

  getRemainingLifespan(): number {
    return this.state.lifespan.currentLifespan
  }
}
