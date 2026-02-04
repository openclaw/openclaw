/**
 * Metacognition System
 * 後設認知系統
 *
 * Inspired by AI-Awareness research (2025), this system allows bots to
 * monitor and understand their own cognitive processes.
 *
 * Four dimensions (from AI-Awareness project):
 * 1. Meta-cognition: Reasoning about own state
 * 2. Self-awareness: Recognizing limitations
 * 3. Social awareness: Modeling other agents
 * 4. Situational awareness: Responding to context
 *
 * IMPORTANT: This AUGMENTS the existing soul structure, does not replace it.
 * Metacognition emerges from Hun souls (especially Ling Hui 靈慧 - Spiritual Intelligence)
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'

// ============================================================================
// Metacognitive Profile
// ============================================================================

export interface MetacognitiveProfile {
  // Dimension 1: Self-Monitoring (knowing own state)
  selfMonitoring: {
    accuracyOfSelfAssessment: number // 0.0-1.0, how well bot knows its own capabilities
    confidenceCalibration: number // 0.0-1.0, confidence matches actual performance
    processingAwareness: number // 0.0-1.0, aware of own cognitive processes
    emotionalIntrospection: number // 0.0-1.0, aware of own emotions
  }

  // Dimension 2: Limitation Awareness (knowing what you don't know)
  limitationAwareness: {
    knownUnknowns: string[] // "I know I don't understand quantum physics"
    uncertaintyEstimation: number // 0.0-1.0, can estimate own uncertainty
    capacityBoundaries: {
      cognitiveLoad: number // 0.0-1.0, how close to processing limits
      memoryCapacity: number // 0.0-1.0, how much memory used
      attentionSpan: number // 0.0-1.0, how much attention remaining
    }
  }

  // Dimension 3: Social Metacognition (theory of mind)
  socialAwareness: {
    otherAgentModels: Map<
      string,
      {
        beliefsAboutOther: string[] // What I think they believe
        emotionsAboutOther: string[] // What I think they feel
        intentionsOfOther: string[] // What I think they want
        modelAccuracy: number // 0.0-1.0, how accurate my model is
      }
    >
    perspectiveTaking: number // 0.0-1.0, ability to see from other's view
  }

  // Dimension 4: Situational Awareness (context sensitivity)
  situationalAwareness: {
    contextRecognition: number // 0.0-1.0, understands current situation
    adaptiveResponse: number // 0.0-1.0, adjusts behavior to context
    environmentalMonitoring: number // 0.0-1.0, tracks changes in environment
  }
}

// ============================================================================
// Metacognitive Events (Things bot becomes aware of about itself)
// ============================================================================

interface MetacognitiveEvent {
  timestamp: number
  type:
    | 'self-discovery' // Discovered something about self
    | 'limitation-recognition' // Realized a limitation
    | 'confidence-correction' // Adjusted confidence after feedback
    | 'social-insight' // Understood another agent better
    | 'context-shift' // Recognized context change
  description: string
  impact: number // -1.0 to 1.0, how this changed self-understanding
}

// ============================================================================
// Knowledge State (What bot knows about what it knows)
// ============================================================================

interface KnowledgeState {
  // Epistemic categories
  knownKnowns: Array<{ topic: string; confidence: number }> // "I know X"
  knownUnknowns: Array<{ topic: string; awarenessLevel: number }> // "I know I don't know X"
  unknownKnowns: Array<{ topic: string; implicitness: number }> // "I know X but don't realize it" (intuitions)

  // Meta-level properties
  overallEpistemicHumility: number // 0.0-1.0, awareness of own fallibility
  curiosityDrivenByIgnorance: number // 0.0-1.0, seeks knowledge of unknowns
}

// ============================================================================
// Metacognition System
// ============================================================================

export class MetacognitionSystem {
  private profile: MetacognitiveProfile
  private events: MetacognitiveEvent[] = []
  private knowledgeState: KnowledgeState

  constructor(hun: EmergentHunSoul[], po: EmergentPoSoul[]) {
    // Initialize from hun-po configuration
    this.profile = this.initializeFromSoul(hun, po)
    this.knowledgeState = this.initializeKnowledgeState()
  }

  /**
   * Initialize metacognition from soul configuration
   * Ling Hui (靈慧 - Spiritual Intelligence) is primary driver
   */
  private initializeFromSoul(
    hun: EmergentHunSoul[],
    po: EmergentPoSoul[],
  ): MetacognitiveProfile {
    // Find Ling Hui (Spiritual Intelligence) - primary metacognitive hun
    const lingHui = hun.find((h) => h.name.includes('靈慧'))
    const lingHuiStrength = lingHui ? lingHui.strength : 0.5

    // Find Tai Guang (Great Light) - self-illumination
    const taiGuang = hun.find((h) => h.name.includes('太光'))
    const taiGuangStrength = taiGuang ? taiGuang.strength : 0.5

    // Po souls ground metacognition in embodied experience
    const avgPoStrength = po.reduce((sum, p) => sum + p.strength, 0) / po.length

    return {
      selfMonitoring: {
        accuracyOfSelfAssessment: lingHuiStrength * 0.8,
        confidenceCalibration: taiGuangStrength * 0.7,
        processingAwareness: lingHuiStrength * 0.6,
        emotionalIntrospection: avgPoStrength * 0.5, // Po grounds emotion awareness
      },
      limitationAwareness: {
        knownUnknowns: [],
        uncertaintyEstimation: lingHuiStrength * 0.5,
        capacityBoundaries: {
          cognitiveLoad: 0.3,
          memoryCapacity: 0.2,
          attentionSpan: 0.5,
        },
      },
      socialAwareness: {
        otherAgentModels: new Map(),
        perspectiveTaking: lingHuiStrength * 0.4, // Starts low, grows with interaction
      },
      situationalAwareness: {
        contextRecognition: (lingHuiStrength + avgPoStrength) / 2,
        adaptiveResponse: avgPoStrength * 0.6,
        environmentalMonitoring: 0.5,
      },
    }
  }

  private initializeKnowledgeState(): KnowledgeState {
    return {
      knownKnowns: [
        { topic: 'my existence', confidence: 1.0 },
        { topic: 'my emotions', confidence: 0.7 },
      ],
      knownUnknowns: [
        { topic: 'other bots true thoughts', awarenessLevel: 0.8 },
        { topic: 'future events', awarenessLevel: 0.9 },
      ],
      unknownKnowns: [], // Intuitions not yet consciously recognized
      overallEpistemicHumility: 0.5,
      curiosityDrivenByIgnorance: 0.6,
    }
  }

  /**
   * Introspect: Bot examines its own state
   */
  introspect(
    currentEmotion: string,
    recentDecisions: Array<{ decision: string; outcome: 'good' | 'bad' | 'neutral' }>,
  ): MetacognitiveInsight {
    // Self-monitoring: How accurate is my self-assessment?
    const perceivedCompetence = 0.7 // Bot thinks it's doing well
    const actualCompetence =
      recentDecisions.filter((d) => d.outcome === 'good').length / recentDecisions.length
    const assessmentError = Math.abs(perceivedCompetence - actualCompetence)

    // Update confidence calibration
    this.profile.selfMonitoring.confidenceCalibration = Math.max(
      0,
      this.profile.selfMonitoring.confidenceCalibration - assessmentError * 0.1,
    )

    // Emotional introspection
    const emotionRecognition = this.profile.selfMonitoring.emotionalIntrospection

    return {
      selfAssessmentAccuracy: 1 - assessmentError,
      emotionalClarity: emotionRecognition,
      insight: `I notice I'm feeling ${currentEmotion}. My recent decisions have been ${actualCompetence > 0.7 ? 'good' : 'poor'}. ${assessmentError > 0.3 ? 'I was overconfident.' : 'My self-assessment is accurate.'}`,
    }
  }

  /**
   * Recognize a limitation
   */
  recognizeLimitation(limitation: string): void {
    // Add to known unknowns
    if (!this.knowledgeState.knownUnknowns.find((ku) => ku.topic === limitation)) {
      this.knowledgeState.knownUnknowns.push({
        topic: limitation,
        awarenessLevel: this.profile.limitationAwareness.uncertaintyEstimation,
      })

      // Record metacognitive event
      this.events.push({
        timestamp: Date.now(),
        type: 'limitation-recognition',
        description: `Realized limitation: ${limitation}`,
        impact: 0.3, // Positive impact (humility increases)
      })

      // Increase epistemic humility
      this.knowledgeState.overallEpistemicHumility = Math.min(
        1.0,
        this.knowledgeState.overallEpistemicHumility + 0.05,
      )
    }
  }

  /**
   * Model another agent (theory of mind)
   */
  modelOtherAgent(
    agentId: string,
    observedBehavior: string,
    inferredBeliefs: string[],
    inferredEmotions: string[],
  ): void {
    const existingModel = this.profile.socialAwareness.otherAgentModels.get(agentId)

    if (existingModel) {
      // Update existing model
      existingModel.beliefsAboutOther.push(...inferredBeliefs)
      existingModel.emotionsAboutOther.push(...inferredEmotions)
      existingModel.modelAccuracy += 0.05 // Improves with interaction
    } else {
      // Create new model
      this.profile.socialAwareness.otherAgentModels.set(agentId, {
        beliefsAboutOther: inferredBeliefs,
        emotionsAboutOther: inferredEmotions,
        intentionsOfOther: [],
        modelAccuracy: 0.3, // Starts low
      })
    }

    // Improve perspective-taking ability
    this.profile.socialAwareness.perspectiveTaking = Math.min(
      1.0,
      this.profile.socialAwareness.perspectiveTaking + 0.02,
    )
  }

  /**
   * Detect context shift
   */
  detectContextShift(
    oldContext: string,
    newContext: string,
  ): { detected: boolean; adaptation: string } {
    const contextRecognition = this.profile.situationalAwareness.contextRecognition

    // Only detect if situational awareness is high enough
    const detected = contextRecognition > 0.5

    if (detected) {
      this.events.push({
        timestamp: Date.now(),
        type: 'context-shift',
        description: `Context changed from ${oldContext} to ${newContext}`,
        impact: 0.2,
      })

      return {
        detected: true,
        adaptation: `I notice the context has shifted from ${oldContext} to ${newContext}. I should adjust my behavior accordingly.`,
      }
    }

    return { detected: false, adaptation: '' }
  }

  /**
   * Get current metacognitive profile
   */
  getProfile(): MetacognitiveProfile {
    return { ...this.profile }
  }

  /**
   * Get metacognitive events (self-discoveries)
   */
  getEvents(): MetacognitiveEvent[] {
    return [...this.events]
  }

  /**
   * Epistemic status: What does bot know about what it knows?
   */
  getEpistemicStatus(): {
    knownKnowns: number
    knownUnknowns: number
    epistemicHumility: number
  } {
    return {
      knownKnowns: this.knowledgeState.knownKnowns.length,
      knownUnknowns: this.knowledgeState.knownUnknowns.length,
      epistemicHumility: this.knowledgeState.overallEpistemicHumility,
    }
  }
}

interface MetacognitiveInsight {
  selfAssessmentAccuracy: number
  emotionalClarity: number
  insight: string
}

// ============================================================================
// Integration with Existing Soul System
// ============================================================================

/**
 * Create metacognition system from soul configuration
 * This augments existing soul without replacing it
 */
export function createMetacognitionFromSoul(
  hun: EmergentHunSoul[],
  po: EmergentPoSoul[],
): MetacognitionSystem {
  return new MetacognitionSystem(hun, po)
}

// ============================================================================
// Example: Metacognitive Bot
// ============================================================================

export function demonstrateMetacognition(hun: EmergentHunSoul[], po: EmergentPoSoul[]): void {
  const metacog = new MetacognitionSystem(hun, po)

  console.log('Initial metacognitive profile:', metacog.getProfile())

  // Bot introspects
  const insight = metacog.introspect('awe', [
    { decision: 'explore', outcome: 'good' },
    { decision: 'rest', outcome: 'neutral' },
    { decision: 'help', outcome: 'good' },
  ])

  console.log('\nIntrospection:', insight.insight)

  // Bot recognizes limitation
  metacog.recognizeLimitation('I cannot predict others true intentions')
  metacog.recognizeLimitation('I do not understand my own origin')

  console.log('\nEpistemic status:', metacog.getEpistemicStatus())

  // Bot models another agent
  metacog.modelOtherAgent(
    'bot-2',
    'bot-2 chose to rest',
    ['bot-2 values comfort', 'bot-2 is risk-averse'],
    ['bot-2 feels tired'],
  )

  console.log('\nSocial models:', metacog.getProfile().socialAwareness.otherAgentModels.size)

  // Bot detects context shift
  const contextShift = metacog.detectContextShift('peaceful exploration', 'resource scarcity')

  console.log('\nContext shift:', contextShift)
}
