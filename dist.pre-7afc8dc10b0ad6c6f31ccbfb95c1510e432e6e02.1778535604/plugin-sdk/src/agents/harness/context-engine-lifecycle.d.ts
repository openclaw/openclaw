import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { buildAfterTurnRuntimeContext, buildAfterTurnRuntimeContextFromUsage } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import type { SessionWriteLockAcquireTimeoutConfig } from "../session-write-lock.js";
export type HarnessContextEngine = ContextEngine;
/**
 * Run optional bootstrap + bootstrap maintenance for a harness-owned context engine.
 */
export declare function bootstrapHarnessContextEngine(params: {
    hadSessionFile: boolean;
    contextEngine?: HarnessContextEngine;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    sessionManager?: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
    runMaintenance?: typeof runHarnessContextEngineMaintenance;
    config?: SessionWriteLockAcquireTimeoutConfig;
    warn: (message: string) => void;
}): Promise<void>;
/**
 * Assemble model context through the active harness-owned context engine.
 */
export declare function assembleHarnessContextEngine(params: {
    contextEngine?: HarnessContextEngine;
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    modelId: string;
    prompt?: string;
}): Promise<import("../../context-engine/types.js").AssembleResult | undefined>;
/**
 * Finalize a completed harness turn via afterTurn or ingest fallbacks.
 */
export declare function finalizeHarnessContextEngineTurn(params: {
    contextEngine?: HarnessContextEngine;
    promptError: boolean;
    aborted: boolean;
    yieldAborted: boolean;
    sessionIdUsed: string;
    sessionKey?: string;
    sessionFile: string;
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
    runMaintenance?: typeof runHarnessContextEngineMaintenance;
    sessionManager?: unknown;
    config?: SessionWriteLockAcquireTimeoutConfig;
    warn: (message: string) => void;
}): Promise<{
    postTurnFinalizationSucceeded: boolean;
}>;
/**
 * Build runtime context passed into harness context-engine hooks.
 */
export declare function buildHarnessContextEngineRuntimeContext(params: Parameters<typeof buildAfterTurnRuntimeContext>[0]): ContextEngineRuntimeContext;
/**
 * Build runtime context passed into harness context-engine hooks from usage data.
 */
export declare function buildHarnessContextEngineRuntimeContextFromUsage(params: Parameters<typeof buildAfterTurnRuntimeContextFromUsage>[0]): ContextEngineRuntimeContext;
/**
 * Run optional transcript maintenance for a harness-owned context engine.
 */
export declare function runHarnessContextEngineMaintenance(params: {
    contextEngine?: HarnessContextEngine;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "bootstrap" | "compaction" | "turn";
    sessionManager?: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
    executionMode?: "foreground" | "background";
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<import("../../context-engine/types.js").TranscriptRewriteResult | undefined>;
/**
 * Return true when a non-legacy context engine should affect plugin harness behavior.
 */
export declare function isActiveHarnessContextEngine(contextEngine: ContextEngine | undefined): contextEngine is ContextEngine;
