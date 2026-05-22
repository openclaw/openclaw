import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome } from "./subagent-announce-output.js";
import { type SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function markSubagentRunPausedAfterYield(params: {
    entry: SubagentRunRecord;
    startedAt?: number;
    endedAt?: number;
    now?: number;
}): boolean;
export type RegisterSubagentRunParams = {
    runId: string;
    childSessionKey: string;
    controllerSessionKey?: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    requesterDisplayKey: string;
    task: string;
    cleanup: "delete" | "keep";
    label?: string;
    model?: string;
    agentDir?: string;
    workspaceDir?: string;
    runTimeoutSeconds?: number;
    expectsCompletionMessage?: boolean;
    spawnMode?: "run" | "session";
    attachmentsDir?: string;
    attachmentsRootDir?: string;
    retainAttachmentsOnKeep?: boolean;
};
export declare function createSubagentRunManager(params: {
    runs: Map<string, SubagentRunRecord>;
    resumedRuns: Set<string>;
    endedHookInFlightRunIds: Set<string>;
    persist(): void;
    callGateway: typeof callGateway;
    getRuntimeConfig: typeof getRuntimeConfig;
    ensureRuntimePluginsLoaded: typeof ensureRuntimePluginsLoadedFn | ((args: {
        config: OpenClawConfig;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
    }) => void | Promise<void>);
    ensureListener(): void;
    startSweeper(): void;
    stopSweeper(): void;
    resumeSubagentRun(runId: string): void;
    clearPendingLifecycleError(runId: string): void;
    resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
    scheduleOrphanRecovery(args?: {
        delayMs?: number;
        maxRetries?: number;
    }): void;
    notifyContextEngineSubagentEnded(args: {
        childSessionKey: string;
        reason: "completed" | "deleted" | "released";
        agentDir?: string;
        workspaceDir?: string;
    }): Promise<void>;
    completeCleanupBookkeeping(args: {
        runId: string;
        entry: SubagentRunRecord;
        cleanup: "delete" | "keep";
        completedAt: number;
    }): void;
    completeSubagentRun(args: {
        runId: string;
        endedAt?: number;
        outcome: SubagentRunOutcome;
        reason: SubagentLifecycleEndedReason;
        sendFarewell?: boolean;
        accountId?: string;
        triggerCleanup: boolean;
    }): Promise<void>;
}): {
    clearSubagentRunSteerRestart: (runId: string) => boolean;
    markSubagentRunForSteerRestart: (runId: string) => boolean;
    markSubagentRunTerminated: (markParams: {
        runId?: string;
        childSessionKey?: string;
        reason?: string;
    }) => number;
    registerSubagentRun: (registerParams: RegisterSubagentRunParams) => void;
    releaseSubagentRun: (runId: string) => void;
    replaceSubagentRunAfterSteer: (replaceParams: {
        previousRunId: string;
        nextRunId: string;
        fallback?: SubagentRunRecord;
        runTimeoutSeconds?: number;
        preserveFrozenResultFallback?: boolean;
    }) => boolean;
    waitForSubagentCompletion: (runId: string, waitTimeoutMs: number, expectedEntry?: SubagentRunRecord) => Promise<void>;
};
