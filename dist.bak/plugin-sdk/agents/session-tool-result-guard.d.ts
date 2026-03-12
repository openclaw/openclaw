import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult } from "../plugins/types.js";
export declare function installSessionToolResultGuard(sessionManager: SessionManager, opts?: {
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
}): {
    flushPendingToolResults: () => void;
    getPendingIds: () => string[];
};
