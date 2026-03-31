/**
 * Shared types across MABOS ecosystem.
 * Merged from: openclaw-mabos, mission-control, paperclip, hermes.
 */

// ── Agent Types ─────────────────────────────────────────────
export interface MabosAgent {
  id: string;
  name: string;
  role: string;
  status: "active" | "idle" | "error" | "paused";
  autonomyLevel: number;
  approvalThreshold: number;
  parentAgentId?: string;
  beliefs?: number;
  goals?: number;
  intentions?: number;
  desires?: number;
}

// ── Task Types (from Mission Control) ──────────────────────
export type TaskStatus =
  | "pending_dispatch"
  | "planning"
  | "inbox"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "verification"
  | "done"
  | "failed"
  | "cancelled";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface MabosTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  workspaceId?: string;
  origin: "mc" | "mabos" | "operator";
  createdAt: string;
  updatedAt: string;
}

// ── Goal Types (from Mission Control + MABOS) ──────────────
export type GoalTier = "strategic" | "tactical" | "operational";

export interface BusinessGoal {
  id: string;
  title: string;
  description: string;
  tier: GoalTier;
  status: "active" | "achieved" | "abandoned";
  progress: number;
  parentGoalId?: string;
  ownerAgentId?: string;
}

// ── Budget Types (from Governance module) ──────────────────
export interface BudgetStatus {
  agentId: string;
  daily: { limit: number; spent: number; reserved: number; remaining: number } | null;
  monthly: { limit: number; spent: number; reserved: number; remaining: number } | null;
  canSpend: boolean;
}

// ── Adapter Types (from Paperclip) ────────────────────────
export type AdapterType =
  | "openclaw-local"
  | "hermes-local"
  | "claude-local"
  | "codex-local"
  | "cursor-local"
  | "gemini-local"
  | "custom";

export interface AgentAdapter {
  id: string;
  type: AdapterType;
  label: string;
  status: "healthy" | "degraded" | "offline";
  modelsSupported: string[];
  config?: Record<string, unknown>;
}

// ── SSE Event Types ───────────────────────────────────────
export type SSEEventType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "agent_status_changed"
  | "activity_logged"
  | "deliverable_added"
  | "mabos:agent_update"
  | "mabos:sync_complete"
  | "mabos:decision_pending"
  | "mabos:activity"
  | "budget_alert"
  | "security_scan";

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: number;
}

// ── Approval Types (from Security + Governance) ───────────
export interface ApprovalRequest {
  id: string;
  toolName: string;
  agentId: string;
  actorRole: string;
  reason: string;
  redactedArgs: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

// ── Skill Types (from Skill Loop) ────────────────────────
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  toolsRequired?: string[];
  applicableRoles?: string[];
  createdAt: string;
  confidence?: number;
}

// ── Model Types (from Model Router) ──────────────────────
export interface ModelSpec {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  inputPricePer1kTokens: number;
  outputPricePer1kTokens: number;
  supportsPromptCaching?: boolean;
  supportsExtendedThinking?: boolean;
  supportsVision?: boolean;
}
