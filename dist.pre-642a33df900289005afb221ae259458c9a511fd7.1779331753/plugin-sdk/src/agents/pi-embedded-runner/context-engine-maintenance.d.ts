import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineMaintenanceResult, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
declare const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY: unique symbol;
type SessionManagerRewriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;
type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> & Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
};
type DeferredTurnMaintenanceAbortState = {
    registered: boolean;
    controllers: Set<AbortController>;
    cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};
export declare function createDeferredTurnMaintenanceAbortSignal(params?: {
    processLike?: DeferredTurnMaintenanceProcessLike;
}): {
    abortSignal?: AbortSignal;
    dispose: () => void;
};
export declare function resetDeferredTurnMaintenanceStateForTest(): void;
/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
export declare function buildContextEngineMaintenanceRuntimeContext(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
    withSessionManagerRewriteLock?: SessionManagerRewriteLock;
    runtimeContext?: ContextEngineRuntimeContext;
    agentId?: string;
    allowDeferredCompactionExecution?: boolean;
    deferTranscriptRewriteToSessionLane?: boolean;
    config?: OpenClawConfig;
    purpose?: string;
    contextEnginePluginId?: string;
}): ContextEngineRuntimeContext;
/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export declare function runContextEngineMaintenance(params: {
    contextEngine?: ContextEngine;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "bootstrap" | "compaction" | "turn";
    sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
    withSessionManagerRewriteLock?: SessionManagerRewriteLock;
    runtimeContext?: ContextEngineRuntimeContext;
    agentId?: string;
    executionMode?: "foreground" | "background";
    onDeferredMaintenance?: (promise: Promise<void>) => void;
    config?: OpenClawConfig;
}): Promise<ContextEngineMaintenanceResult | undefined>;
export {};
