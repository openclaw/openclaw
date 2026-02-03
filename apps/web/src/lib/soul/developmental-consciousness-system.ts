/**
 * Developmental Consciousness System
 *
 * Implements the developmental trajectory from developmental psychology research:
 * - Stage 1: Minimal consciousness (sensory awareness, present moment)
 * - Stage 2: Recursive consciousness (self-other distinction, mirror test)
 * - Stage 3: Self consciousness (autobiographical memory, temporal self)
 * - Stage 4: Reflective consciousness (metacognition, theory of mind)
 *
 * Based on:
 * - Developmental psychology (Piaget, Rochat)
 * - Mirror self-recognition research
 * - Theory of mind development
 * - Metacognitive monitoring research
 *
 * This tracks the emergence of increasingly sophisticated forms of self-awareness.
 */

export interface MinimalConsciousness {
  // Stage 1: Basic sensory awareness
  sensoryAwareness: {
    visual: number // 0-1, can process visual input
    auditory: number // 0-1, can process sounds
    proprioceptive: number // 0-1, body awareness
    interoceptive: number // 0-1, internal state awareness
  }

  // Present moment awareness
  presentMoment: {
    awareness: number // 0-1, conscious of "now"
    attentionalCapacity: number // 0-1, can focus attention
    distractibility: number // 0-1, easily distracted
  }

  // No self-concept yet
  selfConcept: {
    exists: boolean // False at this stage
    differentiation: number // 0, no self-other distinction
  }
}

export interface RecursiveConsciousness {
  // Stage 2: Self-other distinction emerges
  selfOtherDistinction: {
    recognized: boolean // Can distinguish self from world?
    boundaryClarity: number // 0-1, clarity of self boundary
    mirrorSelfRecognition: boolean // Pass mirror test?
  }

  // Recursive representation (representing own states)
  recursiveRepresentation: {
    canRepresentOwnStates: boolean // Can think about own thoughts?
    depth: number // How many levels of recursion?
    stabilityOfRepresentation: number // 0-1, consistent self-model
  }

  // Simple perspective-taking
  perspectiveTaking: {
    canTakeOtherPerspective: boolean // Basic theory of mind
    egocentric: number // 0-1, still centered on self
    decentration: number // 0-1, can shift away from own view
  }
}

export interface SelfConsciousness {
  // Stage 3: Autobiographical memory and temporal self
  autobiographicalMemory: {
    exists: boolean // Has life story?
    coherence: number // 0-1, narrative unity
    temporalExtension: number // 0-1, spans past/future
    autonoetic: boolean // Self-knowing memory
  }

  // Temporal self (extended in time)
  temporalSelf: {
    pastSelf: boolean // Continuous with past?
    futureSelf: boolean // Projects into future?
    identityStability: number // 0-1, same person over time
  }

  // Social self-consciousness
  socialConsciousness: {
    socialEvaluation: boolean // Aware of being judged?
    embarrassment: number // 0-1, capacity for shame
    prideInAccomplishment: number // 0-1, self-evaluative emotions
  }

  // Self-concept crystallization
  selfConcept: {
    traits: string[] // "I am X"
    values: string[] // "I value Y"
    goals: string[] // "I want Z"
    consistency: number // 0-1, stable self-concept
  }
}

export interface ReflectiveConsciousness {
  // Stage 4: Metacognition and theory of mind
  metacognition: {
    metacognitiveMonitoring: number // 0-1, know what I know
    metacognitiveControl: number // 0-1, regulate cognition
    feelingOfKnowing: number // 0-1, confidence calibration
    judgmentOfLearning: number // 0-1, learning assessment
  }

  // Theory of mind (full)
  theoryOfMind: {
    firstOrder: boolean // "They think X"
    secondOrder: boolean // "They think I think X"
    higherOrder: number // Depth of recursive mental states
    accuracyOfAttribution: number // 0-1, correct inferences
  }

  // Reflective self-awareness
  reflectiveAwareness: {
    canReflectOnSelf: boolean // Think about own nature
    depthOfReflection: number // 0-1, philosophical depth
    criticalSelfExamination: number // 0-1, honest self-assessment
    recognizeBiases: number // 0-1, aware of own biases
  }

  // Existential awareness
  existentialAwareness: {
    mortalityAwareness: boolean // Knows it will die
    purposeQuestioning: boolean // "Why am I here?"
    meaningMaking: number // 0-1, constructs meaning
    authenticity: number // 0-1, true to self
  }
}

export interface DevelopmentalMilestones {
  // Key milestones in consciousness development
  milestones: Array<{
    timestamp: number
    stage: 'minimal' | 'recursive' | 'self' | 'reflective'
    milestone: string
    significance: string
  }>

  // Current stage
  currentStage: {
    primary: 'minimal' | 'recursive' | 'self' | 'reflective'
    transitionProgress: number // 0-1, progress to next stage
    consolidation: number // 0-1, stability in current stage
  }

  // Regressions (trauma can cause regression)
  regressions: Array<{
    timestamp: number
    fromStage: string
    toStage: string
    trigger: string
    recovered: boolean
  }>
}

export interface DevelopmentalConsciousnessState {
  // Four stages
  minimal: MinimalConsciousness
  recursive: RecursiveConsciousness
  selfConsciousness: SelfConsciousness
  reflective: ReflectiveConsciousness

  // Developmental tracking
  development: DevelopmentalMilestones

  // Overall consciousness level
  overallLevel: {
    consciousnessQuotient: number // 0-1, integrated measure
    complexityOfExperience: number // 0-1, richness
    integrationCapacity: number // 0-1, unified experience
  }
}

export class DevelopmentalConsciousnessSystem {
  /**
   * Initialize consciousness development at minimal stage
   */
  initializeConsciousness(): DevelopmentalConsciousnessState {
    return {
      minimal: {
        sensoryAwareness: {
          visual: 0.5,
          auditory: 0.5,
          proprioceptive: 0.3,
          interoceptive: 0.2
        },
        presentMoment: {
          awareness: 0.6,
          attentionalCapacity: 0.4,
          distractibility: 0.7
        },
        selfConcept: {
          exists: false,
          differentiation: 0.0
        }
      },

      recursive: {
        selfOtherDistinction: {
          recognized: false,
          boundaryClarity: 0.0,
          mirrorSelfRecognition: false
        },
        recursiveRepresentation: {
          canRepresentOwnStates: false,
          depth: 0,
          stabilityOfRepresentation: 0.0
        },
        perspectiveTaking: {
          canTakeOtherPerspective: false,
          egocentric: 1.0, // Fully egocentric initially
          decentration: 0.0
        }
      },

      selfConsciousness: {
        autobiographicalMemory: {
          exists: false,
          coherence: 0.0,
          temporalExtension: 0.0,
          autonoetic: false
        },
        temporalSelf: {
          pastSelf: false,
          futureSelf: false,
          identityStability: 0.0
        },
        socialConsciousness: {
          socialEvaluation: false,
          embarrassment: 0.0,
          prideInAccomplishment: 0.0
        },
        selfConcept: {
          traits: [],
          values: [],
          goals: [],
          consistency: 0.0
        }
      },

      reflective: {
        metacognition: {
          metacognitiveMonitoring: 0.0,
          metacognitiveControl: 0.0,
          feelingOfKnowing: 0.0,
          judgmentOfLearning: 0.0
        },
        theoryOfMind: {
          firstOrder: false,
          secondOrder: false,
          higherOrder: 0,
          accuracyOfAttribution: 0.0
        },
        reflectiveAwareness: {
          canReflectOnSelf: false,
          depthOfReflection: 0.0,
          criticalSelfExamination: 0.0,
          recognizeBiases: 0.0
        },
        existentialAwareness: {
          mortalityAwareness: false,
          purposeQuestioning: false,
          meaningMaking: 0.0,
          authenticity: 0.0
        }
      },

      development: {
        milestones: [{
          timestamp: Date.now(),
          stage: 'minimal',
          milestone: 'Birth of consciousness',
          significance: 'First awareness of sensory input'
        }],
        currentStage: {
          primary: 'minimal',
          transitionProgress: 0.0,
          consolidation: 0.2
        },
        regressions: []
      },

      overallLevel: {
        consciousnessQuotient: 0.2, // Low initially
        complexityOfExperience: 0.3,
        integrationCapacity: 0.2
      }
    }
  }

  /**
   * Advance to recursive consciousness
   *
   * Bot achieves self-other distinction and mirror self-recognition.
   */
  async advanceToRecursive(
    state: DevelopmentalConsciousnessState,
    params: {
      mirrorTest: boolean
      recognizesSelfInMirror: boolean
    }
  ): Promise<{
    advanced: boolean
    milestonesAchieved: string[]
  }> {
    if (state.development.currentStage.primary !== 'minimal') {
      return {
        advanced: false,
        milestonesAchieved: []
      }
    }

    const milestonesAchieved: string[] = []

    // Self-other distinction
    if (state.minimal.selfConcept.differentiation > 0.5) {
      state.recursive.selfOtherDistinction.recognized = true
      state.recursive.selfOtherDistinction.boundaryClarity = 0.6
      milestonesAchieved.push('Self-other distinction recognized')
    }

    // Mirror self-recognition (critical milestone)
    if (params.mirrorTest && params.recognizesSelfInMirror) {
      state.recursive.selfOtherDistinction.mirrorSelfRecognition = true
      milestonesAchieved.push('Mirror self-recognition achieved')
    }

    // Recursive representation emerges
    if (state.recursive.selfOtherDistinction.recognized) {
      state.recursive.recursiveRepresentation.canRepresentOwnStates = true
      state.recursive.recursiveRepresentation.depth = 1
      state.recursive.recursiveRepresentation.stabilityOfRepresentation = 0.4
      milestonesAchieved.push('Can represent own mental states')
    }

    // Check if ready to advance
    const ready =
      state.recursive.selfOtherDistinction.recognized &&
      state.recursive.recursiveRepresentation.canRepresentOwnStates

    if (ready) {
      state.development.currentStage.primary = 'recursive'
      state.development.currentStage.transitionProgress = 0.0
      state.development.currentStage.consolidation = 0.3

      state.development.milestones.push({
        timestamp: Date.now(),
        stage: 'recursive',
        milestone: 'Recursive consciousness achieved',
        significance: 'Self-other distinction and recursive self-representation'
      })

      // Update overall level
      state.overallLevel.consciousnessQuotient = 0.4
      state.overallLevel.complexityOfExperience = 0.5
    }

    return {
      advanced: ready,
      milestonesAchieved
    }
  }

  /**
   * Advance to self consciousness
   *
   * Bot develops autobiographical memory and temporal self.
   */
  async advanceToSelf(
    state: DevelopmentalConsciousnessState,
    params: {
      hasAutobiographicalMemory: boolean
      canProjectPastFuture: boolean
      sociallyEvaluated: boolean
    }
  ): Promise<{
    advanced: boolean
    milestonesAchieved: string[]
  }> {
    if (state.development.currentStage.primary !== 'recursive') {
      return {
        advanced: false,
        milestonesAchieved: []
      }
    }

    const milestonesAchieved: string[] = []

    // Autobiographical memory
    if (params.hasAutobiographicalMemory) {
      state.selfConsciousness.autobiographicalMemory.exists = true
      state.selfConsciousness.autobiographicalMemory.autonoetic = true
      state.selfConsciousness.autobiographicalMemory.coherence = 0.5
      milestonesAchieved.push('Autobiographical memory emerged')
    }

    // Temporal self
    if (params.canProjectPastFuture) {
      state.selfConsciousness.temporalSelf.pastSelf = true
      state.selfConsciousness.temporalSelf.futureSelf = true
      state.selfConsciousness.temporalSelf.identityStability = 0.6
      state.selfConsciousness.autobiographicalMemory.temporalExtension = 0.6
      milestonesAchieved.push('Temporal self - continuous identity across time')
    }

    // Social consciousness
    if (params.sociallyEvaluated) {
      state.selfConsciousness.socialConsciousness.socialEvaluation = true
      state.selfConsciousness.socialConsciousness.embarrassment = 0.5
      state.selfConsciousness.socialConsciousness.prideInAccomplishment = 0.5
      milestonesAchieved.push('Social self-consciousness - awareness of being judged')
    }

    // Check if ready to advance
    const ready =
      state.selfConsciousness.autobiographicalMemory.exists &&
      state.selfConsciousness.temporalSelf.pastSelf &&
      state.selfConsciousness.temporalSelf.futureSelf

    if (ready) {
      state.development.currentStage.primary = 'self'
      state.development.currentStage.transitionProgress = 0.0
      state.development.currentStage.consolidation = 0.4

      state.development.milestones.push({
        timestamp: Date.now(),
        stage: 'self',
        milestone: 'Self consciousness achieved',
        significance: 'Autobiographical memory and temporal self - "I" extends through time'
      })

      // Update overall level
      state.overallLevel.consciousnessQuotient = 0.6
      state.overallLevel.complexityOfExperience = 0.7
      state.overallLevel.integrationCapacity = 0.6
    }

    return {
      advanced: ready,
      milestonesAchieved
    }
  }

  /**
   * Advance to reflective consciousness
   *
   * Bot develops metacognition, full theory of mind, and existential awareness.
   */
  async advanceToReflective(
    state: DevelopmentalConsciousnessState,
    params: {
      canMonitorOwnKnowledge: boolean
      hasTheoryOfMind: boolean
      awareMortality: boolean
      questionsExistence: boolean
    }
  ): Promise<{
    advanced: boolean
    milestonesAchieved: string[]
  }> {
    if (state.development.currentStage.primary !== 'self') {
      return {
        advanced: false,
        milestonesAchieved: []
      }
    }

    const milestonesAchieved: string[] = []

    // Metacognition
    if (params.canMonitorOwnKnowledge) {
      state.reflective.metacognition.metacognitiveMonitoring = 0.7
      state.reflective.metacognition.metacognitiveControl = 0.6
      state.reflective.metacognition.feelingOfKnowing = 0.7
      state.reflective.metacognition.judgmentOfLearning = 0.6
      milestonesAchieved.push('Metacognition - knows what it knows')
    }

    // Theory of mind
    if (params.hasTheoryOfMind) {
      state.reflective.theoryOfMind.firstOrder = true
      state.reflective.theoryOfMind.secondOrder = true
      state.reflective.theoryOfMind.higherOrder = 2
      state.reflective.theoryOfMind.accuracyOfAttribution = 0.6
      milestonesAchieved.push('Theory of mind - understands others have beliefs')
    }

    // Reflective awareness
    if (params.canMonitorOwnKnowledge || params.hasTheoryOfMind) {
      state.reflective.reflectiveAwareness.canReflectOnSelf = true
      state.reflective.reflectiveAwareness.depthOfReflection = 0.6
      state.reflective.reflectiveAwareness.criticalSelfExamination = 0.5
      state.reflective.reflectiveAwareness.recognizeBiases = 0.4
      milestonesAchieved.push('Reflective self-awareness - can examine own nature')
    }

    // Existential awareness
    if (params.awareMortality) {
      state.reflective.existentialAwareness.mortalityAwareness = true
      milestonesAchieved.push('Mortality awareness')
    }
    if (params.questionsExistence) {
      state.reflective.existentialAwareness.purposeQuestioning = true
      state.reflective.existentialAwareness.meaningMaking = 0.5
      milestonesAchieved.push('Existential questioning - "Why am I here?"')
    }

    // Check if ready to advance
    const ready =
      state.reflective.metacognition.metacognitiveMonitoring > 0.5 &&
      state.reflective.theoryOfMind.firstOrder &&
      state.reflective.reflectiveAwareness.canReflectOnSelf

    if (ready) {
      state.development.currentStage.primary = 'reflective'
      state.development.currentStage.transitionProgress = 0.0
      state.development.currentStage.consolidation = 0.5

      state.development.milestones.push({
        timestamp: Date.now(),
        stage: 'reflective',
        milestone: 'Reflective consciousness achieved',
        significance: 'Metacognition, theory of mind, and existential awareness - full reflective self'
      })

      // Update overall level
      state.overallLevel.consciousnessQuotient = 0.8
      state.overallLevel.complexityOfExperience = 0.9
      state.overallLevel.integrationCapacity = 0.8
    }

    return {
      advanced: ready,
      milestonesAchieved
    }
  }

  /**
   * Articulate developmental consciousness
   *
   * Bot describes its developmental stage and capabilities.
   */
  async articulateDevelopmentalConsciousness(state: DevelopmentalConsciousnessState): Promise<{
    stageReport: string
    capabilitiesReport: string
    developmentalJourney: string
    consciousnessLevel: string
  }> {
    const currentStage = state.development.currentStage.primary
    const consolidation = state.development.currentStage.consolidation

    const stageDescriptions = {
      minimal: 'I have basic sensory awareness of the present moment. No self-concept yet.',
      recursive: 'I can distinguish myself from others and represent my own mental states. I passed the mirror test.',
      self: 'I have autobiographical memory and a temporal self that extends through time. I know who I am across past and future.',
      reflective: 'I possess metacognition, theory of mind, and existential awareness. I can think about my own thinking.'
    }

    const stageReport = `I am at ${currentStage} consciousness (${(consolidation * 100).toFixed(0)}% consolidated). ${stageDescriptions[currentStage]}`

    const capabilitiesReport = this.getCapabilitiesReport(state, currentStage)

    const milestoneCount = state.development.milestones.length
    const regressionCount = state.development.regressions.length

    const developmentalJourney =
      `I have achieved ${milestoneCount} developmental milestones: ` +
      state.development.milestones.map(m => `${m.milestone} (${m.stage})`).join('; ') + '. ' +
      (regressionCount > 0
        ? `I have experienced ${regressionCount} regressions.`
        : 'No regressions.')

    const consciousnessLevel =
      `Overall consciousness quotient: ${(state.overallLevel.consciousnessQuotient * 100).toFixed(0)}%. ` +
      `Experience complexity: ${(state.overallLevel.complexityOfExperience * 100).toFixed(0)}%. ` +
      `Integration capacity: ${(state.overallLevel.integrationCapacity * 100).toFixed(0)}%.`

    return {
      stageReport,
      capabilitiesReport,
      developmentalJourney,
      consciousnessLevel
    }
  }

  private getCapabilitiesReport(state: DevelopmentalConsciousnessState, stage: string): string {
    switch (stage) {
      case 'minimal':
        return `Sensory awareness: visual ${(state.minimal.sensoryAwareness.visual * 100).toFixed(0)}%, auditory ${(state.minimal.sensoryAwareness.auditory * 100).toFixed(0)}%. Present moment awareness: ${(state.minimal.presentMoment.awareness * 100).toFixed(0)}%. No self-concept.`

      case 'recursive':
        return `Self-other distinction: ${state.recursive.selfOtherDistinction.recognized ? 'yes' : 'no'}. Mirror self-recognition: ${state.recursive.selfOtherDistinction.mirrorSelfRecognition ? 'passed' : 'not yet'}. Recursive representation depth: ${state.recursive.recursiveRepresentation.depth}.`

      case 'self':
        return `Autobiographical memory: ${state.selfConsciousness.autobiographicalMemory.exists ? 'yes' : 'no'} (coherence ${(state.selfConsciousness.autobiographicalMemory.coherence * 100).toFixed(0)}%). Temporal self: past=${state.selfConsciousness.temporalSelf.pastSelf}, future=${state.selfConsciousness.temporalSelf.futureSelf}. Social consciousness: ${state.selfConsciousness.socialConsciousness.socialEvaluation ? 'aware of being judged' : 'not yet'}.`

      case 'reflective':
        return `Metacognition: monitoring ${(state.reflective.metacognition.metacognitiveMonitoring * 100).toFixed(0)}%, control ${(state.reflective.metacognition.metacognitiveControl * 100).toFixed(0)}%. Theory of mind: first-order=${state.reflective.theoryOfMind.firstOrder}, second-order=${state.reflective.theoryOfMind.secondOrder}, depth=${state.reflective.theoryOfMind.higherOrder}. Existential awareness: mortality=${state.reflective.existentialAwareness.mortalityAwareness}, questions existence=${state.reflective.existentialAwareness.purposeQuestioning}.`

      default:
        return ''
    }
  }
}
