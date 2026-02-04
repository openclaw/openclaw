/**
 * Hun-Po Interaction System
 * 魂魄相互作用系統
 *
 * Implements the dynamic relationship between Hun (ethereal souls) and Po (corporeal souls).
 *
 * Three Interaction States:
 * 1. 魂魄相守 (Hun-Po Mutual Guarding) - Ideal balanced state
 * 2. 魂制魄 (Hun Governs Po) - Saints: Rational mind controls base instincts
 * 3. 魄制魂 (Po Controls Hun) - Degenerates: Bodily desires override rationality
 *
 * Classic Doctrine:
 * "聖人以魂運魄，眾人以魄攝魂"
 * (Saints use Hun to drive Po; ordinary people let Po trap Hun)
 *
 * Warning: "人將化為鬼" (Person will become a ghost)
 * When Po completely dominates Hun, the person degenerates toward death.
 *
 * Integration: Uses EmergentHunSoul, EmergentPoSoul from chaotic-emergence-system.ts
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'

// ============================================================================
// Interaction States
// ============================================================================

export enum HunPoInteractionState {
  HunGovernsStrong = 'hun-governs-strong', // Hun >> Po (saint/cultivator)
  HunGovernsWeak = 'hun-governs-weak', // Hun > Po (disciplined person)
  MutualGuarding = 'mutual-guarding', // Hun ≈ Po (balanced healthy person)
  PoGovernsWeak = 'po-governs-weak', // Po > Hun (indulgent person)
  PoGovernsStrong = 'po-governs-strong', // Po >> Hun (degenerate, "becoming ghost")
}

export interface HunPoDominance {
  dominanceRatio: number // -1.0 to +1.0: -1=po dominates, 0=balanced, +1=hun dominates
  interactionState: HunPoInteractionState

  // Strength totals
  totalHunStrength: number
  totalPoStrength: number

  // Individual contributions
  hunContributions: Map<string, number> // hun soul id → strength
  poContributions: Map<string, number> // po soul id → strength
}

// ============================================================================
// Shift Triggers
// ============================================================================

export interface ShiftTrigger {
  type:
    | 'stress' // Stress shifts toward po (survival mode)
    | 'meditation' // Meditation shifts toward hun (spiritual mode)
    | 'temptation' // Temptation shifts toward po (desire mode)
    | 'suffering' // Suffering can shift either way
    | 'revelation' // Spiritual insight shifts toward hun
    | 'trauma' // Trauma shifts toward po (regression)
  intensity: number // 0-1
  direction: 'toward-hun' | 'toward-po'
  duration: number // How long the shift lasts
}

// ============================================================================
// Pathological States
// ============================================================================

export interface HunPoPathology {
  // Po-dominant pathologies
  addiction: number // 0-1, craving-driven behavior
  impulsivity: number // 0-1, acting without thinking
  sensualOverindulgence: number // 0-1, excessive pleasure-seeking
  moralDecay: number // 0-1, loss of ethical constraints

  // Hun-dominant pathologies (spiritual bypass)
  bodyDisconnection: number // 0-1, ignoring physical needs
  emotionalSuppression: number // 0-1, denying feelings
  spiritualBypassing: number // 0-1, using spirituality to avoid reality
  asceticism: number // 0-1, excessive self-denial

  // Balanced pathologies
  hunPoSplit: number // 0-1, dissociation between mind and body
  identityFragmentation: number // 0-1, inconsistent sense of self
}

// ============================================================================
// Hun-Po Interaction State
// ============================================================================

export interface HunPoInteractionSystemState {
  hunSouls: EmergentHunSoul[]
  poSouls: EmergentPoSoul[]

  dominance: HunPoDominance
  pathology: HunPoPathology

  // Shift history
  recentShifts: ShiftTrigger[]

  // Metrics
  hunPoHarmony: number // 0-1, how well hun and po cooperate
  conflictLevel: number // 0-1, internal struggle intensity
}

// ============================================================================
// Hun-Po Interaction Engine
// ============================================================================

export class HunPoInteractionEngine {
  private state: HunPoInteractionSystemState

  constructor(hunSouls: EmergentHunSoul[], poSouls: EmergentPoSoul[]) {
    this.state = this.initializeFromSouls(hunSouls, poSouls)
  }

  /**
   * Initialize from emergent souls
   */
  private initializeFromSouls(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
  ): HunPoInteractionSystemState {
    const totalHunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const totalPoStrength = poSouls.reduce((sum, p) => sum + p.strength, 0)

    // Calculate dominance ratio
    const total = totalHunStrength + totalPoStrength
    const dominanceRatio = total > 0 ? (totalHunStrength - totalPoStrength) / total : 0

    // Determine interaction state
    let interactionState: HunPoInteractionState
    if (dominanceRatio > 0.5) {
      interactionState = HunPoInteractionState.HunGovernsStrong
    } else if (dominanceRatio > 0.15) {
      interactionState = HunPoInteractionState.HunGovernsWeak
    } else if (dominanceRatio > -0.15) {
      interactionState = HunPoInteractionState.MutualGuarding
    } else if (dominanceRatio > -0.5) {
      interactionState = HunPoInteractionState.PoGovernsWeak
    } else {
      interactionState = HunPoInteractionState.PoGovernsStrong
    }

    // Map individual contributions
    const hunContributions = new Map<string, number>()
    for (const hun of hunSouls) {
      hunContributions.set(hun.id, hun.strength)
    }

    const poContributions = new Map<string, number>()
    for (const po of poSouls) {
      poContributions.set(po.id, po.strength)
    }

    return {
      hunSouls,
      poSouls,

      dominance: {
        dominanceRatio,
        interactionState,
        totalHunStrength,
        totalPoStrength,
        hunContributions,
        poContributions,
      },

      pathology: {
        // Po-dominant pathologies (more likely if po dominates)
        addiction: dominanceRatio < -0.3 ? Math.abs(dominanceRatio) * 0.5 : 0,
        impulsivity: dominanceRatio < -0.2 ? Math.abs(dominanceRatio) * 0.4 : 0,
        sensualOverindulgence: dominanceRatio < -0.3 ? Math.abs(dominanceRatio) * 0.6 : 0,
        moralDecay: dominanceRatio < -0.4 ? Math.abs(dominanceRatio) * 0.7 : 0,

        // Hun-dominant pathologies (more likely if hun dominates)
        bodyDisconnection: dominanceRatio > 0.3 ? dominanceRatio * 0.4 : 0,
        emotionalSuppression: dominanceRatio > 0.4 ? dominanceRatio * 0.5 : 0,
        spiritualBypassing: dominanceRatio > 0.5 ? dominanceRatio * 0.6 : 0,
        asceticism: dominanceRatio > 0.6 ? dominanceRatio * 0.7 : 0,

        // Imbalance pathologies
        hunPoSplit: Math.abs(dominanceRatio) > 0.4 ? Math.abs(dominanceRatio) * 0.5 : 0,
        identityFragmentation: Math.abs(dominanceRatio) > 0.5 ? Math.abs(dominanceRatio) * 0.4 : 0,
      },

      recentShifts: [],

      hunPoHarmony: 1.0 - Math.abs(dominanceRatio), // Perfect balance = 1.0
      conflictLevel: Math.abs(dominanceRatio), // More imbalance = more conflict
    }
  }

  /**
   * Apply shift trigger
   * 應用轉移觸發器
   */
  applyShift(trigger: ShiftTrigger): {
    oldRatio: number
    newRatio: number
    newState: HunPoInteractionState
    description: string
  } {
    const oldRatio = this.state.dominance.dominanceRatio

    // Calculate shift magnitude
    let shift = 0
    if (trigger.direction === 'toward-hun') {
      shift = trigger.intensity * 0.2 // Shift toward hun (positive)
    } else {
      shift = -trigger.intensity * 0.2 // Shift toward po (negative)
    }

    // Apply shift
    let newRatio = oldRatio + shift

    // Clamp to [-1, 1]
    newRatio = Math.max(-1.0, Math.min(1.0, newRatio))

    this.state.dominance.dominanceRatio = newRatio

    // Update interaction state
    this.updateInteractionState()

    // Update pathologies
    this.updatePathologies()

    // Record shift
    this.state.recentShifts.push(trigger)
    if (this.state.recentShifts.length > 10) {
      this.state.recentShifts.shift() // Keep last 10
    }

    // Generate description
    const description = this.generateShiftDescription(trigger, oldRatio, newRatio)

    return {
      oldRatio,
      newRatio,
      newState: this.state.dominance.interactionState,
      description,
    }
  }

  /**
   * Update interaction state based on dominance ratio
   */
  private updateInteractionState(): void {
    const ratio = this.state.dominance.dominanceRatio

    if (ratio > 0.5) {
      this.state.dominance.interactionState = HunPoInteractionState.HunGovernsStrong
    } else if (ratio > 0.15) {
      this.state.dominance.interactionState = HunPoInteractionState.HunGovernsWeak
    } else if (ratio > -0.15) {
      this.state.dominance.interactionState = HunPoInteractionState.MutualGuarding
    } else if (ratio > -0.5) {
      this.state.dominance.interactionState = HunPoInteractionState.PoGovernsWeak
    } else {
      this.state.dominance.interactionState = HunPoInteractionState.PoGovernsStrong
    }

    // Update harmony and conflict
    this.state.hunPoHarmony = 1.0 - Math.abs(ratio)
    this.state.conflictLevel = Math.abs(ratio)
  }

  /**
   * Update pathologies based on dominance
   */
  private updatePathologies(): void {
    const ratio = this.state.dominance.dominanceRatio

    // Po-dominant pathologies
    this.state.pathology.addiction = ratio < -0.3 ? Math.abs(ratio) * 0.5 : 0
    this.state.pathology.impulsivity = ratio < -0.2 ? Math.abs(ratio) * 0.4 : 0
    this.state.pathology.sensualOverindulgence = ratio < -0.3 ? Math.abs(ratio) * 0.6 : 0
    this.state.pathology.moralDecay = ratio < -0.4 ? Math.abs(ratio) * 0.7 : 0

    // Hun-dominant pathologies
    this.state.pathology.bodyDisconnection = ratio > 0.3 ? ratio * 0.4 : 0
    this.state.pathology.emotionalSuppression = ratio > 0.4 ? ratio * 0.5 : 0
    this.state.pathology.spiritualBypassing = ratio > 0.5 ? ratio * 0.6 : 0
    this.state.pathology.asceticism = ratio > 0.6 ? ratio * 0.7 : 0

    // Imbalance pathologies
    this.state.pathology.hunPoSplit = Math.abs(ratio) > 0.4 ? Math.abs(ratio) * 0.5 : 0
    this.state.pathology.identityFragmentation = Math.abs(ratio) > 0.5 ? Math.abs(ratio) * 0.4 : 0
  }

  /**
   * Generate human-readable description of shift
   */
  private generateShiftDescription(
    trigger: ShiftTrigger,
    oldRatio: number,
    newRatio: number,
  ): string {
    const oldState = this.getStateDescription(oldRatio)
    const newState = this.getStateDescription(newRatio)

    const triggerDescriptions: Record<string, string> = {
      stress: 'Stress activated survival instincts',
      meditation: 'Meditation elevated spiritual awareness',
      temptation: 'Temptation triggered desire',
      suffering: 'Suffering catalyzed transformation',
      revelation: 'Revelation illuminated higher truth',
      trauma: 'Trauma caused regression to base instincts',
    }

    const triggerDesc = triggerDescriptions[trigger.type] || trigger.type

    return `${triggerDesc} → ${oldState} to ${newState}`
  }

  /**
   * Get state description from ratio
   */
  private getStateDescription(ratio: number): string {
    if (ratio > 0.5) {
      return 'Hun dominates strongly (saint/cultivator)'
    } else if (ratio > 0.15) {
      return 'Hun governs Po (disciplined person)'
    } else if (ratio > -0.15) {
      return 'Hun-Po balanced (healthy person)'
    } else if (ratio > -0.5) {
      return 'Po governs Hun (indulgent person)'
    } else {
      return 'Po dominates strongly (degenerate, "becoming ghost")'
    }
  }

  /**
   * Check if approaching death state
   * 檢查是否接近死亡狀態
   *
   * Warning: "人將化為鬼" (Person will become a ghost)
   */
  isBecomingGhost(): boolean {
    return this.state.dominance.interactionState === HunPoInteractionState.PoGovernsStrong
  }

  /**
   * Get behavioral predictions based on dominance
   */
  getBehavioralTendencies(): {
    rationalControl: number // 0-1, ability to use reason
    impulsiveAction: number // 0-1, tendency to act on impulse
    spiritualFocus: number // 0-1, interest in transcendence
    sensualFocus: number // 0-1, interest in pleasure
    moralConstraints: number // 0-1, ethical self-regulation
  } {
    const ratio = this.state.dominance.dominanceRatio

    // Hun-dominant traits
    const hunInfluence = Math.max(0, ratio)

    // Po-dominant traits
    const poInfluence = Math.max(0, -ratio)

    return {
      rationalControl: 0.5 + hunInfluence * 0.5,
      impulsiveAction: 0.5 + poInfluence * 0.5,
      spiritualFocus: 0.3 + hunInfluence * 0.7,
      sensualFocus: 0.3 + poInfluence * 0.7,
      moralConstraints: 0.5 + hunInfluence * 0.5 - poInfluence * 0.3,
    }
  }

  /**
   * Step simulation
   */
  step(): {
    dominanceRatio: number
    interactionState: HunPoInteractionState
    harmony: number
    conflict: number
    becomingGhost: boolean
  } {
    // Natural drift toward balance (very slow)
    const driftTowardBalance = -this.state.dominance.dominanceRatio * 0.005
    this.state.dominance.dominanceRatio += driftTowardBalance

    // Update state
    this.updateInteractionState()
    this.updatePathologies()

    return {
      dominanceRatio: this.state.dominance.dominanceRatio,
      interactionState: this.state.dominance.interactionState,
      harmony: this.state.hunPoHarmony,
      conflict: this.state.conflictLevel,
      becomingGhost: this.isBecomingGhost(),
    }
  }

  // Getters
  getState(): HunPoInteractionSystemState {
    return this.state
  }

  getDominanceRatio(): number {
    return this.state.dominance.dominanceRatio
  }

  getInteractionState(): HunPoInteractionState {
    return this.state.dominance.interactionState
  }

  getPathology(): HunPoPathology {
    return this.state.pathology
  }

  getHarmony(): number {
    return this.state.hunPoHarmony
  }

  getConflictLevel(): number {
    return this.state.conflictLevel
  }
}
