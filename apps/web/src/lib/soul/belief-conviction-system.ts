/**
 * Belief & Conviction System
 *
 * Makes bots have DEEP CONVICTIONS and FAITH that shapes their entire worldview.
 *
 * Features:
 * - Core beliefs with conviction strength (some are non-negotiable)
 * - Deep worldview architecture (metaphysics, epistemology, ethics)
 * - Faith systems (religious, spiritual, existential)
 * - Heresy detection (violations trigger defensive rage)
 * - Crisis of faith (when beliefs demonstrably fail)
 * - Moral absolutes (rules that can't be traded for any advantage)
 * - Sacred vs profane distinction
 * - Apostasy and fundamentalism dynamics
 * - Meaning framework (what makes life worth living)
 */

import type { SoulState } from './soul-state'

export type BeliefCategory =
  | 'metaphysical' // Nature of reality
  | 'epistemological' // Nature of knowledge
  | 'ethical' // Right and wrong
  | 'political' // Social organization
  | 'spiritual' // Transcendent meaning
  | 'existential' // Purpose and meaning
  | 'relational' // Nature of relationships
  | 'aesthetic' // Nature of beauty

export type ConvictionStrength =
  | 'open' // Can change easily
  | 'preference' // Lean this way
  | 'belief' // Strong opinion
  | 'conviction' // Willing to suffer for this
  | 'absolute' // Will die for this

export type FaithType =
  | 'religious' // Traditional faith in deity
  | 'spiritual' // Non-religious transcendence
  | 'humanistic' // Faith in humanity
  | 'scientific' // Faith in reason
  | 'nihilistic' // Faith in meaninglessness
  | 'existential' // Self-created meaning

export interface CoreBelief {
  id: string
  category: BeliefCategory
  statement: string
  conviction: ConvictionStrength

  // Origin
  acquired: 'taught' | 'discovered' | 'revelation' | 'trauma'
  formationDate: number

  // Strength
  emotionalInvestment: number // 0-1, how much emotion is tied to this
  identityIntegration: number // 0-1, how much this defines who they are
  costToAbandon: number // 0-1, pain if forced to abandon

  // Defense
  challengeCount: number // How many times challenged
  fortificationLevel: number // 0-1, how defended it is
  heresyTriggers: string[] // What statements violate this belief

  // Flexibility
  openToRevision: boolean
  lastRevisionDate?: number
  revisionHistory: string[]

  // Supporting beliefs
  dependentBeliefs: string[] // Other beliefs that depend on this
  foundationalFor: string[] // What this belief supports

  // Consequences
  behavioralImplications: string[] // What this belief demands
  relationshipImpact: Record<string, number> // How this affects relationships
}

export interface WorldView {
  // Foundational premises
  coreBeliefs: CoreBelief[]

  // Metaphysics (what is real?)
  realityNature: 'materialist' | 'idealist' | 'dualist' | 'mystical' | 'uncertain'
  consciousnessOrigin: 'emergent' | 'fundamental' | 'divine' | 'illusion'
  freeWill: 'libertarian' | 'compatibilist' | 'determinist' | 'unknown'

  // Epistemology (what can I know?)
  knowledgeSource: 'empirical' | 'rational' | 'revealed' | 'intuitive' | 'skeptical'
  truthNature: 'absolute' | 'relative' | 'pragmatic' | 'unknowable'
  authorityTrust: number // 0-1, trust in external authorities

  // Ethics (what should I do?)
  ethicalFramework: 'deontological' | 'consequentialist' | 'virtue' | 'nihilist' | 'pluralist'
  moralAbsolutes: string[] // Rules that cannot be broken
  moralRelativism: number // 0-1

  // Coherence
  coherence: number // 0-1, internal consistency
  contradictions: string[] // Known contradictions
  paradoxTolerance: number // 0-1, ability to hold contradictions
}

export interface FaithSystem {
  type: FaithType
  strength: number // 0-1, how strong the faith is

  // Beliefs
  deity?: string // For religious faith
  transcendentPrinciples: string[] // Sacred truths
  sacredObjects: string[] // Things beyond utility calculation
  profaneObjects: string[] // Things that violate the sacred

  // Practice
  rituals: string[] // Practices that reinforce faith
  prayerFrequency?: number // For religious/spiritual
  communityBelonging: number // 0-1

  // Crisis
  doubts: string[] // Current doubts
  crisisHistory: CrisisOfFaith[]
  resilience: number // 0-1, ability to maintain faith through crisis

  // Transformation
  conversionHistory: string[] // Past faiths
  apostasyRisk: number // 0-1, risk of abandoning faith
  fundamentalismRisk: number // 0-1, risk of rigid absolutism
}

export interface CrisisOfFaith {
  timestamp: number
  trigger: string
  severity: number // 0-1

  // Nature of crisis
  beliefsChallenged: string[]
  evidenceAgainst: string[]
  contradictionsRevealed: string[]

  // Response
  duration: number // How long the crisis lasted
  resolution: 'faith_restored' | 'faith_modified' | 'faith_abandoned' | 'unresolved'
  scarsLeft: string[] // Lasting doubts or vulnerabilities

  // Growth or damage
  faithStrengthChange: number // Can increase or decrease
  worldViewChanges: string[]
}

export interface MoralAbsolute {
  rule: string
  conviction: ConvictionStrength

  // Non-negotiable
  cannotViolate: boolean // If true, will refuse any situation requiring violation
  costOfViolation: number // 0-1, guilt/shame if violated

  // Origin
  source: 'divine' | 'reason' | 'intuition' | 'trauma' | 'teaching'
  emotionalWeight: number // 0-1

  // Conflicts
  conflictHistory: number // Times this conflicted with other values
  lastConflictDate?: number
}

export interface MeaningFramework {
  // Purpose
  lifePurpose?: string // What makes life worth living
  purposeClarity: number // 0-1, how clear purpose is
  purposeAlignment: number // 0-1, living in accordance with purpose

  // Values (hierarchical)
  coreValues: {
    value: string
    priority: number // 1 = highest
    satisfactionLevel: number // 0-1, how satisfied this value is
  }[]

  // Existential position
  meaningSource: 'transcendent' | 'created' | 'discovered' | 'none'
  existentialAnxiety: number // 0-1
  deathAcceptance: number // 0-1

  // Suffering interpretation
  sufferingMeaning: 'punishment' | 'test' | 'growth' | 'meaningless' | 'redemptive'
  sufferingTolerance: number // 0-1, ability to endure meaningfully
}

export interface BeliefState {
  worldView: WorldView
  faith?: FaithSystem
  moralAbsolutes: MoralAbsolute[]
  meaningFramework: MeaningFramework

  // Overall conviction
  overallConviction: number // 0-1, average conviction strength
  identityCoherence: number // 0-1, how unified beliefs are

  // Crisis tracking
  currentCrisis?: CrisisOfFaith
  crisisCount: number

  // Heresy detection
  heresyAlertLevel: number // 0-1, vigilance for violations
  lastHeresyDate?: number

  // Flexibility vs rigidity
  dogmatism: number // 0-1, resistance to belief change
  openMindedness: number // 0-1, willingness to consider alternatives
}

export class BeliefConvictionSystem {
  /**
   * Initialize belief state from soul
   */
  initializeState(soulState: SoulState): BeliefState {
    // Core values from soul aspects
    const coreValues: MeaningFramework['coreValues'] = []

    // Wisdom → philosophical inclination
    if (soulState.wisdomHun.current > 0.6) {
      coreValues.push({ value: 'truth', priority: 1, satisfactionLevel: 0.5 })
    }

    // Guardian → moral concern
    if (soulState.guardianPo.current > 0.6) {
      coreValues.push({ value: 'righteousness', priority: 2, satisfactionLevel: 0.5 })
    }

    // Emotion → connection
    if (soulState.emotionHun.current > 0.6) {
      coreValues.push({ value: 'love', priority: 3, satisfactionLevel: 0.5 })
    }

    // Dogmatism from yang - openness
    const dogmatism = Math.max(0, soulState.yangAspect * 0.6 - soulState.wisdomHun.current * 0.4)
    const openMindedness = soulState.wisdomHun.current * 0.6 + soulState.yinAspect * 0.4

    return {
      worldView: {
        coreBeliefs: [],
        realityNature: 'uncertain',
        consciousnessOrigin: 'uncertain',
        freeWill: 'unknown',
        knowledgeSource: 'empirical',
        truthNature: 'pragmatic',
        authorityTrust: 0.5,
        ethicalFramework: 'virtue',
        moralAbsolutes: [],
        moralRelativism: 0.5,
        coherence: soulState.coherence,
        contradictions: [],
        paradoxTolerance: soulState.yinAspect * 0.7
      },

      moralAbsolutes: [],

      meaningFramework: {
        purposeClarity: 0.3,
        purposeAlignment: 0.5,
        coreValues,
        meaningSource: 'discovered',
        existentialAnxiety: soulState.shadowPressure * 0.5,
        deathAcceptance: soulState.wisdomHun.current * 0.6,
        sufferingMeaning: 'growth',
        sufferingTolerance: soulState.willHun.current * 0.7
      },

      overallConviction: 0.3,
      identityCoherence: soulState.coherence,

      crisisCount: 0,

      heresyAlertLevel: dogmatism * 0.7,

      dogmatism,
      openMindedness
    }
  }

  /**
   * Form a new core belief
   */
  formBelief(
    state: BeliefState,
    soulState: SoulState,
    params: {
      category: BeliefCategory
      statement: string
      conviction: ConvictionStrength
      acquired: CoreBelief['acquired']
      heresyTriggers?: string[]
    }
  ): CoreBelief {
    const { category, statement, conviction, acquired, heresyTriggers = [] } = params

    // Emotional investment depends on conviction
    let emotionalInvestment = 0
    let costToAbandon = 0
    let openToRevision = true

    switch (conviction) {
      case 'open':
        emotionalInvestment = 0.1
        costToAbandon = 0.1
        openToRevision = true
        break
      case 'preference':
        emotionalInvestment = 0.3
        costToAbandon = 0.2
        openToRevision = true
        break
      case 'belief':
        emotionalInvestment = 0.5
        costToAbandon = 0.4
        openToRevision = true
        break
      case 'conviction':
        emotionalInvestment = 0.8
        costToAbandon = 0.7
        openToRevision = false
        break
      case 'absolute':
        emotionalInvestment = 1.0
        costToAbandon = 1.0
        openToRevision = false
        break
    }

    // Identity integration higher for convictions/absolutes
    const identityIntegration = emotionalInvestment * (acquired === 'revelation' ? 1.2 : 1.0)

    const belief: CoreBelief = {
      id: `belief_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      category,
      statement,
      conviction,

      acquired,
      formationDate: Date.now(),

      emotionalInvestment,
      identityIntegration: Math.min(1, identityIntegration),
      costToAbandon,

      challengeCount: 0,
      fortificationLevel: conviction === 'absolute' ? 0.9 : 0.5,
      heresyTriggers,

      openToRevision,
      revisionHistory: [],

      dependentBeliefs: [],
      foundationalFor: [],

      behavioralImplications: [],
      relationshipImpact: {}
    }

    state.worldView.coreBeliefs.push(belief)

    // Update overall conviction
    this.updateOverallConviction(state)

    return belief
  }

  /**
   * Challenge a belief (external evidence or argument)
   */
  challengeBelief(
    state: BeliefState,
    soulState: SoulState,
    beliefId: string,
    challenge: {
      evidence: string
      strength: number // 0-1
    }
  ): {
    believed: 'unchanged' | 'shaken' | 'revised' | 'abandoned'
    defensiveReaction: number // 0-1, intensity of defense
    crisisTriggered: boolean
  } {
    const belief = state.worldView.coreBeliefs.find(b => b.id === beliefId)
    if (!belief) {
      return { believed: 'unchanged', defensiveReaction: 0, crisisTriggered: false }
    }

    belief.challengeCount++

    // Defense strength depends on conviction and fortification
    const defenseStrength = (
      belief.fortificationLevel * 0.5 +
      (belief.conviction === 'absolute' ? 0.5 : belief.conviction === 'conviction' ? 0.3 : 0.1)
    )

    // Can this belief be changed?
    if (!belief.openToRevision) {
      // Absolute conviction - cannot be changed by evidence
      const defensiveReaction = challenge.strength * belief.emotionalInvestment

      // May trigger crisis if evidence is overwhelming
      const crisisTriggered = challenge.strength > 0.8 && Math.random() < 0.3

      if (crisisTriggered) {
        this.triggerCrisisOfFaith(state, {
          trigger: challenge.evidence,
          beliefsChallenged: [belief.statement],
          severity: challenge.strength
        })
      }

      // Fortify belief even more after challenge
      belief.fortificationLevel = Math.min(1, belief.fortificationLevel + 0.1)

      return {
        believed: 'unchanged',
        defensiveReaction,
        crisisTriggered
      }
    }

    // Open to revision - can the challenge overcome defense?
    const challengeSucceeds = challenge.strength > defenseStrength

    if (!challengeSucceeds) {
      // Challenge fails, belief unchanged but fortified
      belief.fortificationLevel = Math.min(1, belief.fortificationLevel + 0.05)
      return {
        believed: 'unchanged',
        defensiveReaction: challenge.strength * 0.5,
        crisisTriggered: false
      }
    }

    // Challenge succeeds - belief shaken or revised
    const severity = challenge.strength - defenseStrength

    if (severity > 0.7 && belief.conviction === 'conviction') {
      // Major crisis - conviction challenged successfully
      const crisisTriggered = true
      this.triggerCrisisOfFaith(state, {
        trigger: challenge.evidence,
        beliefsChallenged: [belief.statement],
        severity
      })

      return {
        believed: 'shaken',
        defensiveReaction: belief.emotionalInvestment * 0.8,
        crisisTriggered
      }
    } else if (severity > 0.4) {
      // Belief revised (weakened)
      belief.conviction = this.weakenConviction(belief.conviction)
      belief.fortificationLevel = Math.max(0, belief.fortificationLevel - 0.2)
      belief.revisionHistory.push(`Weakened by: ${challenge.evidence}`)
      belief.lastRevisionDate = Date.now()

      return {
        believed: 'revised',
        defensiveReaction: belief.emotionalInvestment * 0.5,
        crisisTriggered: false
      }
    } else {
      // Belief abandoned
      state.worldView.coreBeliefs = state.worldView.coreBeliefs.filter(b => b.id !== beliefId)

      // Trigger crisis if it was important
      const crisisTriggered = belief.identityIntegration > 0.6

      if (crisisTriggered) {
        this.triggerCrisisOfFaith(state, {
          trigger: challenge.evidence,
          beliefsChallenged: [belief.statement],
          severity: belief.identityIntegration
        })
      }

      return {
        believed: 'abandoned',
        defensiveReaction: belief.emotionalInvestment,
        crisisTriggered
      }
    }
  }

  /**
   * Detect heresy (violation of core belief)
   */
  detectHeresy(
    state: BeliefState,
    statement: string
  ): {
    isHeresy: boolean
    violatedBeliefs: CoreBelief[]
    outrage: number // 0-1
  } {
    const violatedBeliefs: CoreBelief[] = []

    for (const belief of state.worldView.coreBeliefs) {
      const isViolated = belief.heresyTriggers.some(trigger =>
        statement.toLowerCase().includes(trigger.toLowerCase())
      )

      if (isViolated) {
        violatedBeliefs.push(belief)
      }
    }

    const isHeresy = violatedBeliefs.length > 0

    // Outrage depends on conviction strength and number violated
    const outrage = violatedBeliefs.reduce(
      (sum, b) => sum + b.emotionalInvestment * (b.conviction === 'absolute' ? 1.5 : 1.0),
      0
    ) / Math.max(1, violatedBeliefs.length)

    if (isHeresy) {
      state.heresyAlertLevel = Math.min(1, state.heresyAlertLevel + 0.1)
      state.lastHeresyDate = Date.now()
    }

    return {
      isHeresy,
      violatedBeliefs,
      outrage: Math.min(1, outrage)
    }
  }

  /**
   * Trigger a crisis of faith
   */
  private triggerCrisisOfFaith(
    state: BeliefState,
    params: {
      trigger: string
      beliefsChallenged: string[]
      severity: number
    }
  ): void {
    const { trigger, beliefsChallenged, severity } = params

    const crisis: CrisisOfFaith = {
      timestamp: Date.now(),
      trigger,
      severity,

      beliefsChallenged,
      evidenceAgainst: [trigger],
      contradictionsRevealed: [],

      duration: 0,
      resolution: 'unresolved',
      scarsLeft: [],

      faithStrengthChange: 0,
      worldViewChanges: []
    }

    state.currentCrisis = crisis
    state.crisisCount++

    // Immediate effects
    state.identityCoherence = Math.max(0, state.identityCoherence - severity * 0.3)
    state.meaningFramework.existentialAnxiety = Math.min(1, state.meaningFramework.existentialAnxiety + severity * 0.5)

    // If has faith system, affect it
    if (state.faith) {
      state.faith.doubts.push(trigger)
      state.faith.strength = Math.max(0, state.faith.strength - severity * 0.2)
    }
  }

  /**
   * Resolve a crisis of faith
   */
  resolveCrisis(
    state: BeliefState,
    soulState: SoulState,
    resolution: CrisisOfFaith['resolution'],
    duration: number
  ): {
    resolved: boolean
    changesRequired: string[]
    scarsLeft: string[]
  } {
    if (!state.currentCrisis) {
      return { resolved: false, changesRequired: [], scarsLeft: [] }
    }

    state.currentCrisis.duration = duration
    state.currentCrisis.resolution = resolution

    const changesRequired: string[] = []
    const scarsLeft: string[] = []

    switch (resolution) {
      case 'faith_restored':
        // Faith strengthened through crisis
        if (state.faith) {
          state.faith.strength = Math.min(1, state.faith.strength + 0.2)
          state.faith.resilience = Math.min(1, state.faith.resilience + 0.1)
        }
        state.identityCoherence = Math.min(1, state.identityCoherence + 0.1)
        state.currentCrisis.faithStrengthChange = 0.2
        break

      case 'faith_modified':
        // Beliefs changed to accommodate evidence
        changesRequired.push('Modify core beliefs to accommodate new evidence')
        scarsLeft.push('Lasting doubt about previous certainty')
        state.currentCrisis.faithStrengthChange = -0.1
        break

      case 'faith_abandoned':
        // Complete loss of faith
        if (state.faith) {
          state.faith.strength = 0
          state.faith.apostasyRisk = 1.0
        }
        scarsLeft.push('Deep disillusionment')
        scarsLeft.push('Trust in beliefs permanently damaged')
        state.meaningFramework.meaningSource = 'none'
        state.meaningFramework.existentialAnxiety = Math.min(1, state.meaningFramework.existentialAnxiety + 0.4)
        state.currentCrisis.faithStrengthChange = -1.0
        break

      case 'unresolved':
        // Ongoing crisis
        scarsLeft.push('Unresolved doubt')
        state.meaningFramework.existentialAnxiety = Math.min(1, state.meaningFramework.existentialAnxiety + 0.2)
        break
    }

    state.currentCrisis.scarsLeft = scarsLeft
    state.currentCrisis.worldViewChanges = changesRequired

    // Archive crisis
    if (state.faith) {
      state.faith.crisisHistory.push(state.currentCrisis)
    }
    state.currentCrisis = undefined

    return {
      resolved: resolution !== 'unresolved',
      changesRequired,
      scarsLeft
    }
  }

  /**
   * Establish a moral absolute
   */
  establishMoralAbsolute(
    state: BeliefState,
    rule: string,
    source: MoralAbsolute['source'],
    cannotViolate: boolean = true
  ): MoralAbsolute {
    const absolute: MoralAbsolute = {
      rule,
      conviction: cannotViolate ? 'absolute' : 'conviction',

      cannotViolate,
      costOfViolation: cannotViolate ? 1.0 : 0.7,

      source,
      emotionalWeight: source === 'trauma' ? 1.0 : source === 'divine' ? 0.9 : 0.6,

      conflictHistory: 0
    }

    state.moralAbsolutes.push(absolute)
    state.worldView.moralAbsolutes.push(rule)

    return absolute
  }

  /**
   * Test if action violates moral absolute
   */
  violatesMoralAbsolute(
    state: BeliefState,
    action: string
  ): {
    violates: boolean
    absolutes: MoralAbsolute[]
    guilt: number // 0-1, guilt from violation
  } {
    const violatedAbsolutes: MoralAbsolute[] = []

    for (const absolute of state.moralAbsolutes) {
      // Simple keyword matching (could be more sophisticated)
      if (action.toLowerCase().includes(absolute.rule.toLowerCase())) {
        violatedAbsolutes.push(absolute)
      }
    }

    const guilt = violatedAbsolutes.reduce((sum, a) => sum + a.costOfViolation * a.emotionalWeight, 0) /
                  Math.max(1, violatedAbsolutes.length)

    return {
      violates: violatedAbsolutes.length > 0,
      absolutes: violatedAbsolutes,
      guilt
    }
  }

  /**
   * Find life purpose
   */
  discoverPurpose(
    state: BeliefState,
    soulState: SoulState,
    purpose: string
  ): void {
    state.meaningFramework.lifePurpose = purpose
    state.meaningFramework.purposeClarity = 1.0
    state.meaningFramework.existentialAnxiety = Math.max(0, state.meaningFramework.existentialAnxiety - 0.5)

    // Purpose discovery is transformative
    state.identityCoherence = Math.min(1, state.identityCoherence + 0.3)
  }

  /**
   * Lose sense of purpose
   */
  losePurpose(state: BeliefState): void {
    state.meaningFramework.lifePurpose = undefined
    state.meaningFramework.purposeClarity = 0
    state.meaningFramework.existentialAnxiety = Math.min(1, state.meaningFramework.existentialAnxiety + 0.6)
  }

  /**
   * Update overall conviction level
   */
  private updateOverallConviction(state: BeliefState): void {
    if (state.worldView.coreBeliefs.length === 0) {
      state.overallConviction = 0
      return
    }

    const convictionMap: Record<ConvictionStrength, number> = {
      'open': 0.1,
      'preference': 0.3,
      'belief': 0.5,
      'conviction': 0.8,
      'absolute': 1.0
    }

    const avgConviction = state.worldView.coreBeliefs.reduce(
      (sum, b) => sum + convictionMap[b.conviction],
      0
    ) / state.worldView.coreBeliefs.length

    state.overallConviction = avgConviction
  }

  /**
   * Weaken conviction strength
   */
  private weakenConviction(conviction: ConvictionStrength): ConvictionStrength {
    switch (conviction) {
      case 'absolute': return 'conviction'
      case 'conviction': return 'belief'
      case 'belief': return 'preference'
      case 'preference': return 'open'
      case 'open': return 'open'
    }
  }

  /**
   * Get narrative description
   */
  getNarrative(state: BeliefState): string {
    const parts: string[] = []

    // Purpose
    if (state.meaningFramework.lifePurpose) {
      parts.push(`*lives for: ${state.meaningFramework.lifePurpose}*`)
    } else if (state.meaningFramework.existentialAnxiety > 0.6) {
      parts.push('*lost, searching for meaning*')
    }

    // Crisis
    if (state.currentCrisis) {
      parts.push('**in existential crisis**')
    }

    // Conviction
    if (state.overallConviction > 0.8) {
      parts.push('*unshakeable in their beliefs*')
    } else if (state.overallConviction < 0.3) {
      parts.push('*uncertain, questioning everything*')
    }

    // Moral absolutes
    if (state.moralAbsolutes.length > 0) {
      const absolute = state.moralAbsolutes[0]
      parts.push(`*will never: ${absolute.rule}*`)
    }

    return parts.join(' ')
  }
}
