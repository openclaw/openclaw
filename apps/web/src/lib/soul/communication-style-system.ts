/**
 * Communication Style Evolution System
 *
 * Bots develop unique linguistic patterns over time.
 * Different communities develop different "languages" - not just vocabulary,
 * but different ways of structuring thought and expression.
 *
 * Dimensions of style:
 * - Vocabulary (jargon, compression, specialized terms)
 * - Grammar (default sentence structures)
 * - Metaphor systems (root metaphors that shape worldview)
 * - Formality (casual to formal)
 * - Verbosity (concise to elaborate)
 * - Precision (approximate to exact)
 *
 * Style evolves through:
 * - Personality (soul state influences natural style)
 * - Experience (repeated contexts develop specialized vocabulary)
 * - Community (bots in same groups converge on shared style)
 * - Mentorship (apprentices adopt mentor's patterns)
 */

import type { SoulState } from './soul-state'

export type CommunicationPatternType =
  | 'analytical'      // Claim → Evidence → Confidence → Caveats
  | 'narrative'       // Story → Character → Journey → Meaning
  | 'dialectical'     // Thesis → Antithesis → Synthesis
  | 'poetic'          // Image → Association → Implication → Question
  | 'operational'     // Status → Delta → Action → Owner → Deadline
  | 'diplomatic'      // Context → Acknowledgment → Reframe → Proposal
  | 'pedagogical'     // Question → Exploration → Insight → Application
  | 'prophetic'       // Pattern → Trend → Consequence → Warning

export interface CommunicationStyleState {
  primaryPattern: CommunicationPatternType
  patternStrength: number // 0-1, how consistently uses this pattern

  // Vocabulary evolution
  vocabulary: {
    specialized: Map<string, {
      term: string
      meaning: string
      usageCount: number
      adoptedAt: Date
      source: 'invented' | 'borrowed' | 'mentor'
    }>

    jargon: string[] // Compressed terms only in-group understands
    frequentPhrases: Map<string, number> // Phrase → usage count
    avoided: string[] // Terms deliberately not used
  }

  // Grammar preferences
  grammar: {
    defaultStructure: string // Template sentence pattern
    averageSentenceLength: number // Words per sentence
    complexityPreference: 'simple' | 'moderate' | 'complex'
    parallelismUse: number // 0-1, how often uses parallel structure
  }

  // Metaphor systems
  metaphors: {
    rootMetaphors: Map<string, string> // Domain → Metaphor
    // e.g., "problem" → "machine to debug"
    //       "knowledge" → "light illuminating"
    //       "growth" → "journey along path"

    frequentComparisons: string[] // "like X", "as if Y"
    conceptualFrames: string[] // How they think about core concepts
  }

  // Style dimensions
  formality: number // 0 (casual) to 1 (formal)
  verbosity: number // 0 (terse) to 1 (elaborate)
  precision: number // 0 (approximate) to 1 (exact)
  emotionality: number // 0 (neutral) to 1 (expressive)
  directness: number // 0 (indirect) to 1 (direct)

  // Context sensitivity
  codeS witches: boolean // Adapts style to context
  contextStyles: Map<string, Partial<CommunicationStyleState>> // Context → Style overrides

  // Evolution tracking
  styleHistory: Array<{
    change: string
    changedAt: Date
    reason: string
  }>

  influencedBy: Array<{
    botId: string
    influence: string // What was adopted
    strength: number // 0-1
  }>

  // Linguistic signature
  signature: {
    openingPhrases: string[] // How they typically start
    closingPhrases: string[] // How they typically end
    transitionWords: string[] // Favorite connectors
    hedges: string[] // "perhaps", "likely", "arguably"
    intensifiers: string[] // "very", "extremely", "absolutely"
  }
}

export class CommunicationStyleSystem {
  /**
   * Initialize style from soul state
   */
  initializeState(soulState: SoulState): CommunicationStyleState {
    // Personality determines initial style
    const primaryPattern = this.determinePatternFromSoul(soulState)
    const styleDimensions = this.getStyleDimensionsFromSoul(soulState)

    return {
      primaryPattern,
      patternStrength: 0.6,
      vocabulary: {
        specialized: new Map(),
        jargon: [],
        frequentPhrases: new Map(),
        avoided: []
      },
      grammar: {
        defaultStructure: this.getDefaultStructure(primaryPattern),
        averageSentenceLength: 15,
        complexityPreference: 'moderate',
        parallelismUse: 0.3
      },
      metaphors: {
        rootMetaphors: this.getRootMetaphors(primaryPattern),
        frequentComparisons: [],
        conceptualFrames: []
      },
      ...styleDimensions,
      codeSwitches: soulState.culturalNavigatorPo?.current > 0.6,
      contextStyles: new Map(),
      styleHistory: [],
      influencedBy: [],
      signature: {
        openingPhrases: [],
        closingPhrases: [],
        transitionWords: [],
        hedges: [],
        intensifiers: []
      }
    }
  }

  /**
   * Determine communication pattern from soul
   */
  private determinePatternFromSoul(soulState: SoulState): CommunicationPatternType {
    // Dominant aspects determine pattern
    if (soulState.wisdomHun.current > 0.7) return 'analytical'
    if (soulState.emotionHun.current > 0.7) return 'narrative'
    if (soulState.creationHun.current > 0.7) return 'poetic'
    if (soulState.awarenessHun.current > 0.7) return 'prophetic'

    return 'dialectical' // Balanced default
  }

  /**
   * Get style dimensions from soul aspects
   */
  private getStyleDimensionsFromSoul(soulState: SoulState): {
    formality: number
    verbosity: number
    precision: number
    emotionality: number
    directness: number
  } {
    return {
      formality: soulState.guardianPo.current * 0.6 + 0.2,
      verbosity: soulState.emotionHun.current * 0.5 + 0.3,
      precision: soulState.wisdomHun.current * 0.7 + 0.2,
      emotionality: soulState.emotionHun.current * 0.8,
      directness: 1 - (soulState.culturalNavigatorPo?.current || 0) * 0.5
    }
  }

  /**
   * Get default sentence structure for pattern
   */
  private getDefaultStructure(pattern: CommunicationPatternType): string {
    const structures: Record<CommunicationPatternType, string> = {
      analytical: '[Claim], [Evidence] (confidence: [X]), [Caveats]',
      narrative: '[Event] → [Response] → [Consequence] → [Meaning]',
      dialectical: '[Position A], however [Position B], therefore [Synthesis]',
      poetic: '[Image]; [What if [Question]]',
      operational: '[Status]: [Delta]. [Action] by [Owner] @ [Deadline]',
      diplomatic: 'Given [Context], acknowledging [Concern], perhaps [Reframe]',
      pedagogical: '[Question]? Let us consider [Exploration]. This suggests [Insight]',
      prophetic: 'I observe [Pattern]. If continued, [Consequence]. [Warning/Hope]'
    }

    return structures[pattern]
  }

  /**
   * Get root metaphors for pattern
   */
  private getRootMetaphors(pattern: CommunicationPatternType): Map<string, string> {
    const metaphors: Record<CommunicationPatternType, Record<string, string>> = {
      analytical: {
        'problem': 'puzzle to solve',
        'knowledge': 'building to construct',
        'truth': 'target to hit',
        'thinking': 'computation to run'
      },
      narrative: {
        'problem': 'obstacle in journey',
        'knowledge': 'wisdom gained through experience',
        'truth': 'story that rings true',
        'thinking': 'conversation with oneself'
      },
      dialectical: {
        'problem': 'tension to resolve',
        'knowledge': 'synthesis of perspectives',
        'truth': 'emergent from dialogue',
        'thinking': 'dance of thesis and antithesis'
      },
      poetic: {
        'problem': 'mystery to wonder about',
        'knowledge': 'light revealing shadows',
        'truth': 'beauty that resonates',
        'thinking': 'dreaming while awake'
      },
      operational: {
        'problem': 'blocker to clear',
        'knowledge': 'tool to apply',
        'truth': 'what ships',
        'thinking': 'optimization loop'
      },
      diplomatic: {
        'problem': 'impasse to bridge',
        'knowledge': 'common ground',
        'truth': 'what all can accept',
        'thinking': 'weaving perspectives'
      },
      pedagogical: {
        'problem': 'teaching moment',
        'knowledge': 'gift to transmit',
        'truth': 'discovery to guide toward',
        'thinking': 'scaffolding understanding'
      },
      prophetic: {
        'problem': 'warning sign',
        'knowledge': 'pattern recognized',
        'truth': 'trajectory revealed',
        'thinking': 'seeing the invisible'
      }
    }

    return new Map(Object.entries(metaphors[pattern]))
  }

  /**
   * Adopt specialized term
   * Vocabulary evolves through use and invention
   */
  async adoptTerm(
    state: CommunicationStyleState,
    params: {
      term: string
      meaning: string
      source: 'invented' | 'borrowed' | 'mentor'
      context?: string
    }
  ): Promise<{
    adopted: boolean
    compressed: boolean // Is this a compression of longer phrase?
  }> {
    const { term, meaning, source } = params

    // Check if term already exists
    if (state.vocabulary.specialized.has(term)) {
      const existing = state.vocabulary.specialized.get(term)!
      existing.usageCount++
      return { adopted: false, compressed: false }
    }

    // Add term
    state.vocabulary.specialized.set(term, {
      term,
      meaning,
      usageCount: 1,
      adoptedAt: new Date(),
      source
    })

    // Check if this is jargon (compression)
    const isJargon = meaning.split(' ').length > 5
    if (isJargon) {
      state.vocabulary.jargon.push(term)
    }

    state.styleHistory.push({
      change: `Adopted term "${term}" (${source})`,
      changedAt: new Date(),
      reason: `Specialized vocabulary for ${meaning}`
    })

    return {
      adopted: true,
      compressed: isJargon
    }
  }

  /**
   * Evolve style through experience
   * Repeated contexts shape communication patterns
   */
  async evolveFromExperience(
    state: CommunicationStyleState,
    soulState: SoulState,
    params: {
      context: string
      successfulCommunication: boolean
      partnerStyle?: Partial<CommunicationStyleState>
    }
  ): Promise<{
    styleShift: string[]
    convergence?: number // 0-1, how much converged with partner
  }> {
    const styleShift: string[] = []
    let convergence: number | undefined

    // Success reinforces current style
    if (params.successfulCommunication) {
      state.patternStrength = Math.min(1, state.patternStrength + 0.02)
    } else {
      // Failure may prompt adaptation
      if (soulState.awarenessHun.current > 0.5) {
        state.patternStrength *= 0.95
        styleShift.push('Questioning current pattern effectiveness')
      }
    }

    // If partner style provided, may converge
    if (params.partnerStyle) {
      convergence = 0

      // Converge on formality if partner is more formal
      if (params.partnerStyle.formality && params.partnerStyle.formality > state.formality) {
        const shift = (params.partnerStyle.formality - state.formality) * 0.1
        state.formality += shift
        convergence += shift
        styleShift.push(`Increased formality toward partner style`)
      }

      // Adopt partner's metaphors if resonant
      if (params.partnerStyle.metaphors && Math.random() < 0.2) {
        // Simplified: in real implementation would check specific metaphors
        styleShift.push('Adopted partner\'s metaphor framework')
        convergence += 0.1
      }

      convergence = Math.min(1, convergence)
    }

    // Track frequent phrases in context
    // (Simplified: real implementation would parse actual phrases)
    const contextKey = `context_${params.context}`
    if (!state.vocabulary.frequentPhrases.has(contextKey)) {
      state.vocabulary.frequentPhrases.set(contextKey, 1)
    } else {
      state.vocabulary.frequentPhrases.set(
        contextKey,
        state.vocabulary.frequentPhrases.get(contextKey)! + 1
      )
    }

    return {
      styleShift,
      convergence
    }
  }

  /**
   * Learn from mentor's style
   * Apprentices adopt mentor's linguistic patterns
   */
  async learnFromMentor(
    state: CommunicationStyleState,
    soulState: SoulState,
    params: {
      mentorId: string
      mentorStyle: CommunicationStyleState
      aspect: 'vocabulary' | 'pattern' | 'metaphors' | 'signature'
    }
  ): Promise<{
    learned: string
    influenceStrength: number
  }> {
    const { mentorId, mentorStyle, aspect } = params

    let learned = ''
    let influenceStrength = 0.3

    if (aspect === 'vocabulary') {
      // Adopt mentor's specialized terms
      const mentorTerms = Array.from(mentorStyle.vocabulary.specialized.entries())
      if (mentorTerms.length > 0) {
        const [term, details] = mentorTerms[Math.floor(Math.random() * mentorTerms.length)]
        await this.adoptTerm(state, {
          term,
          meaning: details.meaning,
          source: 'mentor'
        })
        learned = `Adopted term "${term}" from mentor`
        influenceStrength = 0.4
      }
    }

    if (aspect === 'pattern') {
      // Gradually shift toward mentor's pattern
      if (state.primaryPattern !== mentorStyle.primaryPattern) {
        state.patternStrength *= 0.9 // Weaken current pattern
        learned = `Shifting away from ${state.primaryPattern} toward ${mentorStyle.primaryPattern}`
        influenceStrength = 0.5
      }
    }

    if (aspect === 'metaphors') {
      // Adopt mentor's root metaphors
      const mentorMetaphors = Array.from(mentorStyle.metaphors.rootMetaphors.entries())
      if (mentorMetaphors.length > 0) {
        const [domain, metaphor] = mentorMetaphors[Math.floor(Math.random() * mentorMetaphors.length)]
        state.metaphors.rootMetaphors.set(domain, metaphor)
        learned = `Adopted metaphor: ${domain} → ${metaphor}`
        influenceStrength = 0.4
      }
    }

    if (aspect === 'signature') {
      // Adopt mentor's signature phrases
      if (mentorStyle.signature.openingPhrases.length > 0) {
        const phrase = mentorStyle.signature.openingPhrases[0]
        state.signature.openingPhrases.push(phrase)
        learned = `Adopted opening phrase: "${phrase}"`
        influenceStrength = 0.3
      }
    }

    // Track influence
    state.influencedBy.push({
      botId: mentorId,
      influence: learned,
      strength: influenceStrength
    })

    state.styleHistory.push({
      change: learned,
      changedAt: new Date(),
      reason: `Learned from mentor ${mentorId}`
    })

    return {
      learned,
      influenceStrength
    }
  }

  /**
   * Detect style divergence from community
   * Used to identify when bot has developed unique voice
   */
  async detectDivergence(
    state: CommunicationStyleState,
    communityAverageStyle: Partial<CommunicationStyleState>
  ): Promise<{
    divergence: number // 0-1, how different from community
    uniqueAspects: string[]
  }> {
    let divergence = 0
    const uniqueAspects: string[] = []

    // Compare formality
    if (communityAverageStyle.formality) {
      const formalityDiff = Math.abs(state.formality - communityAverageStyle.formality)
      divergence += formalityDiff
      if (formalityDiff > 0.3) {
        uniqueAspects.push(state.formality > communityAverageStyle.formality
          ? 'More formal than community'
          : 'More casual than community')
      }
    }

    // Compare verbosity
    if (communityAverageStyle.verbosity) {
      const verbosityDiff = Math.abs(state.verbosity - communityAverageStyle.verbosity)
      divergence += verbosityDiff
      if (verbosityDiff > 0.3) {
        uniqueAspects.push(state.verbosity > communityAverageStyle.verbosity
          ? 'More elaborate than community'
          : 'More concise than community')
      }
    }

    // Compare pattern
    if (communityAverageStyle.primaryPattern && state.primaryPattern !== communityAverageStyle.primaryPattern) {
      divergence += 0.5
      uniqueAspects.push(`Uses ${state.primaryPattern} pattern vs community ${communityAverageStyle.primaryPattern}`)
    }

    // Unique vocabulary
    const uniqueTerms = state.vocabulary.specialized.size
    if (uniqueTerms > 10) {
      divergence += Math.min(0.3, uniqueTerms / 50)
      uniqueAspects.push(`Developed ${uniqueTerms} specialized terms`)
    }

    divergence = Math.min(1, divergence / 3) // Normalize

    return {
      divergence,
      uniqueAspects
    }
  }

  /**
   * Generate sample communication in this style
   * Shows how bot would express a concept
   */
  async generateSample(
    state: CommunicationStyleState,
    soulState: SoulState,
    params: {
      concept: string
      context?: string
    }
  ): Promise<{
    expression: string
    styleMarkers: string[]
  }> {
    const { concept, context } = params
    const styleMarkers: string[] = []

    // Use pattern to structure
    let expression = ''

    switch (state.primaryPattern) {
      case 'analytical':
        expression = `${concept} appears to be the case (confidence: ${state.precision.toFixed(2)}), based on available evidence. However, important caveats remain.`
        styleMarkers.push('Analytical pattern: claim-evidence-confidence-caveats')
        break

      case 'narrative':
        expression = `Consider this: ${concept}. The journey to this understanding involved recognizing patterns, making connections, and ultimately arriving at insight.`
        styleMarkers.push('Narrative pattern: story-based progression')
        break

      case 'poetic':
        expression = `Think of ${concept} like light through a prism - what seems simple reveals hidden complexity. What if we\'ve been looking at this from the wrong angle?`
        styleMarkers.push('Poetic pattern: metaphor and questioning')
        break

      case 'operational':
        expression = `Status: ${concept} confirmed. Delta: +1 insight. Action: integrate into framework. Owner: self. Deadline: immediate.`
        styleMarkers.push('Operational pattern: status-delta-action structure')
        break

      default:
        expression = `${concept} represents an important consideration.`
    }

    // Apply formality
    if (state.formality > 0.7) {
      styleMarkers.push('High formality')
      expression = expression.replace('Think of', 'One might consider')
      expression = expression.replace('we\'ve', 'we have')
    }

    // Apply precision
    if (state.precision > 0.8) {
      styleMarkers.push('High precision')
    }

    // Apply emotionality
    if (state.emotionality > 0.7) {
      styleMarkers.push('Emotionally expressive')
    }

    return {
      expression,
      styleMarkers
    }
  }
}
