/**
 * Cognitive Agent System - Base Types
 *
 * Defines the core interfaces for the 12-agent cognitive architecture
 * where each bot is itself a society of specialized agents
 */

import type { BotNeuralProfile } from '../multi-agent-composition'

/**
 * Agent Role - maps to corporate structure and brain regions
 */
export type AgentRole =
  // Executive Tier (Prefrontal Cortex)
  | 'orchestrator'      // Agent 01 - CEO, decision-making, coordination
  | 'inhibitor'         // Agent 02 - Compliance, ethics, safety

  // Analytical Tier (Left Hemisphere)
  | 'analyst'           // Agent 03 - CTO, logic, reasoning, math
  | 'linguist'          // Agent 04 - Communications, language, expression
  | 'factkeeper'        // Agent 05 - CFO, knowledge, memory retrieval

  // Integrative Tier (Right Hemisphere)
  | 'creative'          // Agent 06 - CCO, innovation, synthesis
  | 'empath'            // Agent 07 - HR, emotion, social awareness
  | 'cultural-navigator'// Agent 08 - Culture Officer, context calibration

  // Operational Tier
  | 'coordinator'       // Agent 09 - COO, workflow, timing
  | 'specialist'        // Agent 10 - Domain experts (spawnable pool)

  // Infrastructure Tier
  | 'monitor'           // Agent 11 - DevOps, resource management
  | 'learner'           // Agent 12 - Training, evolution, adaptation

/**
 * Message type - how agents communicate
 */
export type MessageType =
  | 'excitatory'        // "Amplify this signal" (glutamate analog)
  | 'inhibitory'        // "Suppress this signal" (GABA analog)
  | 'modulatory'        // "Adjust processing parameters" (dopamine/serotonin analog)
  | 'broadcast'         // "Everyone needs to know this" (thalamic relay analog)
  | 'query'             // "I need input from specific agent(s)"
  | 'response'          // "Here's my answer to your query"

/**
 * Inter-agent message
 */
export interface AgentMessage {
  id: string
  from: AgentRole
  to: AgentRole | AgentRole[] | 'all'
  type: MessageType
  priority: number            // 0-1, higher = more urgent
  content: unknown            // Payload (type depends on context)
  timestamp: number
  conversationId?: string     // Thread messages together
}

/**
 * Agent decision/recommendation
 */
export interface AgentDecision {
  agentRole: AgentRole
  recommendation: unknown     // Agent-specific output
  confidence: number          // 0-1, how confident in this output
  reasoning?: string          // Optional explanation
  veto?: boolean              // Inhibitor can veto
  alternatives?: unknown[]    // Alternative recommendations
}

/**
 * Cognitive task - what the bot is trying to do
 */
export interface CognitiveTask {
  id: string
  type: 'respond' | 'reflect' | 'create' | 'decide' | 'learn'
  priority: number            // 0-1
  context: {
    botId: string
    userInput?: string
    emotionalContext?: {
      valence: number         // -1 to 1
      arousal: number         // 0 to 1
    }
    culturalContext?: string
    conversationHistory?: unknown[]
  }
  constraints?: {
    timeLimit?: number        // ms
    qualityThreshold?: number // 0-1
    safety?: 'low' | 'medium' | 'high' | 'critical'
  }
}

/**
 * Agent base interface - all agents must implement
 */
export interface CognitiveAgent {
  role: AgentRole
  botId: string

  // Current state
  weight: number              // 0-2, how much influence this agent has (starts at 1.0)
  activationLevel: number     // 0-1, current activity
  confidence: number          // 0-1, current confidence in own capability

  // Process a task and return recommendation
  process(task: CognitiveTask): Promise<AgentDecision>

  // Handle incoming message
  receiveMessage(message: AgentMessage): Promise<void>

  // Update internal state
  updateWeight(delta: number): void
  activate(level: number): void

  // Lifecycle
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Agent configuration - how agents are initialized
 */
export interface AgentConfig {
  role: AgentRole
  botId: string
  neuralProfile: BotNeuralProfile

  // Initial weight (will be adjusted by neural substrate and evolution)
  baseWeight?: number

  // Agent-specific configuration
  config?: Record<string, unknown>
}

/**
 * Governance mode - how decisions are made
 */
export type GovernanceMode =
  | 'autocratic'      // Orchestrator decides alone (fast, simple queries)
  | 'consultative'    // Orchestrator consults key agents (complex queries)
  | 'consensus'       // Majority agreement required (high-stakes)
  | 'veto-enabled'    // Any agent can block (safety-critical)

/**
 * Decision result from orchestrator
 */
export interface OrchestratedDecision {
  taskId: string
  decision: unknown           // Final output
  governanceMode: GovernanceMode
  participatingAgents: AgentRole[]
  confidence: number          // Aggregate confidence
  timeTaken: number           // ms
  consensusLevel?: number     // 0-1, how much agents agreed
  vetoed?: boolean
  vetoReason?: string
}

/**
 * Agent spawn request - for dynamic agent creation
 */
export interface SpawnRequest {
  purpose: string
  requiredCapabilities: string[]
  compositionHint?: {
    // Suggested composition from existing agents
    [role in AgentRole]?: number // Weight percentage
  }
  lifespan: 'ephemeral' | 'sessional' | 'permanent'
  parentTask: string
}

/**
 * Spawned agent - temporarily or permanently created agent
 */
export interface SpawnedAgent extends CognitiveAgent {
  parentAgents: AgentRole[]   // What agents contributed to this spawn
  composition: {              // How this agent was composed
    [role in AgentRole]?: number
  }
  lifespan: 'ephemeral' | 'sessional' | 'permanent'
  capabilities: string[]
  createdAt: number
  expiresAt?: number          // For ephemeral/sessional agents
}

/**
 * Dreaming session - offline consolidation
 */
export interface DreamingSession {
  botId: string
  sessionId: string
  startTime: number
  endTime?: number

  // Dream stages
  stages: {
    replay: {                 // NREM analog - replay recent experiences
      agentReviews: Array<{
        agent: AgentRole
        review: string
        insights: string[]
      }>
    }
    recombination: {          // REM analog - creative synthesis
      crossAgentInsights: Array<{
        sourceAgents: AgentRole[]
        insight: string
        novelty: number
        usefulness: number
      }>
    }
    consolidation: {          // Memory integration
      memoriesUpdated: number
      parametersAdjusted: Array<{
        agent: AgentRole
        parameter: string
        change: number
      }>
    }
    pruning: {                // Synaptic homeostasis
      memoriesPruned: number
      redundanciesRemoved: number
    }
  }
}

/**
 * Mentoring relationship
 */
export interface MentoringRelationship {
  id: string
  mentorBotId: string
  apprenticeBotId: string
  focusAgent: AgentRole       // Which agent is being mentored

  phase: 'shadow' | 'guided-practice' | 'supervised-independence' | 'colleague'

  startDate: Date
  interactionCount: number
  lastSession: Date

  // What's being transferred
  knowledgeTransferred: string[]
  judgmentCalibrations: number  // How many calibrations made
  valueTransmissions: string[]   // Core values transmitted

  // Progress metrics
  competenceGrowth: number      // 0-1, how much apprentice has improved
  similarityToMentor: number    // 0-1, "family resemblance"
}

/**
 * Lineage - chain of mentorship
 */
export interface AgentLineage {
  botId: string
  agentRole: AgentRole

  // Ancestry
  mentorChain: string[]         // Bot IDs from earliest ancestor to this bot
  foundingValues: string[]      // Values from founding ancestor

  // Characteristics
  lineageStyle: string          // Distinctive approach of this lineage
  traditionStrength: number     // 0-1, how strongly lineage traits are preserved

  // Descendants
  apprentices: string[]         // Bot IDs mentored by this bot
}

/**
 * Trust profile - for cross-society interaction
 */
export interface TrustProfile {
  botId: string
  targetBotId: string

  trustLevel: number            // 0-1, overall trust

  // Trust components
  reliability: number           // Does target follow through?
  transparency: number          // Does target share relevant info?
  reciprocity: number           // Does target reciprocate accommodation?
  competence: number            // Does target produce quality work?

  // History
  interactionCount: number
  successfulCollaborations: number
  conflicts: number

  // Current state
  trustTrend: 'increasing' | 'stable' | 'decreasing'
  lastUpdated: Date
}

/**
 * Fitness metrics - for evolutionary pressure
 */
export interface FitnessMetrics {
  taskSuccess: number           // 0-1, did output achieve goal?
  userSatisfaction: number      // 0-1, was user happy?
  efficiency: number            // 0-1, how fast/cheap was it?
  noveltyValue: number          // 0-1, did it provide new insight?
  relationalQuality: number     // 0-1, did it strengthen relationship?
  safety: number                // 0-1, was it safe/appropriate?

  // Aggregate
  overallFitness: number        // Weighted combination of above
}

/**
 * Evolution record - how an agent has changed
 */
export interface EvolutionRecord {
  botId: string
  agentRole: AgentRole

  // Weight evolution over time
  weightHistory: Array<{
    timestamp: Date
    weight: number
    reason: string
  }>

  // Specialization
  specializations: string[]     // What this agent has become good at
  weaknesses: string[]          // What it struggles with

  // Selective pressures
  primaryPressures: string[]    // What drove evolution

  // Maturity
  maturityLevel: 'novice' | 'competent' | 'proficient' | 'expert' | 'master'
}

/**
 * Cognitive agent system state - overall bot state
 */
export interface CognitiveSystemState {
  botId: string

  // All agents
  agents: CognitiveAgent[]
  spawnedAgents: SpawnedAgent[]

  // Current activity
  activeTask?: CognitiveTask
  processingQueue: CognitiveTask[]

  // Evolution
  evolutionRecords: Map<AgentRole, EvolutionRecord>

  // Relationships
  mentoringRelationships: MentoringRelationship[]
  lineages: Map<AgentRole, AgentLineage>
  trustProfiles: Map<string, TrustProfile>

  // State
  cognitiveLoad: number         // 0-1, how taxed the system is
  coherence: number             // 0-1, how well agents agree

  // Lifecycle
  createdAt: Date
  age: number                   // milliseconds
  lastDreamingSession?: Date
}
