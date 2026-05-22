import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { DeliverableMessageChannel, GatewayMessageChannel } from "../../utils/message-channel-normalize.js";
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
    requestedChannel?: GatewayMessageChannel;
    explicitTo?: string;
    explicitThreadId?: string | number;
    fallbackChannel?: DeliverableMessageChannel;
    allowMismatchedLastTo?: boolean;
    mode?: ChannelOutboundTargetMode;
    /**
     * When set, this overrides the session-level `lastChannel` for "last"
     * resolution. This prevents cross-channel reply routing when multiple
     * channels share the same session and an inbound message updates `lastChannel`
     * while an agent turn is still in flight.
     */
    turnSourceChannel?: DeliverableMessageChannel;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
}): SessionDeliveryTarget;
