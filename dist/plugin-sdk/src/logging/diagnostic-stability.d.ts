import { type DiagnosticEventPayload, type DiagnosticMemoryUsage } from "../infra/diagnostic-events.js";
export declare const MAX_DIAGNOSTIC_STABILITY_LIMIT = 1000;
export type DiagnosticStabilityEventRecord = {
    seq: number;
    ts: number;
    type: DiagnosticEventPayload["type"];
    channel?: string;
    pluginId?: string;
    source?: string;
    target?: string;
    surface?: string;
    action?: string;
    reason?: string;
    outcome?: string;
    mode?: string;
    level?: string;
    phase?: string;
    detector?: string;
    deliveryKind?: string;
    talkEventType?: string;
    transport?: string;
    brain?: string;
    toolName?: string;
    activeWorkKind?: string;
    pairedToolName?: string;
    provider?: string;
    model?: string;
    durationMs?: number;
    requestBytes?: number;
    responseBytes?: number;
    timeToFirstByteMs?: number;
    resultCount?: number;
    commandLength?: number;
    exitCode?: number;
    timedOut?: boolean;
    final?: boolean;
    costUsd?: number;
    count?: number;
    bytes?: number;
    limitBytes?: number;
    thresholdBytes?: number;
    rssGrowthBytes?: number;
    windowMs?: number;
    eventLoopDelayP99Ms?: number;
    eventLoopDelayMaxMs?: number;
    eventLoopUtilization?: number;
    cpuCoreRatio?: number;
    ageMs?: number;
    queueDepth?: number;
    queueSize?: number;
    queueLength?: number;
    waitMs?: number;
    failureKind?: string;
    active?: number;
    waiting?: number;
    queued?: number;
    droppedEvents?: number;
    droppedTrustedEvents?: number;
    droppedUntrustedEvents?: number;
    droppedPriorityEvents?: number;
    maxQueueLength?: number;
    drainBatchSize?: number;
    webhooks?: {
        received: number;
        processed: number;
        errors: number;
    };
    memory?: DiagnosticMemoryUsage;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        promptTokens?: number;
        total?: number;
    };
    context?: {
        limit?: number;
        used?: number;
    };
};
export type DiagnosticStabilitySnapshot = {
    generatedAt: string;
    capacity: number;
    count: number;
    dropped: number;
    firstSeq?: number;
    lastSeq?: number;
    events: DiagnosticStabilityEventRecord[];
    summary: {
        byType: Record<string, number>;
        memory?: {
            latest?: DiagnosticMemoryUsage;
            maxRssBytes?: number;
            maxHeapUsedBytes?: number;
            pressureCount: number;
        };
        payloadLarge?: {
            count: number;
            rejected: number;
            truncated: number;
            chunked: number;
            bySurface: Record<string, number>;
        };
    };
};
type DiagnosticStabilityQueryInput = {
    limit?: unknown;
    type?: unknown;
    sinceSeq?: unknown;
};
type NormalizedDiagnosticStabilityQuery = {
    limit: number;
    type: string | undefined;
    sinceSeq: number | undefined;
};
export declare function normalizeDiagnosticStabilityQuery(input?: DiagnosticStabilityQueryInput, options?: {
    defaultLimit?: number;
}): NormalizedDiagnosticStabilityQuery;
export declare function startDiagnosticStabilityRecorder(): void;
export declare function stopDiagnosticStabilityRecorder(): void;
export declare function getDiagnosticStabilitySnapshot(options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
}): DiagnosticStabilitySnapshot;
export declare function selectDiagnosticStabilitySnapshot(snapshot: DiagnosticStabilitySnapshot, options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
}): DiagnosticStabilitySnapshot;
export declare function resetDiagnosticStabilityRecorderForTest(): void;
export {};
