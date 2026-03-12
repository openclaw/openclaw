import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
export type SlackActionContext = {
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: {
        value: boolean;
    };
};
export declare function handleSlackAction(params: Record<string, unknown>, cfg: OpenClawConfig, context?: SlackActionContext): Promise<AgentToolResult<unknown>>;
