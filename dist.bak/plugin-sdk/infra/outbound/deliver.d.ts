import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageSignal } from "../../signal/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import type { OutboundIdentity } from "./identity.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
type SendMatrixMessage = (to: string, text: string, opts?: {
    mediaUrl?: string;
    replyToId?: string;
    threadId?: string;
    timeoutMs?: number;
}) => Promise<{
    messageId: string;
    roomId: string;
}>;
export type OutboundSendDeps = {
    sendWhatsApp?: typeof sendMessageWhatsApp;
    sendTelegram?: typeof sendMessageTelegram;
    sendDiscord?: typeof sendMessageDiscord;
    sendSlack?: typeof sendMessageSlack;
    sendSignal?: typeof sendMessageSignal;
    sendIMessage?: typeof sendMessageIMessage;
    sendMatrix?: SendMatrixMessage;
    sendMSTeams?: (to: string, text: string, opts?: {
        mediaUrl?: string;
    }) => Promise<{
        messageId: string;
        conversationId: string;
    }>;
};
export type OutboundDeliveryResult = {
    channel: Exclude<OutboundChannel, "none">;
    messageId: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    pollId?: string;
    meta?: Record<string, unknown>;
};
type DeliverOutboundPayloadsCoreParams = {
    cfg: OpenClawConfig;
    channel: Exclude<OutboundChannel, "none">;
    to: string;
    accountId?: string;
    payloads: ReplyPayload[];
    replyToId?: string | null;
    threadId?: string | number | null;
    identity?: OutboundIdentity;
    deps?: OutboundSendDeps;
    gifPlayback?: boolean;
    abortSignal?: AbortSignal;
    bestEffort?: boolean;
    onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
    onPayload?: (payload: NormalizedOutboundPayload) => void;
    /** Session/agent context used for hooks and media local-root scoping. */
    session?: OutboundSessionContext;
    mirror?: {
        sessionKey: string;
        agentId?: string;
        text?: string;
        mediaUrls?: string[];
    };
    silent?: boolean;
};
type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
    /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
    skipQueue?: boolean;
};
export declare function deliverOutboundPayloads(params: DeliverOutboundPayloadsParams): Promise<OutboundDeliveryResult[]>;
