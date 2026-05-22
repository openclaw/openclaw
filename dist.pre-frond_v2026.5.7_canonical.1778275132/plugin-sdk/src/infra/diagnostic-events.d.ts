import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type DiagnosticTraceContext } from "./diagnostic-trace-context.js";
export type DiagnosticSessionState = "idle" | "processing" | "waiting";
type DiagnosticBaseEvent = {
    ts: number;
    seq: number;
    trace?: DiagnosticTraceContext;
};
export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
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
export type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
    type: "webhook.received";
    channel: string;
    updateType?: string;
    chatId?: number | string;
};
export type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
    type: "webhook.processed";
    channel: string;
    updateType?: string;
    chatId?: number | string;
    durationMs?: number;
};
export type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
    type: "webhook.error";
    channel: string;
    updateType?: string;
    chatId?: number | string;
    error: string;
};
export type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
    type: "message.queued";
    sessionKey?: string;
    sessionId?: string;
    channel?: string;
    source: string;
    queueDepth?: number;
};
export type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
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
export type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";
type DiagnosticMessageDeliveryBaseEvent = DiagnosticBaseEvent & {
    channel: string;
    sessionKey?: string;
    deliveryKind: DiagnosticMessageDeliveryKind;
};
export type DiagnosticMessageDeliveryStartedEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.started";
};
export type DiagnosticMessageDeliveryCompletedEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.completed";
    durationMs: number;
    resultCount: number;
};
export type DiagnosticMessageDeliveryErrorEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.error";
    durationMs: number;
    errorCategory: string;
};
export type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
    type: "session.state";
    sessionKey?: string;
    sessionId?: string;
    prevState?: DiagnosticSessionState;
    state: DiagnosticSessionState;
    reason?: string;
    queueDepth?: number;
};
export type DiagnosticSessionActiveWorkKind = "embedded_run" | "model_call" | "tool_call";
export type DiagnosticSessionAttentionClassification = "long_running" | "blocked_tool_call" | "stalled_agent_run" | "stale_session_state";
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
export type DiagnosticSessionLongRunningEvent = DiagnosticSessionAttentionBaseEvent & {
    type: "session.long_running";
    classification: "long_running";
};
export type DiagnosticSessionStalledEvent = DiagnosticSessionAttentionBaseEvent & {
    type: "session.stalled";
    classification: "blocked_tool_call" | "stalled_agent_run";
};
export type DiagnosticSessionStuckEvent = DiagnosticSessionAttentionBaseEvent & {
    type: "session.stuck";
    classification: "stale_session_state";
};
export type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
    type: "queue.lane.enqueue";
    lane: string;
    queueSize: number;
};
export type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
    type: "queue.lane.dequeue";
    lane: string;
    queueSize: number;
    waitMs: number;
};
export type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
    type: "run.attempt";
    sessionKey?: string;
    sessionId?: string;
    runId: string;
    attempt: number;
};
export type DiagnosticRunProgressEvent = DiagnosticBaseEvent & {
    type: "run.progress";
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    reason: string;
};
export type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
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
export type DiagnosticContinuationQueueOwnerSample = {
    sessionKey: string;
    pendingQueued: number;
    pendingRunnable: number;
    pendingScheduled: number;
    stagedPostCompaction: number;
    invalidQueued: number;
    totalQueued: number;
    oldestQueuedAgeMs?: number;
    newestQueuedAgeMs?: number;
};
export type DiagnosticContinuationQueueHistoryPoint = {
    sampledAt: number;
    intervalMs?: number;
    totalQueued: number;
    pendingRunnable: number;
    pendingScheduled: number;
    stagedPostCompaction: number;
    invalidQueued: number;
    enqueued: number;
    drained: number;
    failed: number;
};
export type DiagnosticContinuationQueueMetrics = {
    sampledAt: number;
    intervalMs?: number;
    totalQueued: number;
    pendingQueued: number;
    pendingRunnable: number;
    pendingScheduled: number;
    stagedPostCompaction: number;
    invalidQueued: number;
    enqueuedSinceLastSample: number;
    drainedSinceLastSample: number;
    failedSinceLastSample: number;
    enqueueRatePerMinute?: number;
    drainRatePerMinute?: number;
    failedRatePerMinute?: number;
    topQueues: DiagnosticContinuationQueueOwnerSample[];
    queueDepthHistory: DiagnosticContinuationQueueHistoryPoint[];
};
export type DiagnosticContinuationQueueSampleEvent = DiagnosticBaseEvent & {
    type: "diagnostic.continuation_queue.sample";
    continuationQueue: DiagnosticContinuationQueueMetrics;
};
export type DiagnosticLivenessWarningReason = "event_loop_delay" | "event_loop_utilization" | "cpu";
export type DiagnosticPhaseDetails = Record<string, string | number | boolean>;
export type DiagnosticPhaseSnapshot = {
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
export type DiagnosticLivenessWarningEvent = DiagnosticBaseEvent & {
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
    continuationQueue?: DiagnosticContinuationQueueMetrics;
};
export type DiagnosticPhaseCompletedEvent = DiagnosticBaseEvent & DiagnosticPhaseSnapshot & {
    type: "diagnostic.phase.completed";
};
export type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
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
export type DiagnosticToolParamsSummary = {
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
export type DiagnosticToolExecutionStartedEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.started";
};
export type DiagnosticToolExecutionCompletedEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.completed";
    durationMs: number;
};
export type DiagnosticToolExecutionErrorEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.error";
    durationMs: number;
    errorCategory: string;
    errorCode?: string;
};
export type DiagnosticToolExecutionBlockedEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.blocked";
    deniedReason: string;
    reason: string;
};
export type DiagnosticExecProcessCompletedEvent = DiagnosticBaseEvent & {
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
export type DiagnosticRunFireReason = "timer" | "external-trigger" | "continuation-chain";
type DiagnosticRunBaseEvent = DiagnosticBaseEvent & {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    trigger?: string;
    channel?: string;
    fireReason?: DiagnosticRunFireReason;
    parentRunId?: string;
};
export type DiagnosticRunStartedEvent = DiagnosticRunBaseEvent & {
    type: "run.started";
};
export type DiagnosticRunCompletedEvent = DiagnosticRunBaseEvent & {
    type: "run.completed";
    durationMs: number;
    outcome: "completed" | "aborted" | "error";
    errorCategory?: string;
};
export type DiagnosticHarnessRunPhase = "prepare" | "start" | "send" | "resolve" | "cleanup";
export type DiagnosticHarnessRunOutcome = "completed" | "aborted" | "timed_out" | "error";
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
export type DiagnosticHarnessRunStartedEvent = DiagnosticHarnessRunBaseEvent & {
    type: "harness.run.started";
};
export type DiagnosticHarnessRunCompletedEvent = DiagnosticHarnessRunBaseEvent & {
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
export type DiagnosticHarnessRunErrorEvent = DiagnosticHarnessRunBaseEvent & {
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
export type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.started";
};
export type DiagnosticModelCallCompletedEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.completed";
    durationMs: number;
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
};
export type DiagnosticModelCallErrorEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.error";
    durationMs: number;
    errorCategory: string;
    failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
    memory?: DiagnosticMemoryUsage;
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
};
export type DiagnosticContextAssembledEvent = DiagnosticBaseEvent & {
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
export type DiagnosticMemoryUsage = {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
};
export type DiagnosticMemorySampleEvent = DiagnosticBaseEvent & {
    type: "diagnostic.memory.sample";
    memory: DiagnosticMemoryUsage;
    uptimeMs?: number;
};
export type DiagnosticMemoryPressureEvent = DiagnosticBaseEvent & {
    type: "diagnostic.memory.pressure";
    level: "warning" | "critical";
    reason: "rss_threshold" | "heap_threshold" | "rss_growth";
    memory: DiagnosticMemoryUsage;
    thresholdBytes?: number;
    rssGrowthBytes?: number;
    windowMs?: number;
};
export type DiagnosticPayloadLargeEvent = DiagnosticBaseEvent & {
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
export type DiagnosticLogRecordEvent = DiagnosticBaseEvent & {
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
export type DiagnosticTelemetryExporterEvent = DiagnosticBaseEvent & {
    type: "telemetry.exporter";
    exporter: string;
    signal: "traces" | "metrics" | "logs";
    status: "started" | "failure" | "dropped";
    reason?: "configured" | "emit_failed" | "handler_failed" | "queue_full" | "shutdown_failed" | "start_failed" | "unsupported_protocol";
    errorCategory?: string;
};
export type DiagnosticEventPayload = DiagnosticUsageEvent | DiagnosticWebhookReceivedEvent | DiagnosticWebhookProcessedEvent | DiagnosticWebhookErrorEvent | DiagnosticMessageQueuedEvent | DiagnosticMessageProcessedEvent | DiagnosticMessageDeliveryStartedEvent | DiagnosticMessageDeliveryCompletedEvent | DiagnosticMessageDeliveryErrorEvent | DiagnosticSessionStateEvent | DiagnosticSessionLongRunningEvent | DiagnosticSessionStalledEvent | DiagnosticSessionStuckEvent | DiagnosticLaneEnqueueEvent | DiagnosticLaneDequeueEvent | DiagnosticRunAttemptEvent | DiagnosticRunProgressEvent | DiagnosticHeartbeatEvent | DiagnosticContinuationQueueSampleEvent | DiagnosticLivenessWarningEvent | DiagnosticPhaseCompletedEvent | DiagnosticToolLoopEvent | DiagnosticToolExecutionStartedEvent | DiagnosticToolExecutionCompletedEvent | DiagnosticToolExecutionErrorEvent | DiagnosticToolExecutionBlockedEvent | DiagnosticExecProcessCompletedEvent | DiagnosticRunStartedEvent | DiagnosticRunCompletedEvent | DiagnosticHarnessRunStartedEvent | DiagnosticHarnessRunCompletedEvent | DiagnosticHarnessRunErrorEvent | DiagnosticModelCallStartedEvent | DiagnosticModelCallCompletedEvent | DiagnosticModelCallErrorEvent | DiagnosticContextAssembledEvent | DiagnosticMemorySampleEvent | DiagnosticMemoryPressureEvent | DiagnosticPayloadLargeEvent | DiagnosticLogRecordEvent | DiagnosticTelemetryExporterEvent;
export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event ? Event extends DiagnosticEventPayload ? Omit<Event, "seq" | "ts"> : never : never;
export type DiagnosticEventMetadata = Readonly<{
    trusted: boolean;
}>;
type DiagnosticEventListener = (evt: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void;
export declare function isDiagnosticsEnabled(config?: OpenClawConfig): boolean;
export declare function setDiagnosticsEnabledForProcess(enabled: boolean): void;
export declare function areDiagnosticsEnabledForProcess(): boolean;
export declare function emitDiagnosticEvent(event: DiagnosticEventInput): void;
export declare function emitTrustedDiagnosticEvent(event: DiagnosticEventInput): void;
export declare function onInternalDiagnosticEvent(listener: DiagnosticEventListener): () => void;
export declare function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void;
export declare function formatDiagnosticTraceparentForPropagation(event: {
    trace?: DiagnosticTraceContext;
}, metadata: DiagnosticEventMetadata): string | undefined;
export declare function resetDiagnosticEventsForTest(): void;
export {};
