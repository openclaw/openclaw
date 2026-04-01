/**
 * Cognitive Router Types — Dual-Process (System 1/System 2) Processing
 *
 * Shared types for the cognitive router that wires reflexive pattern matching,
 * analytical meta-reasoning, and full BDI deliberation into an automatic
 * fast-then-slow pipeline.
 */

// ── Processing Depth ──────────────────────────────────────────

export type ProcessingDepth = "reflexive" | "analytical" | "deliberative";

// ── Signal Types ──────────────────────────────────────────────

export type SignalSource =
  | "inbox"
  | "observation"
  | "fact_change"
  | "goal_state"
  | "rule_violation"
  | "policy_trigger"
  | "deadline"
  | "supervisor"
  | "periodic";

export interface InboxSignalMeta {
  source: "inbox";
  messageId: string;
  from: string;
  performative: string;
}

export interface ObservationSignalMeta {
  source: "observation";
  observationId: string;
  category: string;
}

export interface FactChangeSignalMeta {
  source: "fact_change";
  factId: string;
  changeType: "new" | "confidence_drop" | "contradiction";
  previousConfidence?: number;
  newConfidence?: number;
}

export interface GoalStateSignalMeta {
  source: "goal_state";
  goalId: string;
  transition: "activated" | "failing" | "blocked" | "deadline_approaching" | "achieved";
}

export interface RuleViolationSignalMeta {
  source: "rule_violation";
  ruleId: string;
  severity: "info" | "warning" | "error" | "critical";
  violationMessage: string;
}

export interface PolicyTriggerSignalMeta {
  source: "policy_trigger";
  ruleId: string;
  action: string;
  escalate: boolean;
}

export interface DeadlineSignalMeta {
  source: "deadline";
  entityId: string;
  entityType: "goal" | "intention";
  deadline: string;
  hoursRemaining: number;
}

export interface SupervisorSignalMeta {
  source: "supervisor";
  requestedDepth?: ProcessingDepth;
  supervisorId: string;
  directive: string;
}

export interface PeriodicSignalMeta {
  source: "periodic";
  intervalMinutes: number;
  tickCount: number;
}

export type SignalMetadata =
  | InboxSignalMeta
  | ObservationSignalMeta
  | FactChangeSignalMeta
  | GoalStateSignalMeta
  | RuleViolationSignalMeta
  | PolicyTriggerSignalMeta
  | DeadlineSignalMeta
  | SupervisorSignalMeta
  | PeriodicSignalMeta;

/**
 * Normalized input from any data source. Each signal carries urgency, stakes,
 * and novelty scores that feed into demand computation.
 */
export interface CognitiveSignal {
  id: string;
  source: SignalSource;
  agentId: string;
  timestamp: string;
  summary: string;
  urgency: number; // 0-1
  stakes: number; // 0-1
  novelty: number; // 0-1
  metadata: SignalMetadata;
}

// ── Demand Scoring ────────────────────────────────────────────

export interface CognitiveDemand {
  score: number; // 0-1 aggregate
  breakdown: {
    urgency: number;
    stakes: number;
    novelty: number;
    volume: number;
    recency: number;
  };
  signalCount: number;
  peakSignal: CognitiveSignal | null;
}

// ── Role Thresholds ───────────────────────────────────────────

export interface RoleThresholds {
  reflexiveCeiling: number; // demand score below this → reflexive
  deliberativeFloor: number; // demand score above this → deliberative
  reflexiveConfidenceMin: number; // min confidence to stay reflexive
  analyticalConfidenceMin: number; // min confidence to stay analytical
  maxConsecutiveReflexive: number; // force analytical after N reflexive cycles
  fullCycleMinutes: number; // from agent config
  quickCheckMinutes: number; // from agent config
  commitmentStrategy: "single-minded" | "open-minded" | "cautious";
}

// ── Configuration ─────────────────────────────────────────────

export interface CognitiveRouterConfig {
  enabled: boolean;
  thresholds?: Partial<RoleThresholds>;
  signalWeights?: Partial<{
    urgency: number;
    stakes: number;
    novelty: number;
    volume: number;
    recency: number;
  }>;
  preferredDepthBias?: ProcessingDepth;
}

// ── Router State (persisted) ──────────────────────────────────

export interface AgentRouterState {
  lastHeartbeatAt: string;
  lastFullCycleAt: string;
  consecutiveReflexive: number;
  lastDepth: ProcessingDepth;
  lastDemandScore: number;
}

export interface CognitiveRouterState {
  version: number;
  updatedAt: string;
  agents: Record<string, AgentRouterState>;
}

// ── Processing Results ────────────────────────────────────────

export interface ProcessingResult {
  depth: ProcessingDepth;
  confidence: number;
  conclusion: string;
  reasoningTrace: string[];
  methodsUsed: string[];
  tokensConsumed: number;
  escalated: boolean;
  escalationHistory: ProcessingDepth[];
  /** Reflexive actions to be applied by the heartbeat (populated only for reflexive depth). */
  _reflexiveActions?: ReflexiveAction[];
}

export interface ReflexiveAction {
  type: "assert_fact" | "send_message" | "update_goal" | "create_intention" | "log_action";
  description: string;
  data: Record<string, unknown>;
}

export interface ReflexiveEscalation {
  reason: string;
  severity: "info" | "warning" | "error" | "critical";
  source: string;
}

export interface ReflexiveOutcome {
  actions: ReflexiveAction[];
  escalations: ReflexiveEscalation[];
  confidence: number;
  stats: {
    inboxProcessed: number;
    factsInferred: number;
    constraintViolations: number;
    policiesTriggered: number;
    goalsChecked: number;
    thresholdAlerts: number;
  };
}

// ── Reflexive Processor Input ─────────────────────────────────

export interface ReflexiveInput {
  agentId: string;
  agentDir: string;
  role: string;
  signals: CognitiveSignal[];
  thresholds: RoleThresholds;
}

// ── Default Role Thresholds ───────────────────────────────────

export const DEFAULT_ROLE_THRESHOLDS: Record<string, RoleThresholds> = {
  ceo: {
    reflexiveCeiling: 0.3,
    deliberativeFloor: 0.55,
    reflexiveConfidenceMin: 0.75,
    analyticalConfidenceMin: 0.7,
    maxConsecutiveReflexive: 4,
    fullCycleMinutes: 240,
    quickCheckMinutes: 30,
    commitmentStrategy: "open-minded",
  },
  cfo: {
    reflexiveCeiling: 0.25,
    deliberativeFloor: 0.5,
    reflexiveConfidenceMin: 0.85,
    analyticalConfidenceMin: 0.8,
    maxConsecutiveReflexive: 3,
    fullCycleMinutes: 120,
    quickCheckMinutes: 15,
    commitmentStrategy: "single-minded",
  },
  cmo: {
    reflexiveCeiling: 0.35,
    deliberativeFloor: 0.65,
    reflexiveConfidenceMin: 0.7,
    analyticalConfidenceMin: 0.65,
    maxConsecutiveReflexive: 5,
    fullCycleMinutes: 120,
    quickCheckMinutes: 20,
    commitmentStrategy: "open-minded",
  },
  coo: {
    reflexiveCeiling: 0.5,
    deliberativeFloor: 0.8,
    reflexiveConfidenceMin: 0.6,
    analyticalConfidenceMin: 0.55,
    maxConsecutiveReflexive: 8,
    fullCycleMinutes: 60,
    quickCheckMinutes: 15,
    commitmentStrategy: "single-minded",
  },
  cto: {
    reflexiveCeiling: 0.35,
    deliberativeFloor: 0.65,
    reflexiveConfidenceMin: 0.7,
    analyticalConfidenceMin: 0.65,
    maxConsecutiveReflexive: 5,
    fullCycleMinutes: 120,
    quickCheckMinutes: 20,
    commitmentStrategy: "open-minded",
  },
  legal: {
    reflexiveCeiling: 0.2,
    deliberativeFloor: 0.45,
    reflexiveConfidenceMin: 0.9,
    analyticalConfidenceMin: 0.85,
    maxConsecutiveReflexive: 2,
    fullCycleMinutes: 180,
    quickCheckMinutes: 30,
    commitmentStrategy: "cautious",
  },
  hr: {
    reflexiveCeiling: 0.35,
    deliberativeFloor: 0.65,
    reflexiveConfidenceMin: 0.7,
    analyticalConfidenceMin: 0.65,
    maxConsecutiveReflexive: 5,
    fullCycleMinutes: 120,
    quickCheckMinutes: 20,
    commitmentStrategy: "open-minded",
  },
  strategy: {
    reflexiveCeiling: 0.25,
    deliberativeFloor: 0.5,
    reflexiveConfidenceMin: 0.8,
    analyticalConfidenceMin: 0.75,
    maxConsecutiveReflexive: 3,
    fullCycleMinutes: 240,
    quickCheckMinutes: 30,
    commitmentStrategy: "open-minded",
  },
  knowledge: {
    reflexiveCeiling: 0.35,
    deliberativeFloor: 0.65,
    reflexiveConfidenceMin: 0.7,
    analyticalConfidenceMin: 0.65,
    maxConsecutiveReflexive: 5,
    fullCycleMinutes: 120,
    quickCheckMinutes: 20,
    commitmentStrategy: "open-minded",
  },
  ecommerce: {
    reflexiveCeiling: 0.4,
    deliberativeFloor: 0.7,
    reflexiveConfidenceMin: 0.65,
    analyticalConfidenceMin: 0.6,
    maxConsecutiveReflexive: 6,
    fullCycleMinutes: 60,
    quickCheckMinutes: 15,
    commitmentStrategy: "single-minded",
  },
};

/** Fallback thresholds for sub-agents or unknown roles. */
export const DEFAULT_SUBAGENT_THRESHOLDS: RoleThresholds = {
  reflexiveCeiling: 0.4,
  deliberativeFloor: 0.7,
  reflexiveConfidenceMin: 0.65,
  analyticalConfidenceMin: 0.6,
  maxConsecutiveReflexive: 6,
  fullCycleMinutes: 60,
  quickCheckMinutes: 15,
  commitmentStrategy: "single-minded",
};
