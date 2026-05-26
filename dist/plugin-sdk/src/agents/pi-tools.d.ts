import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type { ModelAuthMode } from "./model-auth.js";
import { type ToolOutcomeObserver } from "./pi-tools.before-tool-call.js";
import { assertRequiredParams, getToolParamsRecord, wrapToolParamValidation } from "./pi-tools.read.js";
import { cleanToolSchemaForGemini } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import type { SkillSnapshot } from "./skills/types.js";
import { type ToolSearchCatalogRef, type ToolSearchCatalogToolExecutor } from "./tool-search.js";
import type { MediaGenerateAsyncStartCallback } from "./tools/media-generate-background-shared.js";
export declare function resolveProcessToolScopeKey(params: {
    scopeKey?: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
}): string | undefined;
declare function applyModelProviderToolPolicy(tools: AnyAgentTool[], params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelId?: string;
    agentId?: string;
    sessionKey?: string;
    agentDir?: string;
    modelCompat?: ModelCompatConfig;
    suppressManagedWebSearch?: boolean;
}): AnyAgentTool[];
export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
export declare const testing: {
    readonly cleanToolSchemaForGemini: typeof cleanToolSchemaForGemini;
    readonly getToolParamsRecord: typeof getToolParamsRecord;
    readonly wrapToolParamValidation: typeof wrapToolParamValidation;
    readonly assertRequiredParams: typeof assertRequiredParams;
    readonly applyModelProviderToolPolicy: typeof applyModelProviderToolPolicy;
};
export type OpenClawCodingToolConstructionPlan = {
    includeBaseCodingTools: boolean;
    includeShellTools: boolean;
    includeChannelTools: boolean;
    includeOpenClawTools: boolean;
    includePluginTools: boolean;
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
    /**
     * The actual live run session key. When the tool set is constructed with a
     * sandbox/policy session key, this allows `session_status({sessionKey:"current"})`
     * to resolve to the live run session instead of the stale sandbox key.
     */
    runSessionKey?: string;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /** Stable run identifier for this agent invocation. */
    runId?: string;
    /** Diagnostic trace context for hook/log correlation during this run. */
    trace?: DiagnosticTraceContext;
    /** What initiated this run (for trigger-specific tool restrictions). */
    trigger?: string;
    /** Stable cron job identifier populated for cron-triggered runs. */
    jobId?: string;
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
    /** Disable hook-owned diagnostics when an outer runtime owns tool diagnostics. */
    emitBeforeToolCallDiagnostics?: boolean;
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
    /** If false, keep OpenClaw web_search even when a provider-native search tool is active. */
    suppressManagedWebSearch?: boolean;
    /**
     * Auth mode for the current provider. We only need this for Anthropic OAuth
     * tool-name blocking quirks.
     */
    modelAuthMode?: ModelAuthMode;
    /** Current channel ID for auto-threading (Slack). */
    currentChannelId?: string;
    /** Normalized conversation id exposed to tool hooks. Defaults to currentChannelId. */
    hookChannelId?: string;
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
    /** Runtime-scoped explicit allowlist used to materialize matching plugin tools. */
    runtimeToolAllowlist?: string[];
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** Visible source replies must be sent through the message tool when set to message_tool_only. */
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    inboundEventKind?: InboundEventKind;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** Keep the message tool available even when the selected profile omits it. */
    forceMessageTool?: boolean;
    /** Include the heartbeat response tool for structured heartbeat outcomes. */
    enableHeartbeatTool?: boolean;
    /** Keep the heartbeat response tool available even when the selected profile omits it. */
    forceHeartbeatTool?: boolean;
    /** If false, build plugin tools only while preserving the shared policy pipeline. */
    includeCoreTools?: boolean;
    /** Include Tool Search control tools when enabled for this run. */
    includeToolSearchControls?: boolean;
    /** Executes cataloged tools through the active PI run lifecycle. */
    toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
    /** Runtime-local Tool Search catalog ref shared with PI attempt compaction. */
    toolSearchCatalogRef?: ToolSearchCatalogRef;
    /** Limits which tool families are materialized before the shared policy pipeline runs. */
    toolConstructionPlan?: OpenClawCodingToolConstructionPlan;
    /** Trusted sender identity bit for command/channel-action auth; does not filter model tools. */
    senderIsOwner?: boolean;
    /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
    authProfileStore?: AuthProfileStore;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Callback invoked when a media tool starts async background work. */
    onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
    /** Optional instrumentation callback for tool preparation stage timing. */
    recordToolPrepStage?: (name: string) => void;
    /** Live observer called after wrapped tool outcomes are recorded. */
    onToolOutcome?: ToolOutcomeObserver;
    /** Runtime-only resolved skill paths that the read tool may load under workspaceOnly. */
    skillsSnapshot?: SkillSnapshot;
}): AnyAgentTool[];
export { testing as __testing };
