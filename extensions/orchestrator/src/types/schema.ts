// Canonical wire schema for the Phase B orchestrator.
//
// This file is byte-equivalent (after `normalizeSchemaSource`) to its sibling
// in MissionControl at `lib/orchestrator/types.ts`. The hash test in this
// repo (and in MC) catches drift. When updating either side, update both
// schema files and both pinned hashes in the same PR.
//
// Pure TS types only. No runtime imports, no value exports. Both repos
// compile this file as a type-only module.

export const SCHEMA_VERSION = 1;
export type SchemaVersion = typeof SCHEMA_VERSION;

// ---- Task --------------------------------------------------------------

export type TaskState =
  | "queued"
  | "assigned"
  | "in_progress"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

// "synthetic" tasks render through Pipeline without invoking sessions_spawn.
// "shadow" tasks invoke real spawn but bypass operator approval (24h gate
// before flipping to "live"). "live" is the production mode.
export type TaskKind = "live" | "synthetic" | "shadow";

export interface TaskRoutingDecision {
  matchedRuleId: string | null;
  assignedAgentId: string;
  capabilityMatches: string[];
  fallbackUsed: boolean;
  decidedAt: string;
}

export interface TaskResult {
  text: string | null;
  textPath: string | null;
  artefacts: TaskArtefact[];
  specialistSessionId: string;
}

export interface TaskArtefact {
  path: string;
  mediaType: string;
  bytes: number;
}

export interface TaskRejection {
  by: string;
  reason: string;
  at: string;
}

export type TaskErrorCode =
  | "spawn_failed"
  | "specialist_timeout"
  | "specialist_aborted"
  | "rule_loaded_no_agent"
  | "rejected"
  | "schema_drift"
  | "unknown";

export interface TaskError {
  code: TaskErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface Task {
  schemaVersion: SchemaVersion;
  id: string;
  kind: TaskKind;
  state: TaskState;

  goal: string;
  workspaceDir: string | null;
  requiredCapabilities: string[];

  routing: TaskRoutingDecision | null;
  assignedAgentId: string | null;

  result: TaskResult | null;
  rejection: TaskRejection | null;
  error: TaskError | null;

  submittedBy: string;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

// ---- Routing -----------------------------------------------------------

export interface RoutingRule {
  id: string;
  description?: string;
  pattern: string;
  capabilities: string[];
  agent: string;
  priority: number;
}

export interface RoutingDefault {
  agent: string;
  requireApproval: boolean;
}

export interface RoutingConfig {
  schemaVersion: SchemaVersion;
  rules: RoutingRule[];
  default: RoutingDefault;
  approvalRequired: string[];
  approvalRequiredCapabilities: string[];
}

// ---- Trajectory --------------------------------------------------------

export type TaskTrajectoryEventKind =
  | "queued"
  | "assigned"
  | "in_progress"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

export type TaskTrajectoryEventData =
  | { kind: "queued"; taskId: string; goal: string; submittedBy: string }
  | {
      kind: "assigned";
      taskId: string;
      agentId: string;
      ruleId: string | null;
      capabilities: string[];
    }
  | {
      kind: "in_progress";
      taskId: string;
      agentId: string;
      specialistSessionId: string;
    }
  | {
      kind: "awaiting_approval";
      taskId: string;
      agentId: string;
      resultPreviewBytes: number;
    }
  | { kind: "done"; taskId: string; agentId: string; durationMs: number }
  | {
      kind: "failed";
      taskId: string;
      agentId: string | null;
      errorCode: TaskErrorCode;
      errorMessage: string;
    }
  | {
      kind: "cancelled";
      taskId: string;
      agentId: string | null;
      by: string;
    }
  | { kind: "expired"; taskId: string; agentId: string | null };

// ---- WS (deferred) -----------------------------------------------------

export interface WSTaskEvent {
  type: "task_event";
  schemaVersion: SchemaVersion;
  taskId: string;
  eventKind: TaskTrajectoryEventKind;
  task: Task;
}
