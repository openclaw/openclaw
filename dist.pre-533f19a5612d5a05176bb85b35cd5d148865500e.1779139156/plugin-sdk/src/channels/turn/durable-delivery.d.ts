import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type DeliverOutboundPayloadsParams, type DurableFinalDeliveryRequirement, type DurableFinalDeliveryRequirements } from "../../infra/outbound/deliver.js";
import type { ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";
export type DurableInboundReplyDeliveryOptions = Pick<DeliverOutboundPayloadsParams, "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"> & {
    to?: string | null;
    replyToId?: string | null;
    requiredCapabilities?: DurableFinalDeliveryRequirements;
};
export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
    agentId: string;
    ctxPayload: FinalizedMsgContext;
    payload: ReplyPayload;
    info: ChannelDeliveryInfo;
};
export type DurableInboundReplyDeliveryResult = {
    status: "not_applicable";
    reason: "non_final";
} | {
    status: "unsupported";
    reason: "missing_channel" | "missing_target" | "missing_outbound_handler" | "capability_mismatch";
    capability?: DurableFinalDeliveryRequirement;
} | {
    status: "handled_visible";
    delivery: ChannelDeliveryResult;
} | {
    status: "handled_no_send";
    reason: "no_visible_result";
    delivery: ChannelDeliveryResult;
} | {
    status: "failed";
    error: unknown;
};
export declare function resolveDurableInboundReplyToId(params: Pick<DurableInboundReplyDeliveryParams, "ctxPayload" | "payload" | "replyToId">): string | null | undefined;
export declare function isDurableInboundReplyDeliveryHandled(result: DurableInboundReplyDeliveryResult): result is Extract<DurableInboundReplyDeliveryResult, {
    status: "handled_visible" | "handled_no_send";
}>;
export declare function throwIfDurableInboundReplyDeliveryFailed(result: DurableInboundReplyDeliveryResult): void;
export declare function deliverInboundReplyWithMessageSendContext(params: DurableInboundReplyDeliveryParams): Promise<DurableInboundReplyDeliveryResult>;
/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
export declare const deliverDurableInboundReplyPayload: typeof deliverInboundReplyWithMessageSendContext;
