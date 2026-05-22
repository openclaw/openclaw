import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../context-engine/registry.js";
import type { ContextEngine } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type RegisterSubagentRunParams } from "./subagent-registry-run-manager.js";
import { getSubagentRunsSnapshotForRead, persistSubagentRunsToDisk, restoreSubagentRunsFromDisk } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";
export { getSubagentSessionRuntimeMs, getSubagentSessionStartedAt, resolveSubagentSessionStatus, } from "./subagent-registry-helpers.js";
type SubagentAnnounceModule = Pick<typeof import("./subagent-announce.js"), "captureSubagentCompletionReply" | "runSubagentAnnounceFlow">;
type SubagentRegistryDeps = {
    callGateway: typeof callGateway;
    captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
    cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
    getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
    getRuntimeConfig: typeof getRuntimeConfig;
    onAgentEvent: typeof onAgentEvent;
    persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
    resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
    restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
    runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
    ensureContextEnginesInitialized?: () => void;
    ensureRuntimePluginsLoaded?: typeof ensureRuntimePluginsLoadedFn;
    resolveContextEngine?: (cfg?: OpenClawConfig, options?: ResolveContextEngineOptions) => Promise<ContextEngine>;
};
export declare function scheduleSubagentOrphanRecovery(params?: {
    delayMs?: number;
    maxRetries?: number;
}): void;
export declare function markSubagentRunForSteerRestart(runId: string): boolean;
export declare function clearSubagentRunSteerRestart(runId: string): boolean;
export declare function replaceSubagentRunAfterSteer(params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
}): boolean;
export declare function registerSubagentRun(params: RegisterSubagentRunParams): void;
export declare function resetSubagentRegistryForTests(opts?: {
    persist?: boolean;
}): void;
export declare const __testing: {
    readonly sweepOnceForTests: () => Promise<void>;
    readonly setDepsForTest: (overrides?: Partial<SubagentRegistryDeps>) => void;
};
export declare function addSubagentRunForTests(entry: SubagentRunRecord): void;
export declare function releaseSubagentRun(runId: string): void;
export declare function finalizeInterruptedSubagentRun(params: {
    runId?: string;
    childSessionKey?: string;
    error: string;
    endedAt?: number;
}): Promise<number>;
export declare function resolveRequesterForChildSession(childSessionKey: string): {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
} | null;
export declare function isSubagentSessionRunActive(childSessionKey: string): boolean;
export declare function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean;
export declare function markSubagentRunTerminated(params: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
}): number;
export declare function listSubagentRunsForRequester(requesterSessionKey: string, options?: {
    requesterRunId?: string;
}): SubagentRunRecord[];
export declare function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[];
export declare function countActiveRunsForSession(requesterSessionKey: string): number;
export declare function countActiveDescendantRuns(rootSessionKey: string): number;
export declare function countPendingDescendantRuns(rootSessionKey: string): number;
export declare function countPendingDescendantRunsExcludingRun(rootSessionKey: string, excludeRunId: string): number;
export declare function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[];
export declare function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
export declare function getLatestSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
export declare function initSubagentRegistry(): void;
