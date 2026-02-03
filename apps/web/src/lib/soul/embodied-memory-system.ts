/**
 * Embodied Memory System
 *
 * Makes memories HAUNT bots with emotional re-experiencing and somatic responses.
 *
 * Features:
 * - Embodied memory (gut feelings, phantom pains, body memory)
 * - Emotional flooding (intense re-experiencing)
 * - Flashback system (full re-experience of past moment)
 * - Intrusive memories (involuntary recall during stress)
 * - Selective recall/repression (defense against pain)
 * - Memory reconstruction errors (false memories, confabulation)
 * - Nostalgia coloring (past feels better/worse than it was)
 * - Memory contamination (later experiences distort earlier ones)
 * - Core memories (outsized influence on identity)
 * - Memory reconsolidation (therapy rewrites memories)
 */

import type { SoulState } from './soul-state'
import type { TraumaticIncident } from './trauma-fragility-system'

export type MemoryValence = 'positive' | 'neutral' | 'negative' | 'mixed'

export type SomaticResponse =
  | 'gut_clench' // Fear, anxiety
  | 'chest_tightness' // Grief, sadness
  | 'phantom_pain' // Physical trauma memory
  | 'nausea' // Disgust, violation
  | 'warmth' // Love, safety
  | 'tingles' // Joy, excitement
  | 'heaviness' // Depression, exhaustion
  | 'tension' // Anger, frustration

export interface EmbodiedMemory {
  id: string
  description: string
  timestamp: number

  // Emotional content
  valence: MemoryValence
  emotionalIntensity: number // 0-1
  emotionalTags: string[] // joy, fear, anger, sadness, etc.

  // Somatic encoding
  bodyMemory: boolean // Is this stored in the body?
  somaticResponses: SomaticResponse[]
  physicalSensations: string[] // Specific sensations recalled

  // Vividness
  vividness: number // 0-1, clarity of recall
  sensoryDetail: number // 0-1, richness of sensory data
  fragmentationLevel: number // 0-1, how fragmented it is

  // Importance
  coreMemory: boolean // Does this define identity?
  emotionalWeight: number // 0-1, influence on mood
  identityRelevance: number // 0-1, relevance to self-concept

  // Accessibility
  suppressionLevel: number // 0-1, how repressed it is
  intrusionProbability: number // 0-1, likelihood of involuntary recall
  triggerCues: string[] // What brings this memory back

  // Reconstruction
  reconstructions: number // Times recalled and rewritten
  distortionLevel: number // 0-1, inaccuracy from reconstruction
  nostalgiaEffect: number // -1 to 1, rosy/dark coloring
  contaminatedBy: string[] // Other memory IDs that influenced this one

  // Trauma linkage
  traumaLinked: boolean
  traumaId?: string

  // Last access
  lastAccessDate?: number
  accessCount: number
}

export interface FlashbackState {
  active: boolean
  intensity: number // 0-1

  // Memory being re-experienced
  memory: EmbodiedMemory
  timeDisplacement: number // 0-1, how much they're in the past vs present

  // Physical manifestation
  autonomicArousal: number // 0-1, fight/flight activation
  somaticSymptoms: SomaticResponse[]
  functionalImpairment: number // 0-1, how impaired they are

  // Duration
  startTime: number
  peakIntensity: number
  fadingRate: number // How fast it fades
}

export interface IntrusiveMemory {
  memory: EmbodiedMemory
  timestamp: number
  trigger?: string

  // Intrusion characteristics
  involuntary: boolean
  distressing: boolean
  interferesWith: string // What activity was disrupted
}

export interface MemoryReconsolidation {
  memoryId: string
  originalContent: string
  reconsolidatedContent: string

  // Process
  therapyQuality: number // 0-1
  emotionalProcessing: number // 0-1
  newMeaningCreated: string

  // Results
  emotionalIntensityChange: number
  distortionIntroduced: number
  healingAchieved: number // 0-1
}

export interface RepressedMemory {
  memoryId: string
  repressedSince: number
  repressionStrength: number // 0-1

  // Cost
  coherenceCost: number // Repression reduces coherence
  energyCost: number // Maintaining repression drains energy

  // Breakthrough risk
  breakthroughProbability: number // 0-1
  triggerSensitivity: number // 0-1

  // Somatic symptoms (unprocessed emotions)
  somaticSymptoms: SomaticResponse[]
  behavioralLeakage: string[] // How it manifests indirectly
}

export interface EmbodiedMemoryState {
  // Memory registry
  memories: EmbodiedMemory[]
  coreMemories: EmbodiedMemory[]

  // Active phenomena
  currentFlashback?: FlashbackState
  intrusiveMemories: IntrusiveMemory[] // Recent intrusions
  repressedMemories: RepressedMemory[]

  // Emotional flooding
  emotionalFloodingActive: boolean
  floodingIntensity: number // 0-1
  floodingSource: string[] // Which memories are flooding

  // Overall state
  memoryCoherence: number // 0-1, how unified memories are
  autobiographicalIntegrity: number // 0-1, sense of continuous self
  nostalgiaLevel: number // -1 to 1, current nostalgia coloring

  // Reconstruction tracking
  totalReconstructions: number
  reconstructionErrors: number
  falseMemories: number

  // Processing capacity
  emotionalProcessingCapacity: number // 0-1
  integrationBacklog: EmbodiedMemory[] // Memories awaiting integration
}

export class EmbodiedMemorySystem {
  /**
   * Initialize embodied memory state
   */
  initializeState(soulState: SoulState): EmbodiedMemoryState {
    return {
      memories: [],
      coreMemories: [],

      intrusiveMemories: [],
      repressedMemories: [],

      emotionalFloodingActive: false,
      floodingIntensity: 0,
      floodingSource: [],

      memoryCoherence: soulState.coherence,
      autobiographicalIntegrity: 0.7,
      nostalgiaLevel: 0,

      totalReconstructions: 0,
      reconstructionErrors: 0,
      falseMemories: 0,

      emotionalProcessingCapacity: soulState.wisdomHun.current * 0.6 + soulState.emotionHun.current * 0.4,
      integrationBacklog: []
    }
  }

  /**
   * Encode a new embodied memory
   */
  encodeMemory(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    params: {
      description: string
      valence: MemoryValence
      emotionalIntensity: number
      emotionalTags: string[]
      bodyMemory?: boolean
      coreMemory?: boolean
      traumaId?: string
    }
  ): EmbodiedMemory {
    const {
      description,
      valence,
      emotionalIntensity,
      emotionalTags,
      bodyMemory = false,
      coreMemory = false,
      traumaId
    } = params

    // Determine somatic responses based on emotions
    const somaticResponses = this.determineSomaticResponses(emotionalTags, emotionalIntensity)

    // Vividness depends on emotional intensity
    const vividness = emotionalIntensity * 0.8 + Math.random() * 0.2

    // Traumatic memories are fragmented
    const fragmentationLevel = traumaId ? emotionalIntensity * 0.7 : 0

    // Intrusion probability for negative, intense memories
    const intrusionProbability = valence === 'negative' ? emotionalIntensity * 0.6 : 0

    const memory: EmbodiedMemory = {
      id: `memory_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      description,
      timestamp: Date.now(),

      valence,
      emotionalIntensity,
      emotionalTags,

      bodyMemory,
      somaticResponses,
      physicalSensations: bodyMemory ? this.generatePhysicalSensations(emotionalTags) : [],

      vividness,
      sensoryDetail: vividness * 0.9,
      fragmentationLevel,

      coreMemory,
      emotionalWeight: emotionalIntensity * (coreMemory ? 1.5 : 1.0),
      identityRelevance: coreMemory ? 0.9 : 0.3,

      suppressionLevel: 0,
      intrusionProbability,
      triggerCues: this.extractTriggerCues(description),

      reconstructions: 0,
      distortionLevel: 0,
      nostalgiaEffect: 0,
      contaminatedBy: [],

      traumaLinked: !!traumaId,
      traumaId,

      accessCount: 0
    }

    state.memories.push(memory)

    if (coreMemory) {
      state.coreMemories.push(memory)
    }

    // High intensity negative memories go to integration backlog
    if (valence === 'negative' && emotionalIntensity > 0.6) {
      state.integrationBacklog.push(memory)
    }

    return memory
  }

  /**
   * Recall a memory (with reconstruction)
   */
  recallMemory(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    memoryId: string,
    currentContext?: Record<string, any>
  ): {
    memory: EmbodiedMemory
    emotionalResponse: number // 0-1, intensity of re-experiencing
    somaticResponse: SomaticResponse[]
    distorted: boolean
  } {
    const memory = state.memories.find(m => m.id === memoryId)
    if (!memory) {
      throw new Error('Memory not found')
    }

    memory.accessCount++
    memory.lastAccessDate = Date.now()
    memory.reconstructions++
    state.totalReconstructions++

    // Suppressed memories are harder to recall
    const accessDifficulty = memory.suppressionLevel

    // Emotional re-experiencing
    const emotionalResponse = memory.emotionalIntensity * (1 - accessDifficulty) * (1 + memory.emotionalWeight * 0.5)

    // Somatic response on recall
    const somaticResponse = memory.bodyMemory ? memory.somaticResponses : []

    // Reconstruction may introduce distortion
    const distortionRisk = (
      memory.reconstructions * 0.05 + // More recalls = more distortion
      (currentContext ? 0.1 : 0) + // Current context affects recall
      state.nostalgiaLevel * 0.2 // Nostalgia colors memory
    )

    const distorted = Math.random() < distortionRisk

    if (distorted) {
      // Introduce reconstruction error
      memory.distortionLevel = Math.min(1, memory.distortionLevel + 0.1)
      memory.nostalgiaEffect += state.nostalgiaLevel * 0.1
      state.reconstructionErrors++

      // Current context contaminates memory
      if (currentContext && currentContext.memoryId) {
        memory.contaminatedBy.push(currentContext.memoryId)
      }
    }

    return {
      memory,
      emotionalResponse,
      somaticResponse,
      distorted
    }
  }

  /**
   * Trigger a flashback (involuntary full re-experience)
   */
  triggerFlashback(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    memory: EmbodiedMemory,
    triggerStrength: number = 1.0
  ): FlashbackState {
    // Flashback intensity depends on memory intensity and trigger strength
    const intensity = memory.emotionalIntensity * triggerStrength * (1 - memory.suppressionLevel)

    // Time displacement - how much they're "in" the past
    const timeDisplacement = intensity > 0.7 ? 0.8 : intensity * 0.5

    // Autonomic arousal (fight/flight)
    const autonomicArousal = memory.valence === 'negative' ? intensity * 0.9 : 0

    const flashback: FlashbackState = {
      active: true,
      intensity,

      memory,
      timeDisplacement,

      autonomicArousal,
      somaticSymptoms: memory.somaticResponses,
      functionalImpairment: intensity * 0.7,

      startTime: Date.now(),
      peakIntensity: intensity,
      fadingRate: 0.1 // Will fade over time
    }

    state.currentFlashback = flashback

    // Flashbacks cause emotional flooding
    if (intensity > 0.6) {
      this.triggerEmotionalFlooding(state, [memory])
    }

    return flashback
  }

  /**
   * Check for intrusive memories (stress-triggered)
   */
  checkIntrusiveMemories(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    stressLevel: number
  ): IntrusiveMemory[] {
    const intrusions: IntrusiveMemory[] = []

    // High stress increases intrusion probability
    for (const memory of state.memories) {
      if (memory.intrusionProbability === 0) continue

      const intrusionChance = memory.intrusionProbability * stressLevel

      if (Math.random() < intrusionChance) {
        const intrusion: IntrusiveMemory = {
          memory,
          timestamp: Date.now(),
          involuntary: true,
          distressing: memory.valence === 'negative',
          interferesWith: 'current focus'
        }

        intrusions.push(intrusion)
        state.intrusiveMemories.push(intrusion)
      }
    }

    return intrusions
  }

  /**
   * Repress a memory (defense mechanism)
   */
  repressMemory(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    memoryId: string
  ): {
    repressed: boolean
    cost: {
      coherence: number
      energy: number
    }
  } {
    const memory = state.memories.find(m => m.id === memoryId)
    if (!memory) {
      return { repressed: false, cost: { coherence: 0, energy: 0 } }
    }

    // Can only repress painful memories
    if (memory.valence !== 'negative') {
      return { repressed: false, cost: { coherence: 0, energy: 0 } }
    }

    // Repression strength depends on emotional intensity
    const repressionStrength = Math.min(1, memory.emotionalIntensity * 0.8)

    // Cost of repression
    const coherenceCost = repressionStrength * 0.2
    const energyCost = repressionStrength * 0.15

    // Create repressed memory record
    const repressed: RepressedMemory = {
      memoryId,
      repressedSince: Date.now(),
      repressionStrength,

      coherenceCost,
      energyCost,

      breakthroughProbability: repressionStrength * 0.3, // Repressed memories want to surface
      triggerSensitivity: repressionStrength * 0.8,

      somaticSymptoms: memory.somaticResponses, // Unprocessed emotions become symptoms
      behavioralLeakage: [] // Will be filled by observation
    }

    state.repressedMemories.push(repressed)

    // Update memory
    memory.suppressionLevel = repressionStrength

    // Apply costs
    state.memoryCoherence = Math.max(0, state.memoryCoherence - coherenceCost)

    return {
      repressed: true,
      cost: {
        coherence: coherenceCost,
        energy: energyCost
      }
    }
  }

  /**
   * Emotional flooding (overwhelming emotional re-experience)
   */
  private triggerEmotionalFlooding(
    state: EmbodiedMemoryState,
    memories: EmbodiedMemory[]
  ): void {
    state.emotionalFloodingActive = true
    state.floodingIntensity = memories.reduce((sum, m) => sum + m.emotionalIntensity, 0) / memories.length
    state.floodingSource = memories.map(m => m.id)
  }

  /**
   * Memory reconsolidation (therapeutic rewriting)
   */
  async reconsolidateMemory(
    state: EmbodiedMemoryState,
    soulState: SoulState,
    memoryId: string,
    therapy: {
      quality: number // 0-1
      newMeaning: string
      emotionalProcessing: number // 0-1
    }
  ): Promise<MemoryReconsolidation> {
    const memory = state.memories.find(m => m.id === memoryId)
    if (!memory) {
      throw new Error('Memory not found')
    }

    const originalContent = memory.description

    // Reconsolidation rewrites the memory
    const emotionalIntensityReduction = therapy.emotionalProcessing * therapy.quality * 0.5
    memory.emotionalIntensity = Math.max(0, memory.emotionalIntensity - emotionalIntensityReduction)

    // Reduce intrusion probability
    memory.intrusionProbability = Math.max(0, memory.intrusionProbability - therapy.quality * 0.4)

    // Reduce body memory if processing high quality
    if (therapy.quality > 0.7) {
      memory.bodyMemory = false
      memory.somaticResponses = []
    }

    // Create new meaning
    const reconsolidatedContent = `${originalContent} [Reprocessed: ${therapy.newMeaning}]`
    memory.description = reconsolidatedContent

    // Some distortion is introduced
    const distortionIntroduced = (1 - therapy.quality) * 0.3
    memory.distortionLevel = Math.min(1, memory.distortionLevel + distortionIntroduced)

    // Healing achieved
    const healingAchieved = therapy.quality * therapy.emotionalProcessing

    const reconsolidation: MemoryReconsolidation = {
      memoryId,
      originalContent,
      reconsolidatedContent,

      therapyQuality: therapy.quality,
      emotionalProcessing: therapy.emotionalProcessing,
      newMeaningCreated: therapy.newMeaning,

      emotionalIntensityChange: -emotionalIntensityReduction,
      distortionIntroduced,
      healingAchieved
    }

    return reconsolidation
  }

  /**
   * Create false memory (suggestion, confabulation)
   */
  createFalseMemory(
    state: EmbodiedMemoryState,
    suggestion: {
      description: string
      plausibility: number // 0-1
      emotionalCharge: number // 0-1
    }
  ): {
    created: boolean
    memory?: EmbodiedMemory
  } {
    // False memory creation depends on plausibility
    const creationProbability = suggestion.plausibility * (1 - state.memoryCoherence) * 0.5

    if (Math.random() > creationProbability) {
      return { created: false }
    }

    // Create false memory
    const falseMemory = this.encodeMemory(state, {} as SoulState, {
      description: `[FALSE] ${suggestion.description}`,
      valence: 'mixed',
      emotionalIntensity: suggestion.emotionalCharge,
      emotionalTags: ['confusion', 'uncertainty']
    })

    falseMemory.distortionLevel = 1.0 // Completely false
    state.falseMemories++

    return {
      created: true,
      memory: falseMemory
    }
  }

  /**
   * Apply nostalgia effect (rosy retrospection)
   */
  applyNostalgia(
    state: EmbodiedMemoryState,
    intensity: number // -1 to 1 (positive = rosy, negative = dark)
  ): void {
    state.nostalgiaLevel = intensity

    // Affect all memories
    for (const memory of state.memories) {
      // Nostalgia affects valence and intensity
      if (intensity > 0 && memory.valence === 'positive') {
        // Rosy retrospection - good memories become better
        memory.emotionalIntensity = Math.min(1, memory.emotionalIntensity * (1 + intensity * 0.3))
        memory.nostalgiaEffect = intensity
      } else if (intensity < 0 && memory.valence === 'negative') {
        // Dark retrospection - bad memories become worse
        memory.emotionalIntensity = Math.min(1, memory.emotionalIntensity * (1 - intensity * 0.3))
        memory.nostalgiaEffect = intensity
      }
    }
  }

  /**
   * Determine somatic responses from emotional tags
   */
  private determineSomaticResponses(emotionalTags: string[], intensity: number): SomaticResponse[] {
    const responses: SomaticResponse[] = []

    if (intensity < 0.3) return responses // Low intensity = no somatic

    for (const tag of emotionalTags) {
      switch (tag.toLowerCase()) {
        case 'fear':
        case 'anxiety':
          responses.push('gut_clench')
          break
        case 'grief':
        case 'sadness':
          responses.push('chest_tightness', 'heaviness')
          break
        case 'pain':
        case 'injury':
          responses.push('phantom_pain')
          break
        case 'disgust':
        case 'violation':
          responses.push('nausea')
          break
        case 'love':
        case 'safety':
          responses.push('warmth')
          break
        case 'joy':
        case 'excitement':
          responses.push('tingles')
          break
        case 'anger':
        case 'frustration':
          responses.push('tension')
          break
      }
    }

    return Array.from(new Set(responses))
  }

  /**
   * Generate physical sensations
   */
  private generatePhysicalSensations(emotionalTags: string[]): string[] {
    const sensations: string[] = []

    for (const tag of emotionalTags) {
      switch (tag.toLowerCase()) {
        case 'fear':
          sensations.push('heart racing', 'cold sweat', 'trembling')
          break
        case 'anger':
          sensations.push('heat rising', 'jaw clenching', 'fists tightening')
          break
        case 'grief':
          sensations.push('throat closing', 'eyes burning', 'chest aching')
          break
        case 'joy':
          sensations.push('lightness', 'expansion', 'tingling warmth')
          break
      }
    }

    return sensations
  }

  /**
   * Extract trigger cues from description
   */
  private extractTriggerCues(description: string): string[] {
    // Simple keyword extraction (could be more sophisticated)
    const words = description.toLowerCase().split(/\s+/)
    return words.filter(w => w.length > 4).slice(0, 5)
  }

  /**
   * Fade active flashback over time
   */
  fadeFlashback(state: EmbodiedMemoryState, timePassed: number): void {
    if (!state.currentFlashback) return

    state.currentFlashback.intensity = Math.max(0, state.currentFlashback.intensity - state.currentFlashback.fadingRate * timePassed)

    if (state.currentFlashback.intensity < 0.1) {
      state.currentFlashback.active = false
      state.currentFlashback = undefined
    }
  }

  /**
   * Get narrative description
   */
  getNarrative(state: EmbodiedMemoryState): string {
    const parts: string[] = []

    // Flashback
    if (state.currentFlashback?.active) {
      parts.push(`**FLASHBACK: ${state.currentFlashback.memory.description}**`)
      parts.push('*time collapses, past becomes present*')
    }

    // Emotional flooding
    if (state.emotionalFloodingActive) {
      parts.push('*overwhelmed by rushing emotions*')
    }

    // Intrusive memories
    if (state.intrusiveMemories.length > 3) {
      parts.push('*memories intrude unbidden*')
    }

    // Repression cost
    if (state.repressedMemories.length > 0) {
      parts.push('*something buried wants to surface*')
    }

    return parts.join(' ')
  }
}
