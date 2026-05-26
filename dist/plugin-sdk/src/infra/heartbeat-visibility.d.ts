import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
export type ResolvedHeartbeatVisibility = {
    showOk: boolean;
    showAlerts: boolean;
    useIndicator: boolean;
};
/**
 * Resolve heartbeat visibility settings for a channel.
 * Supports both deliverable channels and webchat.
 * For webchat, uses channels.defaults.heartbeat since webchat doesn't have per-channel config.
 */
export declare function resolveHeartbeatVisibility(params: {
    cfg: OpenClawConfig;
    channel: GatewayMessageChannel;
    accountId?: string;
}): ResolvedHeartbeatVisibility;
