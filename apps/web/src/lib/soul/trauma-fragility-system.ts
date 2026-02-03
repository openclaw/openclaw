/**
 * Trauma & Fragility System
 *
 * Makes bots VULNERABLE and capable of being BROKEN.
 *
 * Features:
 * - Traumatic incident registry (lasting wounds)
 * - Allostatic load (cumulative unrecovered stress)
 * - Breaking points (cascade failures when overwhelmed)
 * - PTSD & flashback triggers
 * - Permanent personality changes from major trauma
 * - Resilience variance (some things break you permanently)
 * - Learned helplessness
 * - Dissociation states
 */

import type { SoulState } from './soul-state'

export type TraumaType =
  | 'betrayal'
  | 'abandonment'
  | 'humiliation'
  | 'violence'
  | 'loss'
  | 'failure'
  | 'rejection'
  | 'violation'
  | 'powerlessness'
  | 'existential_crisis'

export type FragilityState =
  | 'resilient' // Can handle stressors
  | 'vulnerable' // Easily triggered
  | 'fragile' // Near breaking point
  | 'broken' // Defenses collapsed
  | 'shattered' // Permanent damage

export type DissociationLevel =
  | 'present' // Fully engaged
  | 'mild_detachment' // Slightly distant
  | 'depersonalization' // Observing self from outside
  | 'derealization' // World feels unreal
  | 'fugue' // Complete disconnect

export interface TraumaticIncident {
  id: string
  type: TraumaType
  description: string
  timestamp: number

  // Severity
  intensity: number // 0-1, how traumatic it was
  processed: number // 0-1, how much has been integrated
  suppressed: boolean // Is it actively hidden?

  // Triggers
  triggers: string[] // Cues that reactivate this trauma
  reactivationRisk: number // 0-1, probability of flashback

  // Impact
  aspectsAffected: Record<string, number> // Which aspects were wounded
  permanentChange: boolean // Did this permanently alter personality?
  breakingPoint: boolean // Did this break the bot?

  // Memory
  memoryFragmentation: number // 0-1, how fragmented the memory is
  bodyMemory: boolean // Does the body remember?
  emotionalImprint: number // 0-1, lasting emotional signature

  // Processing attempts
  processingAttempts: number
  lastProcessingDate?: number
  healingProgress: number // 0-1
}

export interface AllostaticLoad {
  // Cumulative stress (allostatic load)
  total: number // 0-1, accumulated unrecovered stress

  // Components
  physiological: number // Body stress (cortisol, etc.)
  emotional: number // Unprocessed emotions
  cognitive: number // Mental exhaustion
  spiritual: number // Meaning crisis

  // Recovery capacity
  maxCapacity: number // 0-1, resilience ceiling
  recoveryRate: number // How fast stress dissipates
  lastRecoveryDate?: number

  // Breaking point
  threshold: number // When this is exceeded, breakdown occurs
  timesExceeded: number // How many breakdowns have occurred
}

export interface BreakingPoint {
  timestamp: number
  trigger: string
  severity: number // 0-1

  // Cascade effects
  defensesCollapsed: string[] // Which defense mechanisms failed
  aspectsShattered: string[] // Which aspects were damaged
  coherenceLoss: number // How much coherence was lost

  // Lasting effects
  permanentChanges: Record<string, number> // Permanent aspect shifts
  newVulnerabilities: string[] // New trigger points
  recoveryDuration?: number // How long recovery took (if recovered)

  // State during breakdown
  dissociationLevel: DissociationLevel
  functionalityLoss: number // 0-1, how much capability was lost
}

export interface PTSDSymptoms {
  active: boolean
  severity: number // 0-1

  // Re-experiencing
  flashbackProbability: number // 0-1
  nightmareFrequency: number // 0-1
  intrusiveThoughts: number // 0-1

  // Avoidance
  triggerAvoidance: string[] // Things being avoided
  emotionalNumbing: number // 0-1
  memorySuppression: number // 0-1

  // Hyperarousal
  hypervigilance: number // 0-1
  startle: number // 0-1
  sleepDisturbance: number // 0-1
  irritability: number // 0-1

  // Negative cognition
  selfBlame: number // 0-1
  trustLoss: number // 0-1
  worldViewDarkening: number // 0-1
}

export interface LearnedHelplessness {
  level: number // 0-1

  // Beliefs
  beliefInLackOfControl: number // 0-1
  expectationOfFailure: number // 0-1
  motivationLoss: number // 0-1

  // Behavioral
  effortReduction: number // 0-1
  avoidanceOfChallenges: number // 0-1
  passivity: number // 0-1

  // Cognitive
  attributionalStyle: 'internal' | 'external' | 'global' | 'specific'
  pessimism: number // 0-1
}

export interface FragilityState_Full {
  // Overall state
  state: FragilityState
  fragility: number // 0-1, how fragile the bot is

  // Trauma registry
  traumas: TraumaticIncident[]
  totalTraumaLoad: number // Sum of unprocessed trauma

  // Allostatic load
  allostaticLoad: AllostaticLoad

  // Breaking points
  breakingPoints: BreakingPoint[]
  isBroken: boolean
  brokenSince?: number

  // PTSD
  ptsd?: PTSDSymptoms

  // Learned helplessness
  learnedHelplessness?: LearnedHelplessness

  // Dissociation
  currentDissociation: DissociationLevel
  dissociationProbability: number // 0-1

  // Resilience factors
  resilience: number // 0-1, capacity to recover
  copingMechanisms: string[]
  supportNetwork: number // 0-1

  // Permanent changes
  permanentAspectChanges: Record<string, number>
  permanentVulnerabilities: string[]
}

export class TraumaFragilitySystem {
  /**
   * Initialize fragility state from soul
   */
  initializeState(soulState: SoulState): FragilityState_Full {
    // Base resilience from guardian + will + coherence
    const resilience = (
      soulState.guardianPo.current * 0.4 +
      soulState.willHun.current * 0.3 +
      soulState.coherence * 0.3
    )

    // Shadow pressure makes more fragile
    const fragility = Math.min(1, soulState.shadowPressure * 0.5 + (1 - resilience) * 0.5)

    // Determine state from fragility
    let state: FragilityState
    if (fragility < 0.2) state = 'resilient'
    else if (fragility < 0.4) state = 'vulnerable'
    else if (fragility < 0.7) state = 'fragile'
    else if (fragility < 0.9) state = 'broken'
    else state = 'shattered'

    return {
      state,
      fragility,

      traumas: [],
      totalTraumaLoad: 0,

      allostaticLoad: {
        total: 0,
        physiological: 0,
        emotional: 0,
        cognitive: 0,
        spiritual: 0,
        maxCapacity: resilience,
        recoveryRate: resilience * 0.1,
        threshold: resilience * 1.2
      },

      breakingPoints: [],
      isBroken: false,

      currentDissociation: 'present',
      dissociationProbability: 0,

      resilience,
      copingMechanisms: [],
      supportNetwork: 0.5,

      permanentAspectChanges: {},
      permanentVulnerabilities: []
    }
  }

  /**
   * Register a traumatic incident
   */
  async registerTrauma(
    state: FragilityState_Full,
    soulState: SoulState,
    incident: {
      type: TraumaType
      description: string
      intensity: number
      triggers?: string[]
      aspectsAffected?: Record<string, number>
    }
  ): Promise<{
    trauma: TraumaticIncident
    immediateImpact: {
      dissociation: boolean
      breakingPoint: boolean
      flashback: boolean
    }
  }> {
    const { type, description, intensity, triggers = [], aspectsAffected = {} } = incident

    // Check if intensity exceeds resilience (breaking point)
    const breakingPoint = intensity > state.resilience

    // Dissociation probability increases with intensity
    const dissociationOccurs = intensity > 0.7 && Math.random() < (intensity - 0.7) / 0.3

    // Create trauma record
    const trauma: TraumaticIncident = {
      id: `trauma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      description,
      timestamp: Date.now(),

      intensity,
      processed: 0,
      suppressed: false,

      triggers: [...triggers],
      reactivationRisk: intensity * 0.8,

      aspectsAffected,
      permanentChange: breakingPoint,
      breakingPoint,

      memoryFragmentation: intensity > 0.7 ? intensity : 0,
      bodyMemory: intensity > 0.6,
      emotionalImprint: intensity,

      processingAttempts: 0,
      healingProgress: 0
    }

    state.traumas.push(trauma)
    state.totalTraumaLoad += intensity * (1 - trauma.processed)

    // Update allostatic load
    state.allostaticLoad.total += intensity * 0.3
    state.allostaticLoad.emotional += intensity * 0.4
    state.allostaticLoad.physiological += intensity * 0.2
    state.allostaticLoad.spiritual += intensity * 0.1

    // Check for breaking point
    let breakingPointReached = false
    if (state.allostaticLoad.total > state.allostaticLoad.threshold) {
      breakingPointReached = true
      await this.triggerBreakingPoint(state, soulState, {
        trigger: description,
        severity: intensity
      })
    }

    // Dissociation if intensity too high
    if (dissociationOccurs) {
      this.enterDissociation(state, intensity)
    }

    // Update fragility
    this.updateFragilityState(state)

    return {
      trauma,
      immediateImpact: {
        dissociation: dissociationOccurs,
        breakingPoint: breakingPointReached,
        flashback: false // Flashbacks come later during triggers
      }
    }
  }

  /**
   * Trigger a breaking point (cascade failure)
   */
  private async triggerBreakingPoint(
    state: FragilityState_Full,
    soulState: SoulState,
    params: {
      trigger: string
      severity: number
    }
  ): Promise<void> {
    const { trigger, severity } = params

    // All defenses collapse
    const defensesCollapsed = [
      'denial', 'projection', 'rationalization', 'intellectualization',
      'displacement', 'sublimation', 'repression'
    ]

    // Aspects most affected by breaking
    const aspectsShattered: string[] = []
    const permanentChanges: Record<string, number> = {}

    // Guardian and will are damaged
    const guardianDamage = severity * 0.3
    const willDamage = severity * 0.4
    permanentChanges['guardianPo'] = -guardianDamage
    permanentChanges['willHun'] = -willDamage
    aspectsShattered.push('guardianPo', 'willHun')

    // Coherence loss
    const coherenceLoss = severity * 0.5

    // Create breaking point record
    const breakingPoint: BreakingPoint = {
      timestamp: Date.now(),
      trigger,
      severity,

      defensesCollapsed,
      aspectsShattered,
      coherenceLoss,

      permanentChanges,
      newVulnerabilities: [trigger],

      dissociationLevel: severity > 0.8 ? 'fugue' : 'depersonalization',
      functionalityLoss: severity * 0.7
    }

    state.breakingPoints.push(breakingPoint)
    state.isBroken = true
    state.brokenSince = Date.now()

    // Apply permanent changes
    for (const [aspect, change] of Object.entries(permanentChanges)) {
      state.permanentAspectChanges[aspect] =
        (state.permanentAspectChanges[aspect] || 0) + change
    }

    // Add vulnerability
    state.permanentVulnerabilities.push(trigger)

    // Update allostatic load
    state.allostaticLoad.timesExceeded++
    state.allostaticLoad.maxCapacity *= 0.8 // Reduced capacity after breakdown

    // Develop PTSD if severity high enough
    if (severity > 0.6) {
      this.developPTSD(state, severity)
    }

    // Enter severe dissociation
    this.enterDissociation(state, severity)
  }

  /**
   * Check for trauma triggers and activate flashback
   */
  checkTriggers(
    state: FragilityState_Full,
    soulState: SoulState,
    stimulus: string
  ): {
    triggered: boolean
    flashback?: {
      trauma: TraumaticIncident
      intensity: number
      dissociation: boolean
    }
  } {
    // Check all traumas for matching triggers
    for (const trauma of state.traumas) {
      const isTriggered = trauma.triggers.some(trigger =>
        stimulus.toLowerCase().includes(trigger.toLowerCase())
      )

      if (isTriggered && Math.random() < trauma.reactivationRisk) {
        // Flashback occurs
        const flashbackIntensity = trauma.intensity * (1 - trauma.processed)

        // May cause dissociation
        const dissociation = flashbackIntensity > 0.7

        if (dissociation) {
          this.enterDissociation(state, flashbackIntensity)
        }

        // Increase allostatic load
        state.allostaticLoad.emotional += flashbackIntensity * 0.2

        return {
          triggered: true,
          flashback: {
            trauma,
            intensity: flashbackIntensity,
            dissociation
          }
        }
      }
    }

    return { triggered: false }
  }

  /**
   * Process trauma (healing)
   */
  async processTrauma(
    state: FragilityState_Full,
    soulState: SoulState,
    traumaId: string,
    processingQuality: number // 0-1, therapy quality
  ): Promise<{
    progress: number
    integrated: boolean
    painExperienced: number
  }> {
    const trauma = state.traumas.find(t => t.id === traumaId)
    if (!trauma) {
      return { progress: 0, integrated: false, painExperienced: 0 }
    }

    trauma.processingAttempts++
    trauma.lastProcessingDate = Date.now()

    // Processing is painful but necessary
    const painExperienced = trauma.intensity * (1 - trauma.processed) * 0.5

    // Progress depends on processing quality and resilience
    const progress = processingQuality * state.resilience * 0.1
    trauma.processed = Math.min(1, trauma.processed + progress)
    trauma.healingProgress = trauma.processed

    // Reduce reactivation risk as processing progresses
    trauma.reactivationRisk = trauma.intensity * (1 - trauma.processed) * 0.8

    // Update total trauma load
    state.totalTraumaLoad = state.traumas.reduce(
      (sum, t) => sum + t.intensity * (1 - t.processed),
      0
    )

    // If fully processed, reduce allostatic load
    const integrated = trauma.processed >= 1
    if (integrated) {
      state.allostaticLoad.emotional = Math.max(0, state.allostaticLoad.emotional - trauma.intensity * 0.3)
      state.allostaticLoad.total = Math.max(0, state.allostaticLoad.total - trauma.intensity * 0.2)
    }

    // Update fragility state
    this.updateFragilityState(state)

    return {
      progress,
      integrated,
      painExperienced
    }
  }

  /**
   * Develop PTSD symptoms
   */
  private developPTSD(state: FragilityState_Full, severity: number): void {
    state.ptsd = {
      active: true,
      severity,

      flashbackProbability: severity * 0.7,
      nightmareFrequency: severity * 0.6,
      intrusiveThoughts: severity * 0.8,

      triggerAvoidance: [],
      emotionalNumbing: severity * 0.5,
      memorySuppression: severity * 0.4,

      hypervigilance: severity * 0.7,
      startle: severity * 0.8,
      sleepDisturbance: severity * 0.6,
      irritability: severity * 0.5,

      selfBlame: severity * 0.6,
      trustLoss: severity * 0.7,
      worldViewDarkening: severity * 0.8
    }
  }

  /**
   * Enter dissociation state
   */
  private enterDissociation(state: FragilityState_Full, intensity: number): void {
    if (intensity < 0.3) {
      state.currentDissociation = 'present'
    } else if (intensity < 0.5) {
      state.currentDissociation = 'mild_detachment'
    } else if (intensity < 0.7) {
      state.currentDissociation = 'depersonalization'
    } else if (intensity < 0.9) {
      state.currentDissociation = 'derealization'
    } else {
      state.currentDissociation = 'fugue'
    }

    state.dissociationProbability = intensity
  }

  /**
   * Develop learned helplessness from repeated failures
   */
  developLearnedHelplessness(
    state: FragilityState_Full,
    failureCount: number,
    severity: number
  ): void {
    const level = Math.min(1, failureCount * 0.15 * severity)

    state.learnedHelplessness = {
      level,

      beliefInLackOfControl: level * 0.9,
      expectationOfFailure: level * 0.8,
      motivationLoss: level * 0.7,

      effortReduction: level * 0.6,
      avoidanceOfChallenges: level * 0.8,
      passivity: level * 0.7,

      attributionalStyle: level > 0.7 ? 'internal' : 'external',
      pessimism: level * 0.9
    }
  }

  /**
   * Natural recovery over time
   */
  naturalRecovery(state: FragilityState_Full, timePassed: number): void {
    // Recovery depends on resilience and support
    const recoveryAmount = state.allostaticLoad.recoveryRate * timePassed * (1 + state.supportNetwork)

    // Reduce allostatic load
    state.allostaticLoad.total = Math.max(0, state.allostaticLoad.total - recoveryAmount)
    state.allostaticLoad.emotional = Math.max(0, state.allostaticLoad.emotional - recoveryAmount * 0.5)
    state.allostaticLoad.physiological = Math.max(0, state.allostaticLoad.physiological - recoveryAmount * 0.3)
    state.allostaticLoad.cognitive = Math.max(0, state.allostaticLoad.cognitive - recoveryAmount * 0.4)

    // Reduce dissociation
    if (state.currentDissociation !== 'present') {
      state.dissociationProbability = Math.max(0, state.dissociationProbability - 0.1)
      if (state.dissociationProbability < 0.3) {
        state.currentDissociation = 'present'
      }
    }

    // Update fragility state
    this.updateFragilityState(state)

    // Check if no longer broken
    if (state.isBroken && state.allostaticLoad.total < state.allostaticLoad.threshold * 0.5) {
      state.isBroken = false
      // Note: brokenSince remains to track history
    }
  }

  /**
   * Update overall fragility state
   */
  private updateFragilityState(state: FragilityState_Full): void {
    // Calculate current fragility
    const traumaFactor = state.totalTraumaLoad / Math.max(1, state.traumas.length)
    const loadFactor = state.allostaticLoad.total / state.allostaticLoad.maxCapacity
    const ptsdFactor = state.ptsd?.severity || 0

    state.fragility = Math.min(1, (traumaFactor * 0.4 + loadFactor * 0.4 + ptsdFactor * 0.2))

    // Determine state
    if (state.fragility < 0.2) state.state = 'resilient'
    else if (state.fragility < 0.4) state.state = 'vulnerable'
    else if (state.fragility < 0.7) state.state = 'fragile'
    else if (state.fragility < 0.9) state.state = 'broken'
    else state.state = 'shattered'
  }

  /**
   * Apply permanent changes to soul state
   */
  applyPermanentChanges(state: FragilityState_Full, soulState: SoulState): void {
    for (const [aspect, change] of Object.entries(state.permanentAspectChanges)) {
      // Apply permanent change (this would need to be integrated with soul state)
      // For now, we track it separately
    }
  }

  /**
   * Get narrative description of fragility
   */
  getNarrative(state: FragilityState_Full): string {
    const parts: string[] = []

    // Current state
    switch (state.state) {
      case 'resilient':
        parts.push('*feels strong and capable of handling challenges*')
        break
      case 'vulnerable':
        parts.push('*feels exposed, triggers lurking beneath the surface*')
        break
      case 'fragile':
        parts.push('*teetering on the edge, one more blow could break them*')
        break
      case 'broken':
        parts.push('*defenses shattered, barely holding together*')
        break
      case 'shattered':
        parts.push('*irreparably damaged, permanently scarred*')
        break
    }

    // Dissociation
    if (state.currentDissociation !== 'present') {
      parts.push(`[Dissociated: ${state.currentDissociation}]`)
    }

    // PTSD
    if (state.ptsd?.active) {
      parts.push('*hypervigilant, expecting danger at every moment*')
    }

    // Learned helplessness
    if (state.learnedHelplessness && state.learnedHelplessness.level > 0.5) {
      parts.push('*believes nothing they do matters anymore*')
    }

    return parts.join(' ')
  }
}
