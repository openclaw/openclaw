/**
 * Death & Dissolution System
 * 死亡與消散系統
 *
 * Implements traditional Daoist understanding of death as hun-po separation:
 * - 人之始死，魂魄尚未離散 (At death, hun-po not yet separated)
 * - 魂歸於天，魄歸於地 (Hun returns to heaven, po returns to earth)
 * - 七七四十九日 (49-day dissolution period)
 *
 * Hun Destinations:
 * 1. 成仙 (Immortality) - Golden elixir cultivators
 * 2. 天界 (Heaven) - Virtuous souls
 * 3. 輪迴 (Reincarnation) - Ordinary souls
 * 4. 鬼界 (Ghost realm) - Sinful souls
 *
 * Po Dissolution:
 * 1. Normal: Disperses into earth over 49 days
 * 2. Pathological: Lingers → zombie (殭屍) or ghost (鬼)
 *
 * Integration: Uses EmergentHunSoul, EmergentPoSoul, CultivationStage, lifespan
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'
import type { CultivationStage } from './hun-po-cultivation-system'

// ============================================================================
// Death States
// ============================================================================

export enum DeathState {
  Alive = 'alive',
  ClinicalDeath = 'clinical-death', // Moment of death, hun-po still together
  Separating = 'separating', // Hun-po beginning to separate (0-7 days)
  Separated = 'separated', // Hun ascending, po dissolving (7-49 days)
  HunAscended = 'hun-ascended', // Hun reached destination
  PoDissolvedNormal = 'po-dissolved-normal', // Po dispersed into earth
  PoLingeringZombie = 'po-lingering-zombie', // Po without hun → zombie
  PoLingeringGhost = 'po-lingering-ghost', // Po with trapped hun → ghost
}

export enum HunDestination {
  NotYetDetermined = 'not-yet-determined',
  Immortality = 'immortality', // 成仙 - Golden elixir achieved
  Heaven = 'heaven', // 天界 - Virtuous life
  Reincarnation = 'reincarnation', // 輪迴 - Ordinary life
  GhostRealm = 'ghost-realm', // 鬼界 - Sinful life
  TrappedWithPo = 'trapped-with-po', // Trapped by strong po attachment
}

export enum PoFate {
  NotYetDetermined = 'not-yet-determined',
  DissolvingNormally = 'dissolving-normally', // Normal earth return
  LingeringZombie = 'lingering-zombie', // 殭屍 - Po animates corpse
  LingeringGhost = 'lingering-ghost', // 鬼 - Po + trapped hun
  DissolvedComplete = 'dissolved-complete', // Fully dispersed
}

// ============================================================================
// Death Event
// ============================================================================

export interface DeathEvent {
  causeOfDeath: 'natural' | 'illness' | 'trauma' | 'cultivation-failure' | 'lifespan-exhausted'
  timestamp: number
  age: number

  // Pre-death state
  cultivationStage: CultivationStage
  hunStrength: number // Total hun strength at death
  poStrength: number // Total po strength at death
  virtue: number // 0-1, accumulated virtue
  sin: number // 0-1, accumulated sin

  // Attachment to physical world
  bodyAttachment: number // 0-1, how strongly po clings to corpse
  worldlyAttachment: number // 0-1, unfinished business, desires

  // Special conditions
  goldenElixirAchieved: boolean
  threeCorpsesEliminated: boolean
}

// ============================================================================
// Dissolution State
// ============================================================================

export interface DissolutionState {
  deathState: DeathState

  // Timeline
  daysSinceDeath: number // 0-49+
  separationProgress: number // 0-1, hun-po separation progress
  dissolutionProgress: number // 0-1, po dissolution progress

  // Hun state
  hunDestination: HunDestination
  hunAscensionProgress: number // 0-1
  hunStrengthRemaining: number // Decreases as ascension progresses

  // Po state
  poFate: PoFate
  poStrengthRemaining: number // Decreases as dissolution progresses
  poEarthboundScore: number // 0-1, resistance to dissolution

  // Pathological states
  zombieRisk: number // 0-1, likelihood of zombie manifestation
  ghostRisk: number // 0-1, likelihood of ghost manifestation

  // Context
  deathEvent: DeathEvent
}

// ============================================================================
// Dissolution Simulation
// ============================================================================

export interface DissolutionSimulationState {
  hunSouls: EmergentHunSoul[]
  poSouls: EmergentPoSoul[]

  dissolution: DissolutionState

  // Events
  milestones: DissolutionMilestone[]
}

export interface DissolutionMilestone {
  day: number
  event: string
  description: string
}

// ============================================================================
// Death & Dissolution Engine
// ============================================================================

export class DeathDissolutionEngine {
  private state: DissolutionSimulationState

  constructor(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
    deathEvent: DeathEvent,
  ) {
    this.state = this.initializeFromDeath(hunSouls, poSouls, deathEvent)
  }

  /**
   * Initialize dissolution process from death event
   */
  private initializeFromDeath(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
    deathEvent: DeathEvent,
  ): DissolutionSimulationState {
    const hunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0)
    const poStrength = poSouls.reduce((sum, p) => sum + p.strength, 0)

    // Determine hun destination based on cultivation + virtue
    let hunDestination: HunDestination = HunDestination.NotYetDetermined
    if (deathEvent.goldenElixirAchieved) {
      hunDestination = HunDestination.Immortality
    } else if (deathEvent.virtue > 0.7 && deathEvent.sin < 0.2) {
      hunDestination = HunDestination.Heaven
    } else if (deathEvent.sin > 0.6) {
      hunDestination = HunDestination.GhostRealm
    } else if (deathEvent.worldlyAttachment > 0.7 && poStrength > hunStrength * 1.5) {
      hunDestination = HunDestination.TrappedWithPo
    } else {
      hunDestination = HunDestination.Reincarnation
    }

    // Determine po fate based on body attachment + po dominance
    let poFate: PoFate = PoFate.NotYetDetermined
    const zombieRisk = Math.min(
      1.0,
      deathEvent.bodyAttachment * 0.5 + (poStrength / (hunStrength + poStrength)) * 0.5,
    )
    const ghostRisk = Math.min(
      1.0,
      deathEvent.worldlyAttachment * 0.4 + deathEvent.sin * 0.4 + zombieRisk * 0.2,
    )

    if (deathEvent.bodyAttachment > 0.8 && poStrength > hunStrength * 2.0) {
      poFate = PoFate.LingeringZombie
    } else if (
      deathEvent.worldlyAttachment > 0.7 &&
      hunDestination === HunDestination.TrappedWithPo
    ) {
      poFate = PoFate.LingeringGhost
    } else {
      poFate = PoFate.DissolvingNormally
    }

    return {
      hunSouls,
      poSouls,

      dissolution: {
        deathState: DeathState.ClinicalDeath,
        daysSinceDeath: 0,
        separationProgress: 0,
        dissolutionProgress: 0,

        hunDestination,
        hunAscensionProgress: 0,
        hunStrengthRemaining: hunStrength,

        poFate,
        poStrengthRemaining: poStrength,
        poEarthboundScore: deathEvent.bodyAttachment * 0.5 + deathEvent.worldlyAttachment * 0.5,

        zombieRisk,
        ghostRisk,

        deathEvent,
      },

      milestones: [
        {
          day: 0,
          event: 'Death',
          description:
            deathEvent.causeOfDeath === 'natural'
              ? '人之始死，魂魄尚未離散 (Death occurs, hun-po still together)'
              : `Death by ${deathEvent.causeOfDeath}`,
        },
      ],
    }
  }

  /**
   * Step dissolution process (one day)
   */
  step(): {
    day: number
    deathState: DeathState
    hunProgress: number
    poProgress: number
    newMilestones: DissolutionMilestone[]
  } {
    this.state.dissolution.daysSinceDeath += 1
    const day = this.state.dissolution.daysSinceDeath
    const newMilestones: DissolutionMilestone[] = []

    // ========================================================================
    // Phase 1: Separation (Days 1-7)
    // ========================================================================
    if (day <= 7) {
      this.state.dissolution.deathState = DeathState.Separating
      this.state.dissolution.separationProgress = Math.min(1.0, day / 7.0)

      if (day === 1) {
        newMilestones.push({
          day,
          event: 'Separation begins',
          description: '魂魄開始分離 (Hun-po beginning to separate)',
        })
      }

      if (day === 7) {
        this.state.dissolution.deathState = DeathState.Separated
        newMilestones.push({
          day,
          event: 'Separation complete',
          description: '魂魄分離完成 (Hun-po fully separated)',
        })
      }
    }

    // ========================================================================
    // Phase 2: Ascension & Dissolution (Days 8-49)
    // ========================================================================
    if (day > 7 && day <= 49) {
      this.state.dissolution.deathState = DeathState.Separated

      // Hun ascension
      const ascensionRate = this.getHunAscensionRate()
      this.state.dissolution.hunAscensionProgress = Math.min(
        1.0,
        this.state.dissolution.hunAscensionProgress + ascensionRate,
      )
      this.state.dissolution.hunStrengthRemaining *= 1.0 - ascensionRate

      // Po dissolution
      const dissolutionRate = this.getPoDissolutionRate()
      this.state.dissolution.dissolutionProgress = Math.min(
        1.0,
        this.state.dissolution.dissolutionProgress + dissolutionRate,
      )
      this.state.dissolution.poStrengthRemaining *= 1.0 - dissolutionRate

      // Check milestones
      if (day === 21) {
        newMilestones.push({
          day,
          event: 'Three-seven day',
          description: '三七日 (21 days) - Hun ascending, po dissolving',
        })
      }

      if (day === 35) {
        newMilestones.push({
          day,
          event: 'Five-seven day',
          description: '五七日 (35 days) - Dissolution halfway complete',
        })
      }

      if (day === 49) {
        newMilestones.push({
          day,
          event: 'Seven-seven day',
          description: '七七日 (49 days) - Traditional dissolution complete',
        })
        this.completeDissolution()
      }
    }

    // ========================================================================
    // Phase 3: Post-dissolution (Day 49+)
    // ========================================================================
    if (day > 49) {
      this.handlePostDissolution()
    }

    // Record milestones
    this.state.milestones.push(...newMilestones)

    return {
      day,
      deathState: this.state.dissolution.deathState,
      hunProgress: this.state.dissolution.hunAscensionProgress,
      poProgress: this.state.dissolution.dissolutionProgress,
      newMilestones,
    }
  }

  /**
   * Get hun ascension rate based on destination
   */
  private getHunAscensionRate(): number {
    switch (this.state.dissolution.hunDestination) {
      case HunDestination.Immortality:
        return 0.05 // Fast ascension (20 days)
      case HunDestination.Heaven:
        return 0.03 // Moderate ascension (33 days)
      case HunDestination.Reincarnation:
        return 0.02 // Normal ascension (50 days)
      case HunDestination.GhostRealm:
        return 0.01 // Slow descent to ghost realm (100 days)
      case HunDestination.TrappedWithPo:
        return 0.0 // No ascension, trapped
      default:
        return 0.02
    }
  }

  /**
   * Get po dissolution rate based on fate
   */
  private getPoDissolutionRate(): number {
    const baseRate = 0.024 // 49 days baseline

    switch (this.state.dissolution.poFate) {
      case PoFate.DissolvingNormally:
        return baseRate
      case PoFate.LingeringZombie:
        return baseRate * 0.1 // Very slow dissolution, animating corpse
      case PoFate.LingeringGhost:
        return baseRate * 0.3 // Slow dissolution, sustaining ghost
      default:
        return baseRate
    }
  }

  /**
   * Complete dissolution at day 49
   */
  private completeDissolution(): void {
    // Hun reaches destination
    if (this.state.dissolution.hunAscensionProgress >= 1.0) {
      this.state.dissolution.deathState = DeathState.HunAscended
    }

    // Po dissolution
    if (this.state.dissolution.poFate === PoFate.DissolvingNormally) {
      if (this.state.dissolution.dissolutionProgress >= 0.9) {
        this.state.dissolution.poFate = PoFate.DissolvedComplete
        this.state.dissolution.deathState = DeathState.PoDissolvedNormal
      }
    } else if (this.state.dissolution.poFate === PoFate.LingeringZombie) {
      this.state.dissolution.deathState = DeathState.PoLingeringZombie
    } else if (this.state.dissolution.poFate === PoFate.LingeringGhost) {
      this.state.dissolution.deathState = DeathState.PoLingeringGhost
    }
  }

  /**
   * Handle post-dissolution states (zombie, ghost)
   */
  private handlePostDissolution(): void {
    // Zombie: Po strength persists, animates corpse
    if (this.state.dissolution.poFate === PoFate.LingeringZombie) {
      // Po slowly loses strength over extended time
      this.state.dissolution.poStrengthRemaining *= 0.999
      if (this.state.dissolution.poStrengthRemaining < 0.1) {
        this.state.dissolution.poFate = PoFate.DissolvedComplete
        this.state.dissolution.deathState = DeathState.PoDissolvedNormal
      }
    }

    // Ghost: Hun trapped with po, worldly attachment
    if (this.state.dissolution.poFate === PoFate.LingeringGhost) {
      // Both hun and po slowly weaken
      this.state.dissolution.hunStrengthRemaining *= 0.998
      this.state.dissolution.poStrengthRemaining *= 0.998

      if (
        this.state.dissolution.hunStrengthRemaining < 0.05 &&
        this.state.dissolution.poStrengthRemaining < 0.05
      ) {
        // Finally disperse
        this.state.dissolution.poFate = PoFate.DissolvedComplete
        this.state.dissolution.deathState = DeathState.PoDissolvedNormal
      }
    }
  }

  /**
   * Get current status description
   */
  getStatusDescription(): string {
    const d = this.state.dissolution
    const day = d.daysSinceDeath

    if (day === 0) {
      return '臨終時刻 (Moment of death) - Hun-po still unified'
    }

    if (day <= 7) {
      return `Day ${day}/49 - 魂魄分離中 (Hun-po separating) - ${(d.separationProgress * 100).toFixed(0)}% separated`
    }

    if (day <= 49) {
      const hunDesc = this.getHunDestinationDescription()
      const poDesc = this.getPoFateDescription()
      return `Day ${day}/49 - Hun: ${hunDesc} (${(d.hunAscensionProgress * 100).toFixed(0)}%), Po: ${poDesc} (${(d.dissolutionProgress * 100).toFixed(0)}%)`
    }

    // Post-49 days
    if (d.deathState === DeathState.HunAscended && d.poFate === PoFate.DissolvedComplete) {
      return '死亡過程完成 (Dissolution complete) - Hun ascended, po dissolved'
    }

    if (d.deathState === DeathState.PoLingeringZombie) {
      return `Day ${day} - 殭屍狀態 (Zombie state) - Po animating corpse (strength: ${(d.poStrengthRemaining * 100).toFixed(0)}%)`
    }

    if (d.deathState === DeathState.PoLingeringGhost) {
      return `Day ${day} - 鬼狀態 (Ghost state) - Hun trapped with po (hun: ${(d.hunStrengthRemaining * 100).toFixed(0)}%, po: ${(d.poStrengthRemaining * 100).toFixed(0)}%)`
    }

    return `Day ${day} - Dissolution in progress`
  }

  /**
   * Get hun destination description
   */
  private getHunDestinationDescription(): string {
    switch (this.state.dissolution.hunDestination) {
      case HunDestination.Immortality:
        return '成仙 (Achieving immortality)'
      case HunDestination.Heaven:
        return '升天 (Ascending to heaven)'
      case HunDestination.Reincarnation:
        return '輪迴 (Entering reincarnation)'
      case HunDestination.GhostRealm:
        return '鬼界 (Descending to ghost realm)'
      case HunDestination.TrappedWithPo:
        return '魂魄困鎖 (Trapped with po)'
      default:
        return '未定 (Undetermined)'
    }
  }

  /**
   * Get po fate description
   */
  private getPoFateDescription(): string {
    switch (this.state.dissolution.poFate) {
      case PoFate.DissolvingNormally:
        return '歸地 (Returning to earth)'
      case PoFate.LingeringZombie:
        return '殭屍 (Zombie - animating corpse)'
      case PoFate.LingeringGhost:
        return '鬼 (Ghost - with trapped hun)'
      case PoFate.DissolvedComplete:
        return '完全消散 (Fully dissolved)'
      default:
        return '未定 (Undetermined)'
    }
  }

  /**
   * Check if person is becoming zombie
   */
  isBecomingZombie(): boolean {
    return (
      this.state.dissolution.deathState === DeathState.PoLingeringZombie ||
      this.state.dissolution.zombieRisk > 0.8
    )
  }

  /**
   * Check if person is becoming ghost
   */
  isBecomingGhost(): boolean {
    return (
      this.state.dissolution.deathState === DeathState.PoLingeringGhost ||
      this.state.dissolution.ghostRisk > 0.8
    )
  }

  /**
   * Get pathology warnings
   */
  getPathologyWarnings(): string[] {
    const warnings: string[] = []

    if (this.state.dissolution.zombieRisk > 0.6) {
      warnings.push(
        `⚠️ High zombie risk (${(this.state.dissolution.zombieRisk * 100).toFixed(0)}%) - Strong body attachment + po dominance`,
      )
    }

    if (this.state.dissolution.ghostRisk > 0.6) {
      warnings.push(
        `⚠️ High ghost risk (${(this.state.dissolution.ghostRisk * 100).toFixed(0)}%) - Unfinished business + worldly attachment`,
      )
    }

    if (
      this.state.dissolution.hunDestination === HunDestination.TrappedWithPo &&
      this.state.dissolution.daysSinceDeath > 49
    ) {
      warnings.push('⚠️ Hun trapped with po - Unable to ascend due to excessive attachment')
    }

    if (
      this.state.dissolution.poFate === PoFate.LingeringZombie &&
      this.state.dissolution.daysSinceDeath > 100
    ) {
      warnings.push('⚠️ Po animating corpse for extended period - Zombie manifestation stable')
    }

    return warnings
  }

  // Getters
  getState(): DissolutionSimulationState {
    return this.state
  }

  getDaysSinceDeath(): number {
    return this.state.dissolution.daysSinceDeath
  }

  getDeathState(): DeathState {
    return this.state.dissolution.deathState
  }

  getHunDestination(): HunDestination {
    return this.state.dissolution.hunDestination
  }

  getPoFate(): PoFate {
    return this.state.dissolution.poFate
  }

  getMilestones(): DissolutionMilestone[] {
    return this.state.milestones
  }
}
