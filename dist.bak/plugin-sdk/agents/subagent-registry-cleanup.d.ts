import { type SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export type DeferredCleanupDecision = {
    kind: "defer-descendants";
    delayMs: number;
} | {
    kind: "give-up";
    reason: "retry-limit" | "expiry";
    retryCount?: number;
} | {
    kind: "retry";
    retryCount: number;
    resumeDelayMs?: number;
};
export declare function resolveCleanupCompletionReason(entry: SubagentRunRecord): SubagentLifecycleEndedReason;
export declare function resolveDeferredCleanupDecision(params: {
    entry: SubagentRunRecord;
    now: number;
    activeDescendantRuns: number;
    announceExpiryMs: number;
    maxAnnounceRetryCount: number;
    deferDescendantDelayMs: number;
    resolveAnnounceRetryDelayMs: (retryCount: number) => number;
}): DeferredCleanupDecision;
