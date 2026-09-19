import type { SubagentEndReason } from "../../../context-engine/types.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
/** Persisted execution, completion, delivery, and attachment state for child runs. */
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import type { SubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type {
  SubagentRunReadRecord,
  SubagentCompletionDeliveryState,
} from "./subagent-registry-read.types.js";

export type SubagentCompletionRequest = {
  runId: string;
  /** Exact in-process owner required after acquiring the terminal completion lock. */
  expectedEntry?: SubagentRunRecord;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
  suppressSessionEffects?: boolean;
  recoverInterrupted?: true;
  completionSnapshot?: { resultText: string | null; capturedAt: number };
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type ContextEngineSubagentEndedParams = {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
};

type SubagentProgressOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string | number;
  messageId?: string | number;
};

export type SubagentRestartRecoveryReceipt = {
  sessionId: string;
  sessionMarker: string;
  sessionLifecycleRevision?: string;
  sessionLifecycleRunId?: string;
  idempotencyKey: string;
  phase: "reserved" | "attempted" | "consumed" | "accepted" | "abandoned";
  lifecycleGeneration?: string;
};

type SubagentExecutionState = SubagentRunReadRecord["execution"] & {
  /** Gateway lifecycle that owns child-session effects for this run. */
  lifecycleGeneration?: string;
  /** Durable dispatch receipt for one interrupted-session snapshot. */
  restartRecovery?: SubagentRestartRecoveryReceipt;
  /** Sticky terminal policy: this run must never mutate its child session again. */
  suppressSessionEffects?: true;
  acceptedAt?: number;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart";
  transcriptTarget?: AgentRunSessionTarget;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

type SwarmCollectorCompletion = NonNullable<SubagentRunReadRecord["collectorCompletion"]> & {
  structured?: unknown;
  schemaError?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export type SwarmStructuredOutputState = {
  structured?: unknown;
  schemaError?: string;
  invalidAttempts: number;
};

type SwarmQueuedLaunch = {
  request: Record<string, unknown>;
  /** Exact trusted launch capability, persisted so restart replay cannot lose it. */
  authorization?: SubagentLaunchAuthorization;
  timeoutMs: number;
  schedulerGroupKey: string;
  maxConcurrent: number;
};

/** Durable outbox state for the top-level requester settle wake. */
export type RequesterSettleWakeState = {
  status: "pending" | "dispatching";
  /** Number of delivery attempts already admitted. */
  attemptCount: number;
  /** Ambiguous transport replays made with the current idempotency key. */
  replayCount?: number;
  /** Persisted retry deadline; restore waits until this instant. */
  nextAttemptAt?: number;
  /** Frozen wave membership after delivery admission or requester-yield re-admission. */
  batchRunIds?: string[];
  /** Batch frozen while its spawning requester turn was yielding. */
  requesterYieldBatch?: true;
  /** Present only when an idle requester needs a new turn after yielding. */
  afterRequesterYield?: true;
  /** Monotonic process generation protecting a newer yield from stale completion. */
  rearmGeneration?: number;
  /** Reference to the conversation receipt for this presentation, not completion credit. */
  progressOperationId?: string;
  /** Number of times this batch has been deferred due to unsettled descendants. */
  deferralCount?: number;
  lastError?: string | null;
  /** Cleanup wanted to retire this row; defer deletion until the outbox resolves. */
  retireAfterSettle?: boolean;
};

type SubagentKillReconciliationState = {
  /** Actual cancellation time; a yielded run may have an older execution end. */
  killedAt: number;
  /** The current lifecycle accepted a live kill claim before terminalization. */
  taskCancellationAccepted?: true;
  /** Requester aborts must not re-inject a delayed completion after queues are cleared. */
  suppressTaskDelivery?: boolean;
  /** Durable ownership boundary even after the newer registry row is released. */
  supersededAt?: number;
};

type SubagentKillIntent = {
  requestedAt: number;
  reason: string;
  lifecycleGeneration?: string;
  sessionId?: string;
  sessionLifecycleRevision?: string;
  suppressTaskDelivery?: boolean;
};

export type SubagentRunRecord = Omit<SubagentRunReadRecord, "execution" | "collectorCompletion"> & {
  /** Detached task owner; steer/restart changes runId but continues the same task. */
  taskRunId?: string;
  /** Exact requester attempt for cancellation, independent of completion messaging. */
  requesterTurnRunId?: string;
  /** Durable proof that this requester attempt invoked sessions_yield. */
  requesterTurnYielded?: true;
  /** Completion-producing row retirement deferred until requesterTurnRunId settles. */
  retireAfterRequesterTurn?: boolean;
  requesterOrigin?: DeliveryContext;
  /** Durable source locator for transport-neutral progress presentation. */
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  agentDir?: string;
  workspaceDir?: string;
  spawnMode?: SpawnSubagentMode;
  archiveAtMs?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  /** Sticky owner while restart recovery replays this exact terminal run. */
  terminalOwner?: "interrupted-recovery";
  /** Durable requester notice debt, independent of restart execution ownership. */
  resumptionNotice?: { idempotencyKey: string };
  /** Present only while a current-version killed run awaits bounded reconciliation. */
  killReconciliation?: SubagentKillReconciliationState;
  /** Durable operator cancellation ownership before runtime side effects complete. */
  killIntent?: SubagentKillIntent;
  /** Durable requester-delivery closure until silent completion cleanup finishes. */
  suppressCompletionDelivery?: boolean;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  wakeOnDescendantSettle?: boolean;
  execution: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Set immediately before irreversible sessions.delete cleanup is dispatched. */
  deleteCleanupDispatchedAt?: number;
  /** Durable top-level requester wake obligation, replayed after restart. */
  requesterSettleWake?: RequesterSettleWakeState;
  /** Generated identity under the host-owned per-agent attachment root. */
  attachmentId?: string;
  /** Legacy persisted absolute paths are never used for cleanup. */
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  /** Spawner plus ancestor sessions authorized to wait, frozen when the collector is registered. */
  swarmWaitOwnerSessionKeys?: string[];
  /** Stable scheduler slot identity across gateway-assigned run id replacements. */
  schedulerSlotId?: string;
  /** Exact host-reserved Gateway request identity for the current collector turn. */
  swarmLaunchIdempotencyKey?: string;
  /** Replay-safe host bridge identity used to recover a collector after restart. */
  swarmLaunchReplayKey?: string;
  /** Canonical collector request hash paired with a host-reserved launch identity. */
  swarmLaunchRequestFingerprint?: string;
  /** True only between host reservation and accepted Gateway dispatch. */
  swarmLaunchPending?: boolean;
  outputSchema?: Record<string, unknown>;
  structuredOutput?: SwarmStructuredOutputState;
  queuedLaunch?: SwarmQueuedLaunch;
  /** Durable retry obligation for a prepared collector session whose launch failed. */
  collectorLaunchCleanupPending?: boolean;
  /** Set after failed-launch context-engine cleanup succeeds, preventing duplicate end hooks. */
  contextEngineCleanupCompletedAt?: number;
  collectorCompletion?: SwarmCollectorCompletion;
};

/** Lifecycle facts needed to protect child transcripts during session maintenance. */
export type SubagentRunMaintenanceRecord = Pick<
  SubagentRunRecord,
  | "runId"
  | "childSessionKey"
  | "requesterSessionKey"
  | "createdAt"
  | "cleanupCompletedAt"
  | "expectsCompletionMessage"
  | "killIntent"
  | "killReconciliation"
> & {
  execution: Pick<SubagentExecutionState, "status" | "endedAt">;
  delivery?: Pick<SubagentCompletionDeliveryState, "status" | "suspendedAt">;
};

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  spawnMode?: "run" | "session";
  attachmentId?: string;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  swarmLaunchIdempotencyKey?: string;
  swarmLaunchReplayKey?: string;
  swarmLaunchRequestFingerprint?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  queued?: boolean;
  /** Required when direct dispatch suppresses Gateway tracking. Out-of-process launches keep
      Gateway's existing best-effort CLI policy; other callers create a best-effort row here. */
  taskRowOwnership?: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};
