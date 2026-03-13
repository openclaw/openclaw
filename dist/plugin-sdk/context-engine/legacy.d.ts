import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineInfo, AssembleResult, CompactResult, ContextEngineRuntimeContext, IngestResult } from "./types.js";
/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export declare class LegacyContextEngine implements ContextEngine {
    readonly info: ContextEngineInfo;
    ingest(_params: {
        sessionId: string;
        sessionKey?: string;
        message: AgentMessage;
        isHeartbeat?: boolean;
    }): Promise<IngestResult>;
    assemble(params: {
        sessionId: string;
        sessionKey?: string;
        messages: AgentMessage[];
        tokenBudget?: number;
    }): Promise<AssembleResult>;
    afterTurn(_params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        messages: AgentMessage[];
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
        runtimeContext?: ContextEngineRuntimeContext;
    }): Promise<void>;
    compact(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        currentTokenCount?: number;
        compactionTarget?: "budget" | "threshold";
        customInstructions?: string;
        runtimeContext?: ContextEngineRuntimeContext;
    }): Promise<CompactResult>;
    dispose(): Promise<void>;
}
export declare function registerLegacyContextEngine(): void;
