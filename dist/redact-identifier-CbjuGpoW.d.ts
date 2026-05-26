import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { t as SubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { H as DiagnosticSessionActiveWorkKind, Y as DiagnosticSessionState, _ as DiagnosticLivenessWarningReason, x as DiagnosticMemoryUsage } from "./diagnostic-events-C_Kyi8bL.js";

//#region src/logger.d.ts
declare function logInfo(message: string, runtime?: RuntimeEnv): void;
declare function logWarn(message: string, runtime?: RuntimeEnv): void;
declare function logSuccess(message: string, runtime?: RuntimeEnv): void;
declare function logError(message: string, runtime?: RuntimeEnv): void;
declare function logDebug(message: string): void;
//#endregion
//#region src/logging/diagnostic-memory.d.ts
type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};
declare function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
  writeCriticalBundle?: boolean;
  stateDir?: string;
  sessionStorePaths?: string[];
  resolveSessionStorePaths?: () => string[] | undefined;
}): DiagnosticMemoryUsage;
//#endregion
//#region src/logging/diagnostic-session-attention.d.ts
type SessionAttentionClassification = {
  eventType: "session.long_running";
  reason: string;
  classification: "long_running";
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  recoveryEligible: false;
} | {
  eventType: "session.stalled";
  reason: string;
  classification: "blocked_tool_call" | "stalled_agent_run";
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  recoveryEligible: false;
} | {
  eventType: "session.stuck";
  reason: string;
  classification: "stale_session_state";
  activeWorkKind?: undefined;
  recoveryEligible: true;
};
//#endregion
//#region src/logging/diagnostic-session-recovery.d.ts
type DiagnosticSessionRecoverySkipReason = "active_embedded_run" | "active_reply_work" | "active_lane_task" | "already_in_flight" | "missing_session_ref" | "stale_session_state";
type DiagnosticSessionRecoveryNoopReason = "no_active_work";
type StuckSessionRecoveryRequest = {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
  expectedState?: DiagnosticSessionState;
  stateGeneration?: number;
};
type DiagnosticSessionRecoveryBaseOutcome = {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  lane?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
};
type StuckSessionRecoveryOutcome = (DiagnosticSessionRecoveryBaseOutcome & {
  status: "aborted";
  action: "abort_embedded_run";
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
  released: number;
  queuedCount?: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "released";
  action: "release_lane";
  released: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "skipped";
  action: "observe_only" | "keep_lane";
  reason: DiagnosticSessionRecoverySkipReason;
  activeCount?: number;
  queuedCount?: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "noop";
  action: "none";
  reason: DiagnosticSessionRecoveryNoopReason;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "failed";
  action: "none";
  reason: "exception";
  error: string;
});
//#endregion
//#region src/logging/diagnostic-session-recovery-coordinator.d.ts
type RecoverStuckSession = (params: StuckSessionRecoveryRequest) => void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>;
//#endregion
//#region src/logging/diagnostic-session-state.d.ts
type SessionStateValue = "idle" | "processing" | "waiting";
type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};
//#endregion
//#region src/logging/diagnostic-runtime.d.ts
declare const diagnosticLogger: SubsystemLogger;
declare function logLaneEnqueue(lane: string, queueSize: number): void;
declare function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void;
//#endregion
//#region src/logging/diagnostic.d.ts
type EmitDiagnosticMemorySample = typeof emitDiagnosticMemorySample;
type DiagnosticWorkSnapshot = {
  activeCount: number;
  waitingCount: number;
  queuedCount: number;
  activeLabels: string[];
  waitingLabels: string[];
  queuedLabels: string[];
};
type DiagnosticLivenessSample = {
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
};
type SampleDiagnosticLiveness = (now: number, work: DiagnosticWorkSnapshot) => DiagnosticLivenessSample | null;
type StartDiagnosticHeartbeatOptions = {
  getConfig?: () => OpenClawConfig;
  emitMemorySample?: EmitDiagnosticMemorySample;
  sampleLiveness?: SampleDiagnosticLiveness;
  recoverStuckSession?: RecoverStuckSession;
  startupGraceMs?: number;
};
declare function resolveStuckSessionWarnMs(config?: OpenClawConfig): number;
declare function resolveStuckSessionAbortMs(config: OpenClawConfig | undefined, stuckSessionWarnMs: number): number;
declare function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}): void;
declare function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}): void;
declare function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}): void;
declare function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}): void;
declare function logMessageReceived(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  messageId?: number | string;
  chatId?: number | string;
  source: string;
}): void;
declare function logMessageDispatchStarted(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}): void;
declare function logMessageDispatchCompleted(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
  durationMs: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}): void;
declare function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}): void;
declare function logSessionTurnCreated(params: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  trigger: "user" | "heartbeat";
}): void;
declare function logSessionStateChange(params: SessionRef & {
  state: SessionStateValue;
  reason?: string;
}): void;
declare function markDiagnosticSessionProgress(params: SessionRef): void;
declare function logSessionAttention(params: SessionRef & {
  state: SessionStateValue;
  ageMs: number;
  thresholdMs: number;
  abortThresholdMs?: number;
}): SessionAttentionClassification | undefined;
declare function logRunAttempt(params: SessionRef & {
  runId: string;
  attempt: number;
}): void;
declare function logToolLoopAction(params: SessionRef & {
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "unknown_tool_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
}): void;
declare function logActiveRuns(): void;
declare function startDiagnosticHeartbeat(config?: OpenClawConfig, opts?: StartDiagnosticHeartbeatOptions): void;
declare function stopDiagnosticHeartbeat(): void;
declare function getDiagnosticSessionStateCountForTest(): number;
declare function resetDiagnosticStateForTest(): void;
//#endregion
//#region src/logging/redact-identifier.d.ts
declare function sha256HexPrefix(value: string, len?: number): string;
declare function redactIdentifier(value: string | undefined, opts?: {
  len?: number;
}): string;
//#endregion
export { logSuccess as A, stopDiagnosticHeartbeat as C, logDebug as D, logLaneEnqueue as E, logError as O, startDiagnosticHeartbeat as S, logLaneDequeue as T, logWebhookReceived as _, logMessageDispatchCompleted as a, resolveStuckSessionAbortMs as b, logMessageQueued as c, logSessionAttention as d, logSessionStateChange as f, logWebhookProcessed as g, logWebhookError as h, logActiveRuns as i, logWarn as j, logInfo as k, logMessageReceived as l, logToolLoopAction as m, sha256HexPrefix as n, logMessageDispatchStarted as o, logSessionTurnCreated as p, getDiagnosticSessionStateCountForTest as r, logMessageProcessed as s, redactIdentifier as t, logRunAttempt as u, markDiagnosticSessionProgress as v, diagnosticLogger as w, resolveStuckSessionWarnMs as x, resetDiagnosticStateForTest as y };