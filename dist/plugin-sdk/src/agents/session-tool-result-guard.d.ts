import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { redactToolPayloadTextWithConfig } from "../logging/redact.js";
import type { PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult } from "../plugins/types.js";
import { getRawSessionAppendMessage } from "./session-raw-append-message.js";
type ToolResultDetailRedactionConfig = Parameters<typeof redactToolPayloadTextWithConfig>[1];
export { getRawSessionAppendMessage };
export declare function installSessionToolResultGuard(sessionManager: SessionManager, opts?: {
    /** Optional session key for transcript update broadcasts. */
    sessionKey?: string;
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (message: AgentMessage, meta: {
        toolCallId?: string;
        toolName?: string;
        isSynthetic?: boolean;
    }) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (event: PluginHookBeforeMessageWriteEvent) => PluginHookBeforeMessageWriteResult | undefined;
    redactLoggingConfig?: ToolResultDetailRedactionConfig;
    maxToolResultChars?: number;
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
}): {
    flushPendingToolResults: () => void;
    clearPendingToolResults: () => void;
    getPendingIds: () => string[];
};
