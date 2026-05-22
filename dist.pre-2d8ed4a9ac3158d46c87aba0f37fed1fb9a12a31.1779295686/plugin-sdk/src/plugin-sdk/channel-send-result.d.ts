import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import type { ChannelPollResult } from "../channels/plugins/types.public.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
export type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
export type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
export type ChannelSendRawResult = {
    ok: boolean;
    messageId?: string | null;
    error?: string | null;
};
export declare function attachChannelToResult<T extends object>(channel: string, result: T): {
    channel: string;
} & T;
export declare function attachChannelToResults<T extends object>(channel: string, results: readonly T[]): ({
    channel: string;
} & T)[];
export declare function createEmptyChannelResult(channel: string, result?: Partial<Omit<OutboundDeliveryResult, "channel" | "messageId">> & {
    messageId?: string;
}): OutboundDeliveryResult;
type MaybePromise<T> = T | Promise<T>;
type SendTextParams = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type SendMediaParams = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type SendPollParams = Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0];
export declare function createAttachedChannelResultAdapter(params: {
    channel: string;
    sendText?: (ctx: SendTextParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendMedia?: (ctx: SendMediaParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendPoll?: (ctx: SendPollParams) => MaybePromise<Omit<ChannelPollResult, "channel">>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
export declare function createRawChannelSendResultAdapter(params: {
    channel: string;
    sendText?: (ctx: SendTextParams) => MaybePromise<ChannelSendRawResult>;
    sendMedia?: (ctx: SendMediaParams) => MaybePromise<ChannelSendRawResult>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia">;
/** Normalize raw channel send results into the shape shared outbound callers expect. */
export declare function buildChannelSendResult(channel: string, result: ChannelSendRawResult): {
    channel: string;
    ok: boolean;
    messageId: string;
    error: Error | undefined;
};
