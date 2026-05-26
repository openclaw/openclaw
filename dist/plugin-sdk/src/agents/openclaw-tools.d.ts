import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveOptionalMediaToolFactoryPlan } from "./openclaw-tools.media-factory-plan.js";
import { type HookContext } from "./pi-tools.before-tool-call.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import type { MediaGenerateAsyncStartCallback } from "./tools/media-generate-background-shared.js";
type OpenClawToolsDeps = {
    callGateway: typeof callGateway;
    config?: OpenClawConfig;
};
export declare function createOpenClawTools(options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    /**
     * The actual live run session key. When the tool is constructed with a sandbox/policy
     * session key, this allows `session_status({sessionKey:"current"})` to resolve to
     * the live run session instead of the stale sandbox key.
     */
    runSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    runId?: string;
    agentAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    pluginToolDenylist?: string[];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: {
        value: boolean;
    };
    /** Fail closed instead of posting same-channel thread-originated replies at the root. */
    sameChannelThreadRequired?: boolean;
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** Active model id for provider/model-specific tool gating. */
    modelId?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Trusted sender identity bit for channel action auth. */
    senderIsOwner?: boolean;
    /** Restrict the cron tool to self-removing this active cron job. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** Visible source replies must be sent through the message tool when set to message_tool_only. */
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    inboundEventKind?: InboundEventKind;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
    enableHeartbeatTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /**
     * Wrap returned tools with the before_tool_call hook at construction time.
     * Defaults to true; callers that already enforce the hook at a later shared
     * boundary should opt out explicitly.
     */
    wrapBeforeToolCallHook?: boolean;
    /** Override or extend the default hook context used by construction-time wrapping. */
    beforeToolCallHookContext?: HookContext;
    /** Records hot-path tool-prep stages for reply startup diagnostics. */
    recordToolPrepStage?: (name: string) => void;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
    authProfileStore?: AuthProfileStore;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Callback invoked when a media tool starts async background work. */
    onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
} & SpawnedToolContext): AnyAgentTool[];
export declare const testing: {
    resolveOptionalMediaToolFactoryPlan: typeof resolveOptionalMediaToolFactoryPlan;
    setDepsForTest(overrides?: Partial<OpenClawToolsDeps>): void;
};
export { testing as __testing };
