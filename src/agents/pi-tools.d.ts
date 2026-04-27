import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type { ModelAuthMode } from "./model-auth.js";
import { assertRequiredParams, getToolParamsRecord, wrapToolParamValidation } from "./pi-tools.read.js";
import { cleanToolSchemaForGemini } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
declare function applyModelProviderToolPolicy(tools: AnyAgentTool[], params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelId?: string;
    agentDir?: string;
    modelCompat?: ModelCompatConfig;
}): AnyAgentTool[];
export declare function resolveToolLoopDetectionConfig(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): ToolLoopDetectionConfig | undefined;
export declare const __testing: {
    readonly cleanToolSchemaForGemini: typeof cleanToolSchemaForGemini;
    readonly getToolParamsRecord: typeof getToolParamsRecord;
    readonly wrapToolParamValidation: typeof wrapToolParamValidation;
    readonly assertRequiredParams: typeof assertRequiredParams;
    readonly applyModelProviderToolPolicy: typeof applyModelProviderToolPolicy;
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
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /** Stable run identifier for this agent invocation. */
    runId?: string;
    /** Diagnostic trace context for hook/log correlation during this run. */
    trace?: DiagnosticTraceContext;
    /** What initiated this run (for trigger-specific tool restrictions). */
    trigger?: string;
    /** Relative workspace path that memory-triggered writes may append to. */
    memoryFlushWritePath?: string;
    agentDir?: string;
    workspaceDir?: string;
    /**
     * Workspace directory that spawned subagents should inherit.
     * When sandboxing uses a copied workspace (`ro` or `none`), workspaceDir is the
     * sandbox copy but subagents should inherit the real agent workspace instead.
     * Defaults to workspaceDir when not set.
     */
    spawnWorkspaceDir?: string;
    config?: OpenClawConfig;
    abortSignal?: AbortSignal;
    /**
     * Provider of the currently selected model (used for provider-specific tool quirks).
     * Example: "anthropic", "openai", "google", "openai-codex".
     */
    modelProvider?: string;
    /** Model id for the current provider (used for model-specific tool gating). */
    modelId?: string;
    /** Model API for the current provider (used for provider-native tool arbitration). */
    modelApi?: string;
    /** Model context window in tokens (used to scale read-tool output budget). */
    modelContextWindowTokens?: number;
    /** Resolved runtime model compatibility hints. */
    modelCompat?: ModelCompatConfig;
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
    /** Trusted provider role ids for the requester in this group turn. */
    memberRoleIds?: string[];
    /** Parent session key for subagent group policy inheritance. */
    spawnedBy?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
    /** Reply-to mode for Slack auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: {
        value: boolean;
    };
    /** Allow plugin tools for this run to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** Keep the message tool available even when the selected profile omits it. */
    forceMessageTool?: boolean;
    /** Whether the sender is an owner (required for owner-only tools). */
    senderIsOwner?: boolean;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool[];
export {};
