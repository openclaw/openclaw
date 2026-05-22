import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type InteractiveReply, type MessagePresentation, type ReplyPayloadDelivery } from "../../interactive/payload.js";
import { type SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
export type NormalizedOutboundPayload = {
    text: string;
    mediaUrls: string[];
    audioAsVoice?: boolean;
    presentation?: MessagePresentation;
    delivery?: ReplyPayloadDelivery;
    interactive?: InteractiveReply;
    channelData?: Record<string, unknown>;
    /** Hook-only content for audio-only TTS payloads. Never used as channel text/caption. */
    hookContent?: string;
};
export type OutboundPayloadJson = {
    text: string;
    mediaUrl: string | null;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    presentation?: MessagePresentation;
    delivery?: ReplyPayloadDelivery;
    interactive?: InteractiveReply;
    channelData?: Record<string, unknown>;
};
export type OutboundPayloadPlan = {
    payload: ReplyPayload;
    parts: ReturnType<typeof resolveSendableOutboundReplyParts>;
    hasPresentation: boolean;
    hasInteractive: boolean;
    hasChannelData: boolean;
};
type OutboundPayloadPlanContext = {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
    /**
     * When true, bare silent payloads are dropped instead of being rewritten to
     * visible fallback text. Set by callers that know the parent session has at
     * least one pending spawned child whose completion will deliver the real
     * reply. If omitted, the outbound plan consults the registered runtime query
     * (see `pending-spawn-query.ts`).
     */
    hasPendingSpawnedChildren?: boolean;
    extractMarkdownImages?: boolean;
};
export type OutboundPayloadMirror = {
    text: string;
    mediaUrls: string[];
};
export declare function createOutboundPayloadPlan(payloads: readonly ReplyPayload[], context?: OutboundPayloadPlanContext): OutboundPayloadPlan[];
export declare function projectOutboundPayloadPlanForDelivery(plan: readonly OutboundPayloadPlan[]): ReplyPayload[];
export declare function projectOutboundPayloadPlanForOutbound(plan: readonly OutboundPayloadPlan[]): NormalizedOutboundPayload[];
export declare function projectOutboundPayloadPlanForJson(plan: readonly OutboundPayloadPlan[]): OutboundPayloadJson[];
export declare function projectOutboundPayloadPlanForMirror(plan: readonly OutboundPayloadPlan[]): OutboundPayloadMirror;
export declare function summarizeOutboundPayloadForTransport(payload: ReplyPayload): NormalizedOutboundPayload;
export declare function normalizeReplyPayloadsForDelivery(payloads: readonly ReplyPayload[]): ReplyPayload[];
export declare function normalizeOutboundPayloads(payloads: readonly ReplyPayload[]): NormalizedOutboundPayload[];
export declare function normalizeOutboundPayloadsForJson(payloads: readonly ReplyPayload[]): OutboundPayloadJson[];
export declare function formatOutboundPayloadLog(payload: Pick<NormalizedOutboundPayload, "text" | "channelData"> & {
    mediaUrls: readonly string[];
}): string;
export {};
