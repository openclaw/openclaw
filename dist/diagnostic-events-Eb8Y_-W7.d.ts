import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-Cr5jFRhS.js";

//#region src/talk/talk-events.d.ts
declare const TALK_EVENT_TYPES: readonly ["session.started", "session.ready", "session.closed", "session.error", "session.replaced", "turn.started", "turn.ended", "turn.cancelled", "capture.started", "capture.stopped", "capture.cancelled", "capture.once", "input.audio.delta", "input.audio.committed", "transcript.delta", "transcript.done", "output.text.delta", "output.text.done", "output.audio.started", "output.audio.delta", "output.audio.done", "tool.call", "tool.progress", "tool.result", "tool.error", "usage.metrics", "latency.metrics", "health.changed"];
type TalkEventType = (typeof TALK_EVENT_TYPES)[number];
type TalkMode = "realtime" | "stt-tts" | "transcription";
type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
type TalkBrain = "agent-consult" | "direct-tools" | "none";
type TalkEventContext = {
  sessionId: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
};
type TalkEvent<TPayload = unknown> = TalkEventContext & {
  id: string;
  type: TalkEventType;
  turnId?: string;
  captureId?: string;
  seq: number;
  timestamp: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
  payload: TPayload;
};
type TalkEventInput<TPayload = unknown> = {
  type: TalkEventType;
  payload: TPayload;
  turnId?: string;
  captureId?: string;
  timestamp?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};
type TalkEventSequencer = {
  next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
};
declare function createTalkEventSequencer(context: TalkEventContext, options?: {
  now?: () => Date | string;
}): TalkEventSequencer;
//#endregion
//#region src/infra/diagnostic-events.d.ts
type DiagnosticSessionState = "idle" | "processing" | "waiting";
type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};
type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};
type DiagnosticFailoverEvent = DiagnosticBaseEvent & {
  type: "model.failover";
  sessionId?: string;
  sessionKey?: string;
  lane?: string;
  fromProvider?: string;
  fromModel?: string;
  toProvider?: string;
  toModel?: string;
  reason: string;
  cascadeDepth?: number;
  suspended?: boolean;
};
type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};
type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};
type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};
type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
  type: "message.queued";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  source: string;
  queueDepth?: number;
};
type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};
type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";
type DiagnosticMessageDeliveryBaseEvent = DiagnosticBaseEvent & {
  channel: string;
  sessionKey?: string;
  deliveryKind: DiagnosticMessageDeliveryKind;
};
type DiagnosticMessageDeliveryStartedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.started";
};
type DiagnosticMessageDeliveryCompletedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.completed";
  durationMs: number;
  resultCount: number;
};
type DiagnosticMessageDeliveryErrorEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.error";
  durationMs: number;
  errorCategory: string;
};
type DiagnosticTalkEvent = DiagnosticBaseEvent & {
  type: "talk.event";
  sessionId?: string;
  turnId?: string;
  captureId?: string;
  talkEventType: TalkEventType;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
  final?: boolean;
  durationMs?: number;
  byteLength?: number;
};
type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
  type: "session.state";
  sessionKey?: string;
  sessionId?: string;
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};
type DiagnosticSessionActiveWorkKind = "embedded_run" | "model_call" | "tool_call";
type DiagnosticSessionAttentionClassification = "long_running" | "blocked_tool_call" | "stalled_agent_run" | "stale_session_state";
type DiagnosticSessionAttentionBaseEvent = DiagnosticBaseEvent & {
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
  reason?: string;
  classification: DiagnosticSessionAttentionClassification;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  terminalProgressStale?: boolean;
};
type DiagnosticSessionLongRunningEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.long_running";
  classification: "long_running";
};
type DiagnosticSessionStalledEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stalled";
  classification: "blocked_tool_call" | "stalled_agent_run";
};
type DiagnosticSessionStuckEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stuck";
  classification: "stale_session_state";
};
type DiagnosticSessionRecoveryStatus = "aborted" | "released" | "skipped" | "noop" | "failed";
type DiagnosticSessionRecoveryBaseEvent = DiagnosticBaseEvent & {
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  stateGeneration?: number;
  ageMs: number;
  queueDepth?: number;
  reason?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  allowActiveAbort?: boolean;
};
type DiagnosticSessionRecoveryRequestedEvent = DiagnosticSessionRecoveryBaseEvent & {
  type: "session.recovery.requested";
};
type DiagnosticSessionRecoveryCompletedEvent = DiagnosticSessionRecoveryBaseEvent & {
  type: "session.recovery.completed";
  status: DiagnosticSessionRecoveryStatus;
  action: string;
  outcomeReason?: string;
  released?: number;
  stale?: boolean;
};
type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};
type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};
type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
  type: "run.attempt";
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
};
type DiagnosticRunProgressEvent = DiagnosticBaseEvent & {
  type: "run.progress";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  reason: string;
};
type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
};
type DiagnosticLivenessWarningReason = "event_loop_delay" | "event_loop_utilization" | "cpu";
type DiagnosticPhaseDetails = Record<string, string | number | boolean>;
type DiagnosticPhaseSnapshot = {
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  details?: DiagnosticPhaseDetails;
};
type DiagnosticLivenessWarningEvent = DiagnosticBaseEvent & {
  type: "diagnostic.liveness.warning";
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  active: number;
  waiting: number;
  queued: number;
  phase?: string;
  recentPhases?: DiagnosticPhaseSnapshot[];
  activeWorkLabels?: string[];
  waitingWorkLabels?: string[];
  queuedWorkLabels?: string[];
};
type DiagnosticPhaseCompletedEvent = DiagnosticBaseEvent & DiagnosticPhaseSnapshot & {
  type: "diagnostic.phase.completed";
};
type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "unknown_tool_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
};
type DiagnosticToolParamsSummary = {
  kind: "object";
} | {
  kind: "array";
  length: number;
} | {
  kind: "string";
  length: number;
} | {
  kind: "number" | "boolean" | "null" | "undefined" | "other";
};
type DiagnosticToolExecutionBaseEvent = DiagnosticBaseEvent & {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  toolCallId?: string;
  paramsSummary?: DiagnosticToolParamsSummary;
};
type DiagnosticToolExecutionStartedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.started";
};
type DiagnosticToolExecutionCompletedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.completed";
  durationMs: number;
};
type DiagnosticToolExecutionErrorEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.error";
  durationMs: number;
  errorCategory: string;
  errorCode?: string;
};
type DiagnosticToolExecutionBlockedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.blocked";
  deniedReason: string;
  reason: string;
};
type DiagnosticExecProcessCompletedEvent = DiagnosticBaseEvent & {
  type: "exec.process.completed";
  sessionKey?: string;
  target: "host" | "sandbox";
  mode: "child" | "pty";
  outcome: "completed" | "failed";
  durationMs: number;
  commandLength: number;
  exitCode?: number;
  exitSignal?: string;
  timedOut?: boolean;
  failureKind?: "shell-command-not-found" | "shell-not-executable" | "overall-timeout" | "no-output-timeout" | "signal" | "aborted" | "runtime-error";
};
type DiagnosticRunBaseEvent = DiagnosticBaseEvent & {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
};
type DiagnosticRunStartedEvent = DiagnosticRunBaseEvent & {
  type: "run.started";
};
type DiagnosticRunCompletedEvent = DiagnosticRunBaseEvent & {
  type: "run.completed";
  durationMs: number;
  outcome: "completed" | "aborted" | "blocked" | "error";
  errorCategory?: string;
  blockedBy?: string;
};
type DiagnosticHarnessRunPhase = "prepare" | "start" | "send" | "resolve" | "cleanup";
type DiagnosticHarnessRunOutcome = "completed" | "aborted" | "timed_out" | "error";
type DiagnosticHarnessRunBaseEvent = DiagnosticBaseEvent & {
  type: "harness.run.started" | "harness.run.completed" | "harness.run.error";
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
  harnessId: string;
  pluginId?: string;
};
type DiagnosticHarnessRunStartedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.started";
};
type DiagnosticHarnessRunCompletedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.completed";
  durationMs: number;
  outcome: DiagnosticHarnessRunOutcome;
  resultClassification?: "empty" | "reasoning-only" | "planning-only";
  yieldDetected?: boolean;
  itemLifecycle?: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
};
type DiagnosticHarnessRunErrorEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.error";
  durationMs: number;
  phase: DiagnosticHarnessRunPhase;
  errorCategory: string;
  cleanupFailed?: boolean;
};
type DiagnosticModelCallBaseEvent = DiagnosticBaseEvent & {
  type: "model.call.started" | "model.call.completed" | "model.call.error";
  runId: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  upstreamRequestIdHash?: string;
};
type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.started";
};
type DiagnosticModelCallCompletedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.completed";
  durationMs: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
};
type DiagnosticModelCallErrorEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.error";
  durationMs: number;
  errorCategory: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  memory?: DiagnosticMemoryUsage;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
};
type DiagnosticContextAssembledEvent = DiagnosticBaseEvent & {
  type: "context.assembled";
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  channel?: string;
  trigger?: string;
  messageCount: number;
  historyTextChars: number;
  historyImageBlocks: number;
  maxMessageTextChars: number;
  systemPromptChars: number;
  promptChars: number;
  promptImages: number;
  contextTokenBudget?: number;
  reserveTokens?: number;
};
type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};
type DiagnosticMemorySampleEvent = DiagnosticBaseEvent & {
  type: "diagnostic.memory.sample";
  memory: DiagnosticMemoryUsage;
  uptimeMs?: number;
};
type DiagnosticMemoryPressureEvent = DiagnosticBaseEvent & {
  type: "diagnostic.memory.pressure";
  level: "warning" | "critical";
  reason: "rss_threshold" | "heap_threshold" | "rss_growth";
  memory: DiagnosticMemoryUsage;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
};
type DiagnosticPayloadLargeEvent = DiagnosticBaseEvent & {
  type: "payload.large";
  surface: string;
  action: "rejected" | "truncated" | "chunked";
  bytes?: number;
  limitBytes?: number;
  count?: number;
  channel?: string;
  pluginId?: string;
  reason?: string;
};
type DiagnosticLogRecordEvent = DiagnosticBaseEvent & {
  type: "log.record";
  level: string;
  message: string;
  loggerName?: string;
  loggerParents?: string[];
  attributes?: Record<string, string | number | boolean>;
  code?: {
    line?: number;
    functionName?: string;
  };
};
type DiagnosticTelemetryExporterEvent = DiagnosticBaseEvent & {
  type: "telemetry.exporter";
  exporter: string;
  signal: "traces" | "metrics" | "logs";
  status: "started" | "failure" | "dropped";
  reason?: "configured" | "emit_failed" | "handler_failed" | "queue_full" | "shutdown_failed" | "start_failed" | "unsupported_protocol";
  errorCategory?: string;
};
type DiagnosticEventPayload = DiagnosticUsageEvent | DiagnosticWebhookReceivedEvent | DiagnosticWebhookProcessedEvent | DiagnosticWebhookErrorEvent | DiagnosticMessageQueuedEvent | DiagnosticMessageProcessedEvent | DiagnosticMessageDeliveryStartedEvent | DiagnosticMessageDeliveryCompletedEvent | DiagnosticMessageDeliveryErrorEvent | DiagnosticTalkEvent | DiagnosticSessionStateEvent | DiagnosticSessionLongRunningEvent | DiagnosticSessionStalledEvent | DiagnosticSessionStuckEvent | DiagnosticSessionRecoveryRequestedEvent | DiagnosticSessionRecoveryCompletedEvent | DiagnosticLaneEnqueueEvent | DiagnosticLaneDequeueEvent | DiagnosticRunAttemptEvent | DiagnosticRunProgressEvent | DiagnosticHeartbeatEvent | DiagnosticLivenessWarningEvent | DiagnosticPhaseCompletedEvent | DiagnosticToolLoopEvent | DiagnosticToolExecutionStartedEvent | DiagnosticToolExecutionCompletedEvent | DiagnosticToolExecutionErrorEvent | DiagnosticToolExecutionBlockedEvent | DiagnosticExecProcessCompletedEvent | DiagnosticRunStartedEvent | DiagnosticRunCompletedEvent | DiagnosticHarnessRunStartedEvent | DiagnosticHarnessRunCompletedEvent | DiagnosticHarnessRunErrorEvent | DiagnosticModelCallStartedEvent | DiagnosticModelCallCompletedEvent | DiagnosticModelCallErrorEvent | DiagnosticContextAssembledEvent | DiagnosticMemorySampleEvent | DiagnosticMemoryPressureEvent | DiagnosticPayloadLargeEvent | DiagnosticLogRecordEvent | DiagnosticTelemetryExporterEvent | DiagnosticFailoverEvent;
type DiagnosticEventInput = DiagnosticEventPayload extends infer Event ? Event extends DiagnosticEventPayload ? Omit<Event, "seq" | "ts"> : never : never;
type DiagnosticEventMetadata = Readonly<{
  trusted: boolean;
}>;
type DiagnosticEventListener = (evt: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void;
declare function isDiagnosticsEnabled(config?: OpenClawConfig): boolean;
declare function setDiagnosticsEnabledForProcess(enabled: boolean): void;
declare function areDiagnosticsEnabledForProcess(): boolean;
declare function emitDiagnosticEvent(event: DiagnosticEventInput): void;
declare function emitTrustedDiagnosticEvent(event: DiagnosticEventInput): void;
declare function emitFailoverEvent(event: Omit<DiagnosticFailoverEvent, "seq" | "ts" | "type">): void;
declare function onInternalDiagnosticEvent(listener: DiagnosticEventListener): () => void;
declare function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void;
declare function formatDiagnosticTraceparentForPropagation(event: {
  trace?: DiagnosticTraceContext;
}, metadata: DiagnosticEventMetadata): string | undefined;
declare function resetDiagnosticEventsForTest(): void;
//#endregion
export { DiagnosticToolExecutionStartedEvent as $, DiagnosticPayloadLargeEvent as A, DiagnosticSessionLongRunningEvent as B, DiagnosticMessageDeliveryKind as C, TalkMode as Ct, DiagnosticModelCallCompletedEvent as D, DiagnosticMessageQueuedEvent as E, DiagnosticRunCompletedEvent as F, DiagnosticSessionState as G, DiagnosticSessionRecoveryRequestedEvent as H, DiagnosticRunProgressEvent as I, DiagnosticTalkEvent as J, DiagnosticSessionStateEvent as K, DiagnosticRunStartedEvent as L, DiagnosticPhaseDetails as M, DiagnosticPhaseSnapshot as N, DiagnosticModelCallErrorEvent as O, DiagnosticRunAttemptEvent as P, DiagnosticToolExecutionErrorEvent as Q, DiagnosticSessionActiveWorkKind as R, DiagnosticMessageDeliveryErrorEvent as S, TalkEventType as St, DiagnosticMessageProcessedEvent as T, createTalkEventSequencer as Tt, DiagnosticSessionRecoveryStatus as U, DiagnosticSessionRecoveryCompletedEvent as V, DiagnosticSessionStalledEvent as W, DiagnosticToolExecutionBlockedEvent as X, DiagnosticTelemetryExporterEvent as Y, DiagnosticToolExecutionCompletedEvent as Z, DiagnosticLogRecordEvent as _, TalkBrain as _t, DiagnosticExecProcessCompletedEvent as a, DiagnosticWebhookReceivedEvent as at, DiagnosticMemoryUsage as b, TalkEventInput as bt, DiagnosticHarnessRunErrorEvent as c, emitFailoverEvent as ct, DiagnosticHarnessRunStartedEvent as d, isDiagnosticsEnabled as dt, DiagnosticToolLoopEvent as et, DiagnosticHeartbeatEvent as f, onDiagnosticEvent as ft, DiagnosticLivenessWarningReason as g, TALK_EVENT_TYPES as gt, DiagnosticLivenessWarningEvent as h, setDiagnosticsEnabledForProcess as ht, DiagnosticEventPayload as i, DiagnosticWebhookProcessedEvent as it, DiagnosticPhaseCompletedEvent as j, DiagnosticModelCallStartedEvent as k, DiagnosticHarnessRunOutcome as l, emitTrustedDiagnosticEvent as lt, DiagnosticLaneEnqueueEvent as m, resetDiagnosticEventsForTest as mt, DiagnosticEventInput as n, DiagnosticUsageEvent as nt, DiagnosticFailoverEvent as o, areDiagnosticsEnabledForProcess as ot, DiagnosticLaneDequeueEvent as p, onInternalDiagnosticEvent as pt, DiagnosticSessionStuckEvent as q, DiagnosticEventMetadata as r, DiagnosticWebhookErrorEvent as rt, DiagnosticHarnessRunCompletedEvent as s, emitDiagnosticEvent as st, DiagnosticContextAssembledEvent as t, DiagnosticToolParamsSummary as tt, DiagnosticHarnessRunPhase as u, formatDiagnosticTraceparentForPropagation as ut, DiagnosticMemoryPressureEvent as v, TalkEvent as vt, DiagnosticMessageDeliveryStartedEvent as w, TalkTransport as wt, DiagnosticMessageDeliveryCompletedEvent as x, TalkEventSequencer as xt, DiagnosticMemorySampleEvent as y, TalkEventContext as yt, DiagnosticSessionAttentionClassification as z };