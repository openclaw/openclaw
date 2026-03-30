import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { DeliverableMessageChannel, GatewayMessageChannel } from "../../utils/message-channel.js";
export type OutboundChannel = DeliverableMessageChannel | "none";
export type HeartbeatTarget = OutboundChannel | "last";
export type OutboundTarget = {
    channel: OutboundChannel;
    to?: string;
    reason?: string;
    accountId?: string;
    threadId?: string | number;
    lastChannel?: DeliverableMessageChannel;
    lastAccountId?: string;
};
export type HeartbeatSenderContext = {
    sender: string;
    provider?: DeliverableMessageChannel;
    allowFrom: string[];
};
export type OutboundTargetResolution = {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export type SessionDeliveryTarget = {
    channel?: DeliverableMessageChannel;
    to?: string;
    accountId?: string;
    threadId?: string | number;
    /** Whether threadId came from an explicit source (config/param/:topic: parsing) vs session history. */
    threadIdExplicit?: boolean;
    mode: ChannelOutboundTargetMode;
    lastChannel?: DeliverableMessageChannel;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
};
export declare function resolveSessionDeliveryTarget(params: {
    entry?: SessionEntry;
    requestedChannel?: GatewayMessageChannel | "last";
    explicitTo?: string;
    explicitThreadId?: string | number;
    fallbackChannel?: DeliverableMessageChannel;
    allowMismatchedLastTo?: boolean;
    mode?: ChannelOutboundTargetMode;
    /**
     * When set, this overrides the session-level `lastChannel` for "last"
     * resolution.  This prevents cross-channel reply routing when multiple
     * channels share the same session (dmScope = "main") and an inbound
     * message from a different channel updates `lastChannel` while an agent
     * turn is still in flight.
     *
     * Callers should set this to the channel that originated the current
     * agent turn so the reply always routes back to the correct channel.
     *
     * @see https://github.com/openclaw/openclaw/issues/24152
     */
    turnSourceChannel?: DeliverableMessageChannel;
    /** Turn-source `to` — paired with `turnSourceChannel`. */
    turnSourceTo?: string;
    /** Turn-source `accountId` — paired with `turnSourceChannel`. */
    turnSourceAccountId?: string;
    /** Turn-source `threadId` — paired with `turnSourceChannel`. */
    turnSourceThreadId?: string | number;
}): SessionDeliveryTarget;
export declare function resolveOutboundTarget(params: {
    channel: GatewayMessageChannel;
    to?: string;
    allowFrom?: string[];
    cfg?: OpenClawConfig;
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution;
export declare function resolveHeartbeatDeliveryTarget(params: {
    cfg: OpenClawConfig;
    entry?: SessionEntry;
    heartbeat?: AgentDefaultsConfig["heartbeat"];
}): OutboundTarget;
export declare function resolveHeartbeatSenderContext(params: {
    cfg: OpenClawConfig;
    entry?: SessionEntry;
    delivery: OutboundTarget;
}): HeartbeatSenderContext;
