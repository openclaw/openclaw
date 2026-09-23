import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";

export type PendingFinalDeliveryPayload = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

type SubagentDeliveryDisposition =
  | "delivered"
  | "session_queued"
  | "intentional_non_delivery"
  | "retryable"
  | "ambiguous"
  | "permanent_failure";

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  /** Exact requester turn and completed child batch that already produced its visible final. */
  requesterVisibleFinal?: { requesterTurnRunId: string; batchRunIds: string[] };
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  /** Closed result of the latest transport attempt; never doubles as delivery success. */
  disposition?: SubagentDeliveryDisposition;
  /** Logical obligation generation. Redrive increments it and never revives an old row. */
  generation?: number;
  queueId?: string;
  windowStartedAt?: number;
  deadlineAt?: number;
  nextAttemptAt?: number;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "expiry" | "permanent_failure";
  dismissedAt?: number;
  discardedAt?: number;
  discardReason?: "expired";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "steer_dropped"
    | "message_tool_delivery_missing"
    | "dedupe"
    | "waiting_for_requester_turn";
};

export type SwarmCollectorStatus = "done" | "failed" | "killed" | "timeout";

/** Persisted fields shared by compact registry reads and the full runtime record. */
export type SubagentRunReadRecord = {
  runId: string;
  /** Logical task ownership survives replacement of the physical execution run. */
  taskRunId?: string;
  /** Stable public collector id; gateway execution ids can change across dispatch/recovery. */
  swarmRunId?: string;
  /** Collector-mode runs remain waitable and never announce to the requester. */
  collect?: boolean;
  groupId?: string;
  /** Stable spawning-session owner for caps, scheduling, and wait authorization. */
  swarmRequesterSessionKey?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  /** Effective requester agent, including cron/hook overrides not encoded in the session key. */
  requesterAgentId?: string;
  requesterStorePath?: string;
  controllerStorePath?: string;
  model?: string;
  /** Monotonic ownership generation within one child session. */
  generation?: number;
  createdAt: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  runTimeoutSeconds?: number;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  cleanupCompletedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  execution: {
    status: "queued" | "running" | "interrupted" | "terminal";
    startedAt?: number;
    endedAt?: number;
    outcome?: SubagentRunOutcome;
  };
  collectorCompletion?: {
    status: SwarmCollectorStatus;
  };
};
