import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";
export type EmbeddedPiAgentMeta = {
    sessionId: string;
    provider: string;
    model: string;
    compactionCount?: number;
    promptTokens?: number;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
    /**
     * Usage from the last individual API call (not accumulated across tool-use
     * loops or compaction retries). Used for context-window utilization display
     * (`totalTokens` in sessions.json) because the accumulated `usage.input`
     * sums input tokens from every API call in the run, which overstates the
     * actual context size.
     */
    lastCallUsage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
};
export type EmbeddedPiRunMeta = {
    durationMs: number;
    agentMeta?: EmbeddedPiAgentMeta;
    aborted?: boolean;
    systemPromptReport?: SessionSystemPromptReport;
    error?: {
        kind: "context_overflow" | "compaction_failure" | "role_ordering" | "image_size" | "retry_limit";
        message: string;
    };
    /** Stop reason for the agent run (e.g., "completed", "tool_calls"). */
    stopReason?: string;
    /** Pending tool calls when stopReason is "tool_calls". */
    pendingToolCalls?: Array<{
        id: string;
        name: string;
        arguments: string;
    }>;
};
export type EmbeddedPiRunResult = {
    payloads?: Array<{
        text?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        replyToId?: string;
        isError?: boolean;
    }>;
    meta: EmbeddedPiRunMeta;
    didSendViaMessagingTool?: boolean;
    messagingToolSentTexts?: string[];
    messagingToolSentMediaUrls?: string[];
    messagingToolSentTargets?: MessagingToolSend[];
    successfulCronAdds?: number;
};
export type EmbeddedPiCompactResult = {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        tokensAfter?: number;
        details?: unknown;
    };
};
export type EmbeddedSandboxInfo = {
    enabled: boolean;
    workspaceDir?: string;
    containerWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserBridgeUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    elevated?: {
        allowed: boolean;
        defaultLevel: "on" | "off" | "ask" | "full";
    };
};
