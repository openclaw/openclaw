import type { VerboseLevel } from "../auto-reply/thinking.js";
export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | "item" | "plan" | "approval" | "command_output" | "patch" | "compaction" | "thinking" | (string & {});
export type AgentItemEventPhase = "start" | "update" | "end";
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
export type AgentItemEventKind = "tool" | "command" | "patch" | "search" | "analysis" | (string & {});
export type AgentItemEventData = {
    itemId: string;
    phase: AgentItemEventPhase;
    kind: AgentItemEventKind;
    title: string;
    status: AgentItemEventStatus;
    name?: string;
    meta?: string;
    toolCallId?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
    summary?: string;
    progressText?: string;
    /** Preserve item telemetry while letting channel progress render a sibling tool event instead. */
    suppressChannelProgress?: boolean;
    approvalId?: string;
    approvalSlug?: string;
};
export type AgentPlanEventData = {
    phase: "update";
    title: string;
    explanation?: string;
    steps?: string[];
    source?: string;
};
export type AgentApprovalEventPhase = "requested" | "resolved";
export type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";
export type AgentApprovalEventData = {
    phase: AgentApprovalEventPhase;
    kind: AgentApprovalEventKind;
    status: AgentApprovalEventStatus;
    title: string;
    itemId?: string;
    toolCallId?: string;
    approvalId?: string;
    approvalSlug?: string;
    command?: string;
    host?: string;
    reason?: string;
    scope?: "turn" | "session";
    message?: string;
};
export type AgentCommandOutputEventData = {
    itemId: string;
    phase: "delta" | "end";
    title: string;
    toolCallId: string;
    name?: string;
    output?: string;
    status?: AgentItemEventStatus | "running";
    exitCode?: number | null;
    durationMs?: number;
    cwd?: string;
};
export type AgentPatchSummaryEventData = {
    itemId: string;
    phase: "end";
    title: string;
    toolCallId: string;
    name?: string;
    added: string[];
    modified: string[];
    deleted: string[];
    summary: string;
};
export type AgentEventPayload = {
    runId: string;
    seq: number;
    stream: AgentEventStream;
    ts: number;
    data: Record<string, unknown>;
    sessionKey?: string;
};
export type AgentRunContext = {
    sessionKey?: string;
    verboseLevel?: VerboseLevel;
    isHeartbeat?: boolean;
    /** Whether control UI clients should receive chat/agent updates for this run. */
    isControlUiVisible?: boolean;
    /** Timestamp when this context was first registered (for TTL-based cleanup). */
    registeredAt?: number;
    /** Timestamp of last activity (updated on every emitAgentEvent). */
    lastActiveAt?: number;
};
export declare function registerAgentRunContext(runId: string, context: AgentRunContext): void;
export declare function getAgentRunContext(runId: string): AgentRunContext | undefined;
export declare function clearAgentRunContext(runId: string): void;
/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export declare function sweepStaleRunContexts(maxAgeMs?: number): number;
export declare function resetAgentRunContextForTest(): void;
export declare function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">): void;
export declare function emitAgentItemEvent(params: {
    runId: string;
    data: AgentItemEventData;
    sessionKey?: string;
}): void;
export declare function emitAgentPlanEvent(params: {
    runId: string;
    data: AgentPlanEventData;
    sessionKey?: string;
}): void;
export declare function emitAgentApprovalEvent(params: {
    runId: string;
    data: AgentApprovalEventData;
    sessionKey?: string;
}): void;
export declare function emitAgentCommandOutputEvent(params: {
    runId: string;
    data: AgentCommandOutputEventData;
    sessionKey?: string;
}): void;
export declare function emitAgentPatchSummaryEvent(params: {
    runId: string;
    data: AgentPatchSummaryEventData;
    sessionKey?: string;
}): void;
export declare function onAgentEvent(listener: (evt: AgentEventPayload) => void): () => void;
export declare function resetAgentEventsForTest(): void;
