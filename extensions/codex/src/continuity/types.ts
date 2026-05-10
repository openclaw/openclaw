import type { JsonValue } from "../app-server/protocol.js";

export type CodexBridgeSource = "app-server" | "sqlite";
export type CodexBridgeDecision = "notify" | "suppress" | "watch" | "handoff" | "reject";
export type CodexBridgeEventClass =
  | "noisy_progress"
  | "meaningful_progress"
  | "completion"
  | "failure"
  | "blocker"
  | "approval_required"
  | "auth_failure"
  | "safety_boundary"
  | "user_requested_watch_update";

export type CodexBridgeWatchScope = "thread" | "repo" | "goal";
export type CodexBridgeWatchVerbosity =
  | "completion_only"
  | "blockers_and_completion"
  | "periodic_digest";
export type CodexBridgeWatchSensitivity = "normal" | "sensitive" | "no_telegram_details";
export type CodexBridgeRiskClass = "low" | "medium" | "high";

export type CodexBridgeGoalState = {
  goalKey: string;
  goalId?: string;
  objective?: string;
  status?: string;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type CodexBridgeThread = {
  id: string;
  title?: string;
  preview?: string;
  cwd?: string;
  branch?: string;
  model?: string;
  modelProvider?: string;
  source: CodexBridgeSource;
  stale: boolean;
  archived?: boolean;
  status: "active" | "idle" | "complete" | "paused" | "budget_limited" | "unknown";
  createdAtMs?: number;
  updatedAtMs?: number;
  goal?: CodexBridgeGoalState;
  raw?: JsonValue;
};

export type CodexBridgeCapabilityMap = {
  canInitialize: boolean;
  canListThreads: boolean;
  canReadThread: boolean;
  canSubscribe: boolean;
  canStartThread: boolean;
  canStartTurn: boolean;
  canSteerTurn: boolean;
  canInterruptTurn: boolean;
  confirmedWriteMethods: string[];
  warnings: string[];
};

export type CodexBridgeSnapshot = {
  ok: boolean;
  source: CodexBridgeSource;
  stale: boolean;
  observedAt: string;
  appServerStatus: {
    available: boolean;
    error?: string;
    capabilities: CodexBridgeCapabilityMap;
  };
  activeThreads: CodexBridgeThread[];
  latestThread?: CodexBridgeThread;
  threads: CodexBridgeThread[];
  watches: CodexBridgeWatchRecord[];
  lastTelegramFailure?: string;
  warnings: string[];
};

export type CodexBridgeWatchRecord = {
  version: 1;
  watchId: string;
  scope: CodexBridgeWatchScope;
  threadId?: string;
  repoPath?: string;
  goalKey?: string;
  notifyTarget?: string;
  notifyChannel: string;
  notifyAccountId?: string;
  notifyThreadId?: string | number;
  policy: string;
  verbosity: CodexBridgeWatchVerbosity;
  sensitivity: CodexBridgeWatchSensitivity;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  expiresReason?: string;
  lastEventAt?: string;
  lastNotifiedAt?: string;
  dedupeKeyLastSeen?: string;
  lastStatus?: string;
};

export type CodexBridgeAuditEvent = {
  version: 1;
  eventId: string;
  eventType: string;
  eventClass: CodexBridgeEventClass;
  threadId?: string;
  turnId?: string;
  goalKey?: string;
  source: string;
  summary: string;
  rawRef?: string;
  retentionClass: "short" | "medium" | "durable";
  privacyClass: "normal" | "sensitive" | "redacted";
  createdAt: string;
  decision?: CodexBridgeDecision;
  reasons?: string[];
};

export type CodexBridgeEventInput = {
  eventType?: string;
  eventClass?: CodexBridgeEventClass;
  threadId?: string;
  turnId?: string;
  goalKey?: string;
  status?: string;
  summary?: string;
  source?: string;
  updatedAtMs?: number;
};

export type CodexBridgeProvenance = {
  requestedBy?: string;
  requestId?: string;
  sourceMessageId?: string;
  confirmed?: boolean;
  confirmationMethod?: string;
  riskClass?: CodexBridgeRiskClass;
  createdAt?: string;
};

export type CodexBridgeWriteRequest = {
  action: "goal" | "steer";
  prompt: string;
  threadId?: string;
  turnId?: string;
  repoPath?: string;
  provenance?: CodexBridgeProvenance;
  requestedBySenderId?: string;
};

export type CodexBridgeWriteDecision =
  | {
      ok: true;
      action: "goal" | "steer";
      threadId?: string;
      repoPath?: string;
      reasons: string[];
      dryRun?: boolean;
    }
  | {
      ok: false;
      code: string;
      message: string;
      reasons: string[];
      candidates?: Array<{ thread: CodexBridgeThread; score: number; reasons: string[] }>;
    };
