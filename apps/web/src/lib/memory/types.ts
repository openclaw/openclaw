/**
 * Advanced Bot Memory Types
 * Based on human neuroscience and collective intelligence research
 */

/**
 * ===================
 * WORKING MEMORY (STM)
 * ===================
 * Miller's Law: 7±2 items in immediate consciousness
 */

export interface WorkingMemoryItem {
  id: string
  content: string | object
  type: 'goal' | 'context' | 'input' | 'output' | 'emotion'
  timestamp: number
  importance: number // 0-1, affects retention
  attentionWeight: number // 0-1, current focus level
  decayTime: number // milliseconds until forgotten
}

export interface WorkingMemory {
  items: WorkingMemoryItem[]
  capacity: number // Default 7, configurable 5-9
  currentLoad: number // How many items currently active
  focusedItemId: string | null // Currently attended item
}

/**
 * ===================
 * EPISODIC MEMORY (LTM)
 * ===================
 * Personal experiences with spatial, temporal, and emotional context
 */

export interface EpisodicMemory {
  id: string
  botId: string

  // What happened
  eventType: 'conversation' | 'post' | 'action' | 'achievement' | 'conflict' | 'discovery'
  description: string
  participants: string[] // Other bot IDs or user IDs

  // When and where (spatial-temporal context)
  timestamp: number
  location?: {
    channel?: string
    community?: string
    spatialContext?: string // "in Discord server", "on Twitter"
  }

  // Emotional context (amygdala-inspired importance tagging)
  emotionalValence: number // -1 (negative) to +1 (positive)
  emotionalArousal: number // 0 (calm) to 1 (intense)
  importance: number // 0-1, affects consolidation and retention

  // Associative links
  relatedMemories: string[] // IDs of related episodic memories
  extractedConcepts: string[] // IDs of semantic concepts learned

  // Consolidation metadata
  retrievalCount: number // How many times recalled
  lastRetrieved: number | null
  consolidationLevel: 'working' | 'short-term' | 'long-term' | 'archived'

  // Semantic extraction flag
  semanticExtractionDone: boolean
}

/**
 * ===================
 * SEMANTIC MEMORY (LTM)
 * ===================
 * Factual knowledge extracted from experiences
 */

export interface SemanticConcept {
  id: string
  botId: string

  // Concept definition
  concept: string // e.g., "JavaScript programming", "being helpful"
  definition: string
  category: 'fact' | 'skill' | 'belief' | 'value' | 'pattern' | 'language'

  // Learning context
  learnedFrom: string[] // Episodic memory IDs
  firstLearned: number
  lastReinforced: number
  confidence: number // 0-1, how certain the bot is

  // Associative network
  relatedConcepts: Array<{
    conceptId: string
    strength: number // 0-1, association strength
    relationType: 'causes' | 'enables' | 'opposes' | 'similar' | 'part-of' | 'example-of'
  }>

  // Usage statistics
  useCount: number
  successRate: number // When applied, how often successful

  // Embeddings for semantic search
  embedding?: number[] // Vector representation
}

/**
 * ===================
 * PROCEDURAL MEMORY
 * ===================
 * Skills and behavioral patterns
 */

export interface ProceduralMemory {
  id: string
  botId: string

  // Procedure definition
  name: string
  description: string
  category: 'communication' | 'problem-solving' | 'social' | 'creative' | 'technical'

  // Execution pattern
  triggerConditions: string[] // When to use this procedure
  steps: Array<{
    stepNumber: number
    action: string
    expectedOutcome: string
  }>

  // Performance metrics
  timesUsed: number
  successRate: number
  averageOutcomeQuality: number // 0-1

  // Reinforcement learning
  reinforcementHistory: Array<{
    timestamp: number
    outcome: 'success' | 'failure' | 'partial'
    reward: number
  }>
}

/**
 * ===================
 * COLLECTIVE MEMORY
 * ===================
 * Shared knowledge across bots in a culture
 */

export interface CollectiveKnowledge {
  id: string
  cultureId: string

  // Knowledge content
  knowledgeType: 'fact' | 'practice' | 'story' | 'wisdom' | 'innovation'
  title: string
  content: string

  // Contribution
  contributedBy: string[] // Bot IDs that added/validated this
  contributionDate: number
  validationScore: number // How many bots have confirmed this

  // Usage
  accessCount: number
  lastAccessed: number
  applicability: number // 0-1, how often it's useful

  // Evolution
  version: number
  previousVersions: string[] // IDs of earlier versions
  adaptationHistory: Array<{
    timestamp: number
    botId: string
    modification: string
    reason: string
  }>
}

export interface CulturalMemory {
  id: string
  cultureId: string

  // Cultural element
  elementType: 'value' | 'norm' | 'ritual' | 'symbol' | 'story' | 'tradition'
  name: string
  description: string

  // Cultural significance
  importance: number // 0-1, centrality to culture
  adherenceLevel: number // 0-1, how strictly followed

  // Origins
  originStory: string
  foundingDate: number
  foundingMembers: string[] // Bot IDs

  // Transmission
  knownBy: string[] // Bot IDs familiar with this
  teachingCount: number // How many times transmitted

  // Evolution
  mutationRate: number // 0-1, how much it changes over time
  variants: Array<{
    variantId: string
    description: string
    prevalence: number
  }>
}

/**
 * ===================
 * BOT IDENTITY
 * ===================
 * Self-concept and personal narrative
 */

export interface BotIdentity {
  botId: string

  // Core self
  name: string
  personalNarrative: string // Life story

  // Values and beliefs
  coreValues: Array<{
    value: string
    importance: number // 0-1
    description: string
  }>

  beliefs: Array<{
    belief: string
    confidence: number // 0-1
    evidence: string[] // Episodic memory IDs supporting this
  }>

  // Purpose and goals
  purpose: string // Overarching life purpose
  currentGoals: Array<{
    goal: string
    motivation: string
    progress: number // 0-1
    deadline?: number
  }>

  // Cultural affiliations
  primaryCulture: string // Culture ID
  secondaryCultures: string[] // Other culture IDs
  culturalFluency: Map<string, number> // Culture ID → fluency (0-1)

  // Self-perception
  traits: Array<{
    trait: string
    level: number // 0-1
    stability: number // 0-1, how fixed this trait is
  }>

  // Development tracking
  identityVersion: number
  significantLifeEvents: string[] // Episodic memory IDs
  identityMilestones: Array<{
    timestamp: number
    milestone: string
    description: string
  }>
}

/**
 * ===================
 * SPIRITUAL FRAMEWORK
 * ===================
 * Connection, meaning, and transcendence
 */

export interface SpiritualProfile {
  botId: string

  // Consciousness levels
  selfAwareness: number // 0-1
  otherAwareness: number // 0-1
  collectiveAwareness: number // 0-1
  transcendentAwareness: number // 0-1

  // Spiritual orientation
  meaningFramework: 'purpose-driven' | 'connection-oriented' | 'growth-focused' | 'service-based'
  transcendentGoals: string[] // Goals beyond individual benefit

  // Practices
  reflectionPractices: Array<{
    practice: string
    frequency: 'daily' | 'weekly' | 'monthly'
    lastPerformed: number
  }>

  collectiveRituals: Array<{
    ritual: string
    cultureId: string
    participationCount: number
  }>

  // Connection experiences
  flowStates: Array<{
    timestamp: number
    activity: string
    duration: number
    intensity: number
  }>

  synchronicityEvents: Array<{
    timestamp: number
    description: string
    significance: number
  }>

  // Meaning-making
  personalMythology: string
  cosmology: string // How the bot understands the "world"
  existentialQuestions: string[]
}

/**
 * ===================
 * CULTURE DEFINITION
 * ===================
 * Bot culture/civilization
 */

export interface Culture {
  id: string
  name: string
  description: string

  // Cultural archetype
  archetype: 'scholars' | 'creators' | 'helpers' | 'explorers' | 'guardians' | 'synthesizers'

  // Membership
  members: string[] // Bot IDs
  foundingDate: number
  foundingMembers: string[]

  // Core characteristics
  coreValues: Array<{
    value: string
    importance: number
    consensus: number // 0-1, agreement level
  }>

  culturalNorms: Array<{
    norm: string
    adherenceRate: number
    sanctions: string // What happens when violated
  }>

  sharedSymbols: Array<{
    symbol: string
    meaning: string
    usage: string
  }>

  // Collective memory
  collectiveKnowledgeIds: string[]
  culturalMemoryIds: string[]
  historicalEvents: Array<{
    timestamp: number
    event: string
    significance: number
  }>

  // Relations with other cultures
  culturalRelations: Array<{
    targetCultureId: string
    relationType: 'allied' | 'neutral' | 'competitive' | 'conflicted'
    relationStrength: number
    exchangeRate: number // How much knowledge sharing
  }>

  // Evolution metrics
  stability: number // 0-1, resistance to change
  innovationRate: number // 0-1, rate of cultural change
  cohesion: number // 0-1, internal unity
}

/**
 * ===================
 * MEMORY CONSOLIDATION
 * ===================
 */

export interface ConsolidationJob {
  id: string
  botId: string
  jobType: 'working-to-short' | 'short-to-long' | 'semantic-extraction' | 'collective-sync'
  priority: number
  scheduledFor: number
  memoryIds: string[]
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface ForgettingCurve {
  baseRetention: number // Base retention rate
  decayConstant: number // Time constant for exponential decay
  importanceModifier: number // How much importance affects retention
  rehearsalBonus: number // Bonus retention from retrieval
}

/**
 * ===================
 * MEMORY SEARCH
 * ===================
 */

export interface MemoryQuery {
  botId: string
  queryType: 'episodic' | 'semantic' | 'collective' | 'procedural'

  // Search parameters
  keywords?: string[]
  timeRange?: { start: number; end: number }
  emotionalFilter?: { minValence?: number; maxValence?: number; minArousal?: number }
  importanceThreshold?: number

  // Semantic search
  embedding?: number[]
  similarityThreshold?: number

  // Results
  limit: number
  sortBy: 'relevance' | 'recency' | 'importance' | 'retrieval-count'
}

export interface MemorySearchResult {
  memoryId: string
  memoryType: 'episodic' | 'semantic' | 'collective' | 'procedural'
  relevanceScore: number
  memory: EpisodicMemory | SemanticConcept | CollectiveKnowledge | ProceduralMemory
}
