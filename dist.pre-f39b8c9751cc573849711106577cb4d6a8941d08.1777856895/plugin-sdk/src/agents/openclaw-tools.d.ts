import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { type ContinueWorkRequest } from "./tools/continue-work-tool.js";
import { type RequestCompactionToolOpts } from "./tools/request-compaction-tool.js";
type OpenClawToolsDeps = {
    callGateway: typeof callGateway;
    config?: OpenClawConfig;
};
type OptionalMediaToolFactoryPlan = {
    imageGenerate: boolean;
    videoGenerate: boolean;
    musicGenerate: boolean;
    pdf: boolean;
};
declare function resolveOptionalMediaToolFactoryPlan(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    authStore?: AuthProfileStore;
    toolAllowlist?: string[];
}): OptionalMediaToolFactoryPlan;
export declare function createOpenClawTools(options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
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
    /** Restrict the cron tool to self-removing this active cron job. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
    enableHeartbeatTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Records hot-path tool-prep stages for reply startup diagnostics. */
    recordToolPrepStage?: (name: string) => void;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
    authProfileStore?: AuthProfileStore;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /** Stable run identifier for this agent invocation. */
    runId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
    /** Whether the current run consumes the continue_delegate staging queue. */
    drainsContinuationDelegateQueue?: boolean;
    /** Callback for continue_work to request a post-turn continuation. */
    continueWorkOpts?: {
        requestContinuation: (request: ContinueWorkRequest) => void;
    };
    /** Closures for request_compaction tool (Trigger E). Only set when continuation is enabled. */
    requestCompactionOpts?: {
        sessionId?: string;
        getContextUsage: () => number | null;
        triggerCompaction: RequestCompactionToolOpts["triggerCompaction"];
    };
} & SpawnedToolContext): AnyAgentTool[];
export declare const __testing: {
    resolveOptionalMediaToolFactoryPlan: typeof resolveOptionalMediaToolFactoryPlan;
    setDepsForTest(overrides?: Partial<OpenClawToolsDeps>): void;
};
export {};
