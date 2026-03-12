import type { OpenClawConfig } from "../config/config.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
export declare function createOpenClawTools(options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    /** Group id for channel-level tool policy inheritance. */
    agentGroupId?: string | null;
    /** Group channel label for channel-level tool policy inheritance. */
    agentGroupChannel?: string | null;
    /** Group space label for channel-level tool policy inheritance. */
    agentGroupSpace?: string | null;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    workspaceDir?: string;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading (Slack). */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading (Slack). */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks (e.g. Telegram react). */
    currentMessageId?: string | number;
    /** Reply-to mode for Slack auto-threading. */
    replyToMode?: "off" | "first" | "all";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: {
        value: boolean;
    };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
}): AnyAgentTool[];
