import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
export declare function sanitizeToolsForGoogle<TSchemaType extends TSchema = TSchema, TResult = unknown>(params: {
    tools: AgentTool<TSchemaType, TResult>[];
    provider: string;
}): AgentTool<TSchemaType, TResult>[];
export declare function logToolSchemasForGoogle(params: {
    tools: AgentTool[];
    provider: string;
}): void;
export type CompactionFailureListener = (reason: string) => void;
/**
 * Register a listener for unhandled compaction failures.
 * Called when auto-compaction fails in a way that escapes the normal try-catch,
 * e.g., when the summarization request itself exceeds the model's token limit.
 * Returns an unsubscribe function.
 */
export declare function onUnhandledCompactionFailure(cb: CompactionFailureListener): () => void;
export declare function applyGoogleTurnOrderingFix(params: {
    messages: AgentMessage[];
    modelApi?: string | null;
    sessionManager: SessionManager;
    sessionId: string;
    warn?: (message: string) => void;
}): {
    messages: AgentMessage[];
    didPrepend: boolean;
};
export declare function sanitizeSessionHistory(params: {
    messages: AgentMessage[];
    modelApi?: string | null;
    modelId?: string;
    provider?: string;
    allowedToolNames?: Iterable<string>;
    config?: OpenClawConfig;
    sessionManager: SessionManager;
    sessionId: string;
    policy?: TranscriptPolicy;
}): Promise<AgentMessage[]>;
