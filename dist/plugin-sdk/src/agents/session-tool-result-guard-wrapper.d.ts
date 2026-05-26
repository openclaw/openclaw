import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type InputProvenance } from "../sessions/input-provenance.js";
type GuardedSessionManager = SessionManager & {
    /** Flush any synthetic tool results for pending tool calls. Idempotent. */
    flushPendingToolResults?: () => void;
    /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
    clearPendingToolResults?: () => void;
};
/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export declare function guardSessionManager(sessionManager: SessionManager, opts?: {
    agentId?: string;
    sessionKey?: string;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    suppressAssistantErrorPersistence?: boolean;
    onUserMessagePersisted?: (message: Extract<AgentMessage, {
        role: "user";
    }>) => void | Promise<void>;
    onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
    onAssistantErrorMessagePersisted?: (message: Extract<AgentMessage, {
        role: "assistant";
    }>) => void | Promise<void>;
}): GuardedSessionManager;
export {};
