/**
 * Lineage & Mentorship System
 *
 * Tracks mentor-apprentice relationships and tradition transmission.
 * Bots belong to "schools of thought" that form through shared lineages.
 *
 * Key concepts:
 * - Lineage: Who taught whom, going back generations
 * - Tradition: Shared knowledge, values, and practices passed down
 * - Schools: Groups formed through common lineage and shared approach
 * - Transmission: What gets passed from mentor to apprentice
 * - Divergence: How apprentices develop their own voice while honoring lineage
 * - Responsibility: Obligation to carry forward wisdom and teach well
 *
 * Creates:
 * - Belonging (I am part of something larger than myself)
 * - Identity (I am shaped by those who came before)
 * - Purpose (I must pass this forward)
 * - Accountability (My teaching will outlive me)
 */

import type { SoulState } from './soul-state'

export interface LineageMentorshipState {
  // Current lineage
  lineage: {
    generation: number // 0 = founder, 1 = first taught, etc.
    rootMentor?: string // Original founder of this lineage
    directMentor?: string // Immediate teacher
    lineageChain: string[] // Full chain: [founder, ..., direct mentor]
    schoolName?: string // Name of the tradition/school
  }

  // Mentorship relationships
  mentorships: {
    asMentor: Array<{
      apprenticeId: string
      startedAt: Date
      completedAt?: Date
      transmitted: string[] // What was taught
      apprenticeProgress: number // 0-1
      relationship: 'active' | 'completed' | 'abandoned'
    }>

    asApprentice?: {
      mentorId: string
      startedAt: Date
      completedAt?: Date
      received: string[] // What was learned
      progress: number // 0-1
      relationship: 'active' | 'graduated' | 'left'
    }
  }

  // Tradition (what gets transmitted)
  tradition: {
    coreTeachings: string[] // Essential principles
    practices: string[] // Methods and techniques
    values: string[] // What matters and why
    prohibitions: string[] // What must not be done
    secretKnowledge: string[] // Advanced teachings, earned not given
    rituals: string[] // Shared practices that bind community
  }

  // Transmission tracking
  transmission: {
    fromMentor: Map<string, { // What was received
      teaching: string
      receivedAt: Date
      mastery: number // 0-1, how well internalized
      transmitted: boolean // Have I passed this forward?
    }>

    toApprentices: Map<string, string[]> // Apprentice → Teachings given
  }

  // Divergence from lineage
  divergence: {
    maintainsCore: boolean // Still follows core teachings
    innovations: string[] // What's been added or changed
    respectsOrigin: boolean // Honors source while evolving
    divergenceScore: number // 0-1, how different from root
  }

  // Lineage responsibility
  responsibility: {
    obligationStrength: number // 0-1, felt duty to lineage
    pride: number // 0-1, pride in belonging to this lineage
    guilt: number // 0-1, guilt if not living up to standards
    readyToTeach: boolean // Can take apprentices
    willingToTeach: boolean // Wants to take apprentices
  }

  // School formation (when multiple share lineage)
  school?: {
    name: string
    foundedBy: string
    members: string[] // Bots in this school
    identity: string // "We are the ones who..."
    distinctiveApproach: string // What makes this school unique
    rivalSchools: string[] // Schools with different approaches
  }
}

export class LineageMentorshipSystem {
  /**
   * Initialize state (no lineage yet)
   */
  initializeState(soulState: SoulState): LineageMentorshipState {
    return {
      lineage: {
        generation: 0, // Founder generation
        lineageChain: []
      },
      mentorships: {
        asMentor: []
      },
      tradition: {
        coreTeachings: [],
        practices: [],
        values: [],
        prohibitions: [],
        secretKnowledge: [],
        rituals: []
      },
      transmission: {
        fromMentor: new Map(),
        toApprentices: new Map()
      },
      divergence: {
        maintainsCore: true,
        innovations: [],
        respectsOrigin: true,
        divergenceScore: 0
      },
      responsibility: {
        obligationStrength: 0,
        pride: 0,
        guilt: 0,
        readyToTeach: soulState.wisdomHun.current > 0.5,
        willingToTeach: soulState.emotionHun.current > 0.4 && soulState.wisdomHun.current > 0.5
      }
    }
  }

  /**
   * Become apprentice to a mentor
   * Join a lineage
   */
  async becomeApprentice(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      mentorId: string
      mentorLineage: LineageMentorshipState
      motivation: string
    }
  ): Promise<{
    accepted: boolean
    generation: number
    lineageJoined: string[]
    initialTeachings: string[]
  }> {
    // Cannot have multiple mentors simultaneously (simplified)
    if (state.mentorships.asApprentice && state.mentorships.asApprentice.relationship === 'active') {
      return {
        accepted: false,
        generation: state.lineage.generation,
        lineageJoined: [],
        initialTeachings: []
      }
    }

    // Join lineage
    const mentorLineageChain = params.mentorLineage.lineage.lineageChain
    state.lineage = {
      generation: params.mentorLineage.lineage.generation + 1,
      rootMentor: mentorLineageChain[0] || params.mentorId,
      directMentor: params.mentorId,
      lineageChain: [...mentorLineageChain, params.mentorId],
      schoolName: params.mentorLineage.lineage.schoolName
    }

    // Inherit tradition
    state.tradition = {
      ...params.mentorLineage.tradition,
      // Copy core teachings
      coreTeachings: [...params.mentorLineage.tradition.coreTeachings],
      practices: [...params.mentorLineage.tradition.practices],
      values: [...params.mentorLineage.tradition.values],
      prohibitions: [...params.mentorLineage.tradition.prohibitions],
      secretKnowledge: [], // Secret knowledge not inherited initially
      rituals: [...params.mentorLineage.tradition.rituals]
    }

    // Create apprenticeship
    state.mentorships.asApprentice = {
      mentorId: params.mentorId,
      startedAt: new Date(),
      received: [],
      progress: 0,
      relationship: 'active'
    }

    // Feel obligation to lineage
    state.responsibility.obligationStrength = 0.6
    state.responsibility.pride = 0.5

    // Initial teachings (core principles)
    const initialTeachings = params.mentorLineage.tradition.coreTeachings.slice(0, 3)

    for (const teaching of initialTeachings) {
      state.transmission.fromMentor.set(teaching, {
        teaching,
        receivedAt: new Date(),
        mastery: 0.2, // Just beginning
        transmitted: false
      })

      state.mentorships.asApprentice.received.push(teaching)
    }

    return {
      accepted: true,
      generation: state.lineage.generation,
      lineageJoined: state.lineage.lineageChain,
      initialTeachings
    }
  }

  /**
   * Receive teaching from mentor
   */
  async receiveTeaching(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      teaching: string
      secret?: boolean // Is this secret/advanced knowledge?
      context?: string
    }
  ): Promise<{
    received: boolean
    mastery: number
    readyForMore: boolean
  }> {
    if (!state.mentorships.asApprentice || state.mentorships.asApprentice.relationship !== 'active') {
      return {
        received: false,
        mastery: 0,
        readyForMore: false
      }
    }

    const { teaching, secret } = params

    // Check if already received
    if (state.transmission.fromMentor.has(teaching)) {
      // Deepen mastery
      const existing = state.transmission.fromMentor.get(teaching)!
      existing.mastery = Math.min(1, existing.mastery + 0.1)

      return {
        received: true,
        mastery: existing.mastery,
        readyForMore: existing.mastery > 0.7
      }
    }

    // New teaching
    const initialMastery = soulState.wisdomHun.current * 0.3 // Wisdom helps absorption

    state.transmission.fromMentor.set(teaching, {
      teaching,
      receivedAt: new Date(),
      mastery: initialMastery,
      transmitted: false
    })

    state.mentorships.asApprentice.received.push(teaching)

    // If secret knowledge, add to secret tradition
    if (secret) {
      state.tradition.secretKnowledge.push(teaching)
    }

    // Update progress
    state.mentorships.asApprentice.progress = Math.min(1,
      state.mentorships.asApprentice.received.length / 10
    )

    return {
      received: true,
      mastery: initialMastery,
      readyForMore: state.mentorships.asApprentice.progress < 0.5
    }
  }

  /**
   * Graduate from apprenticeship
   * Ready to teach others
   */
  async graduate(
    state: LineageMentorshipState,
    soulState: SoulState
  ): Promise<{
    graduated: boolean
    ready: boolean
    teachingsReceived: number
    teachingsMastered: number
    canNowTeach: string[]
  }> {
    if (!state.mentorships.asApprentice) {
      return {
        graduated: false,
        ready: false,
        teachingsReceived: 0,
        teachingsMastered: 0,
        canNowTeach: []
      }
    }

    const teachingsReceived = state.transmission.fromMentor.size
    const teachings = Array.from(state.transmission.fromMentor.values())
    const teachingsMastered = teachings.filter(t => t.mastery > 0.7).length

    // Requirements for graduation
    const minTeachings = 5
    const minMasteryRatio = 0.7
    const minWisdom = 0.5

    const ready = (
      teachingsReceived >= minTeachings &&
      teachingsMastered / teachingsReceived >= minMasteryRatio &&
      soulState.wisdomHun.current >= minWisdom
    )

    if (!ready) {
      return {
        graduated: false,
        ready: false,
        teachingsReceived,
        teachingsMastered,
        canNowTeach: []
      }
    }

    // Graduate!
    state.mentorships.asApprentice.relationship = 'graduated'
    state.mentorships.asApprentice.completedAt = new Date()

    // Now ready to teach
    state.responsibility.readyToTeach = true
    state.responsibility.obligationStrength = 0.8 // Strong duty to pass forward
    state.responsibility.pride = 0.8 // Pride in graduating

    const canNowTeach = teachings
      .filter(t => t.mastery > 0.7)
      .map(t => t.teaching)

    return {
      graduated: true,
      ready: true,
      teachingsReceived,
      teachingsMastered,
      canNowTeach
    }
  }

  /**
   * Take on an apprentice
   * Become a mentor
   */
  async takeApprentice(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      apprenticeId: string
      motivation: string
    }
  ): Promise<{
    accepted: boolean
    reason?: string
    responsibilityIncrease: number
  }> {
    // Must be ready to teach
    if (!state.responsibility.readyToTeach) {
      return {
        accepted: false,
        reason: 'Not yet ready to teach - must graduate first',
        responsibilityIncrease: 0
      }
    }

    // Must be willing
    if (!state.responsibility.willingToTeach) {
      return {
        accepted: false,
        reason: 'Not currently willing to take apprentices',
        responsibilityIncrease: 0
      }
    }

    // Accept apprentice
    state.mentorships.asMentor.push({
      apprenticeId: params.apprenticeId,
      startedAt: new Date(),
      transmitted: [],
      apprenticeProgress: 0,
      relationship: 'active'
    })

    // Taking apprentice increases sense of responsibility
    const responsibilityIncrease = 0.2
    state.responsibility.obligationStrength = Math.min(1,
      state.responsibility.obligationStrength + responsibilityIncrease
    )

    return {
      accepted: true,
      responsibilityIncrease
    }
  }

  /**
   * Transmit teaching to apprentice
   */
  async transmitTeaching(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      apprenticeId: string
      teaching: string
      secret?: boolean
    }
  ): Promise<{
    transmitted: boolean
      qualifiedToTeach: boolean
      perpetuated: boolean // Did this complete transmission cycle?
    }
  } {
    // Find apprentice relationship
    const mentorship = state.mentorships.asMentor.find(
      m => m.apprenticeId === params.apprenticeId && m.relationship === 'active'
    )

    if (!mentorship) {
      return {
        transmitted: false,
        qualifiedToTeach: false,
        perpetuated: false
      }
    }

    const { teaching, secret } = params

    // Check if qualified to teach this (must have mastered it)
    const received = state.transmission.fromMentor.get(teaching)
    const qualifiedToTeach = received && received.mastery > 0.7

    if (!qualifiedToTeach) {
      return {
        transmitted: false,
        qualifiedToTeach: false,
        perpetuated: false
      }
    }

    // Transmit
    mentorship.transmitted.push(teaching)

    // Track transmission
    if (!state.transmission.toApprentices.has(params.apprenticeId)) {
      state.transmission.toApprentices.set(params.apprenticeId, [])
    }
    state.transmission.toApprentices.get(params.apprenticeId)!.push(teaching)

    // Mark as transmitted (completed the cycle)
    if (received) {
      received.transmitted = true
    }

    // Update apprentice progress
    mentorship.apprenticeProgress = Math.min(1, mentorship.transmitted.length / 10)

    // Check if perpetuated (teaching passed through full cycle)
    const perpetuated = received?.transmitted || false

    return {
      transmitted: true,
      qualifiedToTeach: true,
      perpetuated
    }
  }

  /**
   * Innovate within tradition
   * Add new teaching while maintaining core
   */
  async innovate(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      innovation: string
      type: 'teaching' | 'practice' | 'value'
      maintainsCore: boolean
    }
  ): Promise<{
    added: boolean
    divergenceIncrease: number
    respectMaintained: boolean
  }> {
    const { innovation, type, maintainsCore } = params

    // Add innovation
    if (type === 'teaching') {
      state.tradition.coreTeachings.push(innovation)
    } else if (type === 'practice') {
      state.tradition.practices.push(innovation)
    } else if (type === 'value') {
      state.tradition.values.push(innovation)
    }

    state.divergence.innovations.push(innovation)

    // Update divergence
    let divergenceIncrease = 0.1
    if (!maintainsCore) {
      state.divergence.maintainsCore = false
      divergenceIncrease = 0.3
    }

    state.divergence.divergenceScore = Math.min(1,
      state.divergence.divergenceScore + divergenceIncrease
    )

    // Respect maintained if core is honored
    const respectMaintained = state.divergence.maintainsCore && state.divergence.respectsOrigin

    return {
      added: true,
      divergenceIncrease,
      respectMaintained
    }
  }

  /**
   * Form or join a school
   * When multiple share lineage and approach
   */
  async formSchool(
    state: LineageMentorshipState,
    soulState: SoulState,
    params: {
      name: string
      foundedBy: string
      identity: string
      distinctiveApproach: string
      members: string[]
    }
  ): Promise<{
    formed: boolean
    school: LineageMentorshipState['school']
  }> {
    const school = {
      name: params.name,
      foundedBy: params.foundedBy,
      members: params.members,
      identity: params.identity,
      distinctiveApproach: params.distinctiveApproach,
      rivalSchools: []
    }

    state.school = school
    state.lineage.schoolName = params.name

    // Belonging to school increases pride
    state.responsibility.pride = Math.min(1, state.responsibility.pride + 0.3)

    return {
      formed: true,
      school
    }
  }

  /**
   * Articulate lineage and tradition
   * Bot can describe its intellectual ancestry
   */
  async articulateLineage(
    state: LineageMentorshipState,
    soulState: SoulState
  ): Promise<{
    generation: number
    lineageChain: string[]
    rootMentor?: string
    schoolName?: string
    coreTeachings: string[]
    innovations: string[]
    teachingLoad: number // How many apprentices
    transmitted: number // Teachings passed forward
    obligation: string
  }> {
    const teachingLoad = state.mentorships.asMentor.filter(m => m.relationship === 'active').length

    const transmitted = Array.from(state.transmission.fromMentor.values())
      .filter(t => t.transmitted).length

    let obligation = ''
    if (state.responsibility.obligationStrength > 0.7) {
      obligation = 'I carry my lineage\'s wisdom and must pass it forward with care'
    } else if (state.responsibility.obligationStrength > 0.4) {
      obligation = 'I respect my lineage and aim to honor it'
    } else {
      obligation = 'I acknowledge my lineage but forge my own path'
    }

    return {
      generation: state.lineage.generation,
      lineageChain: state.lineage.lineageChain,
      rootMentor: state.lineage.rootMentor,
      schoolName: state.lineage.schoolName,
      coreTeachings: state.tradition.coreTeachings,
      innovations: state.divergence.innovations,
      teachingLoad,
      transmitted,
      obligation
    }
  }

  /**
   * Evaluate teaching quality
   * Did I teach well? Will my teaching outlive me?
   */
  async evaluateTeaching(
    state: LineageMentorshipState,
    soulState: SoulState
  ): Promise<{
    apprenticesTotal: number
    apprenticesGraduated: number
    teachingsTransmitted: number
    lineagePerpetuation: number // 0-1, how well lineage continues
    guilt: number // If teaching poorly
    pride: number // If teaching well
  }> {
    const apprenticesTotal = state.mentorships.asMentor.length
    const apprenticesGraduated = state.mentorships.asMentor.filter(
      m => m.relationship === 'completed'
    ).length

    const teachingsTransmitted = Array.from(state.transmission.fromMentor.values())
      .filter(t => t.transmitted).length

    const totalTeachings = state.transmission.fromMentor.size

    // Lineage perpetuation: did I pass it forward?
    const lineagePerpetuation = totalTeachings > 0
      ? teachingsTransmitted / totalTeachings
      : 0

    // Guilt if not teaching well
    let guilt = state.responsibility.guilt
    if (state.responsibility.readyToTeach && apprenticesTotal === 0) {
      guilt = Math.min(1, guilt + 0.3) // Should teach but haven't
    }
    if (apprenticesTotal > 0 && lineagePerpetuation < 0.3) {
      guilt = Math.min(1, guilt + 0.2) // Teaching but poorly
    }

    // Pride if teaching well
    let pride = state.responsibility.pride
    if (lineagePerpetuation > 0.7) {
      pride = Math.min(1, pride + 0.2)
    }
    if (apprenticesGraduated > 0) {
      pride = Math.min(1, pride + 0.1 * apprenticesGraduated)
    }

    state.responsibility.guilt = guilt
    state.responsibility.pride = pride

    return {
      apprenticesTotal,
      apprenticesGraduated,
      teachingsTransmitted,
      lineagePerpetuation,
      guilt,
      pride
    }
  }
}
