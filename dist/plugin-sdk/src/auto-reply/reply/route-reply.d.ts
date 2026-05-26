/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
export type RouteReplyParams = {
    /** The reply payload to send. */
    payload: ReplyPayload;
    /** The originating channel type. */
    channel: OriginatingChannelType;
    /** The destination chat/channel/user ID. */
    to: string;
    /** Session key for deriving agent identity defaults (multi-agent). */
    sessionKey?: string;
    /** Session key for policy resolution when native-command delivery targets a different session. */
    policySessionKey?: string;
    /** Explicit conversation type for policy resolution when the policy key is generic. */
    policyConversationType?: SilentReplyConversationType;
    /** Provider account id (multi-account). */
    accountId?: string;
    /** Originating sender id for sender-scoped outbound media policy. */
    requesterSenderId?: string;
    /** Originating sender display name for name-keyed sender policy matching. */
    requesterSenderName?: string;
    /** Originating sender username for username-keyed sender policy matching. */
    requesterSenderUsername?: string;
    /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
    requesterSenderE164?: string;
    /** Thread id for replies (Telegram topic id or Matrix thread event id). */
    threadId?: string | number;
    /** Config for provider-specific settings. */
    cfg: OpenClawConfig;
    /** Optional abort signal for cooperative cancellation. */
    abortSignal?: AbortSignal;
    /** Mirror reply into session transcript (default: true when sessionKey is set). */
    mirror?: boolean;
    /** Whether this message is being sent in a group/channel context */
    isGroup?: boolean;
    /** Group or channel identifier for correlation with received events */
    groupId?: string;
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
