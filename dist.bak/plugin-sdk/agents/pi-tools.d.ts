import type { OpenClawConfig } from "../config/config.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { type ExecToolDefaults, type ProcessToolDefaults } from "./bash-tools.js";
import type { ModelAuthMode } from "./model-auth.js";
import { assertRequiredParams, normalizeToolParams, patchToolSchemaForClaudeCompatibility, wrapToolParamNormalization } from "./pi-tools.read.js";
import { cleanToolSchemaForGemini } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
export declare function resolveToolLoopDetectionConfig(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): ToolLoopDetectionConfig | undefined;
export declare const __testing: {
    readonly cleanToolSchemaForGemini: typeof cleanToolSchemaForGemini;
    readonly normalizeToolParams: typeof normalizeToolParams;
    readonly patchToolSchemaForClaudeCompatibility: typeof patchToolSchemaForClaudeCompatibility;
    readonly wrapToolParamNormalization: typeof wrapToolParamNormalization;
    readonly assertRequiredParams: typeof assertRequiredParams;
};
export declare function createOpenClawCodingTools(options?: {
    agentId?: string;
    exec?: ExecToolDefaults & ProcessToolDefaults;
    messageProvider?: string;
    agentAccountId?: string;
    messageTo?: string;
    messageThreadId?: string | number;
    sandbox?: SandboxContext | null;
    sessionKey?: string;
    agentDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
    abortSignal?: AbortSignal;
    /**
     * Provider of the currently selected model (used for provider-specific tool quirks).
     * Example: "anthropic", "openai", "google", "openai-codex".
     */
    modelProvider?: string;
    /** Model id for the current provider (used for model-specific tool gating). */
    modelId?: string;
    /** Model context window in tokens (used to scale read-tool output budget). */
    modelContextWindowTokens?: number;
    /**
     * Auth mode for the current provider. We only need this for Anthropic OAuth
     * tool-name blocking quirks.
     */
    modelAuthMode?: ModelAuthMode;
    /** Current channel ID for auto-threading (Slack). */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading (Slack). */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks (e.g. Telegram react). */
    currentMessageId?: string | number;
    /** Group id for channel-level tool policy resolution. */
    groupId?: string | null;
    /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
    groupChannel?: string | null;
    /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
    groupSpace?: string | null;
    /** Parent session key for subagent group policy inheritance. */
    spawnedBy?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
    /** Reply-to mode for Slack auto-threading. */
    replyToMode?: "off" | "first" | "all";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: {
        value: boolean;
    };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** Whether the sender is an owner (required for owner-only tools). */
    senderIsOwner?: boolean;
}): AnyAgentTool[];
