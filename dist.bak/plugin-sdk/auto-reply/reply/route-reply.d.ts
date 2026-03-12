/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */
import type { OpenClawConfig } from "../../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
export type RouteReplyParams = {
    /** The reply payload to send. */
    payload: ReplyPayload;
    /** The originating channel type (telegram, slack, etc). */
    channel: OriginatingChannelType;
    /** The destination chat/channel/user ID. */
    to: string;
    /** Session key for deriving agent identity defaults (multi-agent). */
    sessionKey?: string;
    /** Provider account id (multi-account). */
    accountId?: string;
    /** Thread id for replies (Telegram topic id or Matrix thread event id). */
    threadId?: string | number;
    /** Config for provider-specific settings. */
    cfg: OpenClawConfig;
    /** Optional abort signal for cooperative cancellation. */
    abortSignal?: AbortSignal;
    /** Mirror reply into session transcript (default: true when sessionKey is set). */
    mirror?: boolean;
};
export type RouteReplyResult = {
    /** Whether the reply was sent successfully. */
    ok: boolean;
    /** Optional message ID from the provider. */
    messageId?: string;
    /** Error message if the send failed. */
    error?: string;
};
/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export declare function routeReply(params: RouteReplyParams): Promise<RouteReplyResult>;
/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat) require special handling and cannot be routed through
 * this generic interface.
 */
export declare function isRoutableChannel(channel: OriginatingChannelType | undefined): channel is Exclude<OriginatingChannelType, typeof INTERNAL_MESSAGE_CHANNEL>;
