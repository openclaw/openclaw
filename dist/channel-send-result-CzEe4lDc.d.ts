import { b as OutboundDeliveryResult, n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";
import { A as ChannelPollResult } from "./types.core-BkmTlRzr.js";
//#region src/plugin-sdk/channel-send-result.d.ts
type ChannelSendRawResult = {
  ok: boolean;
  messageId?: string | null;
  error?: string | null;
};
declare function attachChannelToResult<T extends object>(channel: string, result: T): {
  channel: string;
} & T;
declare function attachChannelToResults<T extends object>(channel: string, results: readonly T[]): ({
  channel: string;
} & T)[];
declare function createEmptyChannelResult(channel: string, result?: Partial<Omit<OutboundDeliveryResult, "channel" | "messageId">> & {
  messageId?: string;
}): OutboundDeliveryResult;
type MaybePromise<T> = T | Promise<T>;
type SendTextParams = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type SendMediaParams = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type SendPollParams = Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0];
declare function createAttachedChannelResultAdapter(params: {
  channel: string;
  sendText?: (ctx: SendTextParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
  sendMedia?: (ctx: SendMediaParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
  sendPoll?: (ctx: SendPollParams) => MaybePromise<Omit<ChannelPollResult, "channel">>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
declare function createRawChannelSendResultAdapter(params: {
  channel: string;
  sendText?: (ctx: SendTextParams) => MaybePromise<ChannelSendRawResult>;
  sendMedia?: (ctx: SendMediaParams) => MaybePromise<ChannelSendRawResult>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia">;
/** Normalize raw channel send results into the shape shared outbound callers expect. */
declare function buildChannelSendResult(channel: string, result: ChannelSendRawResult): {
  channel: string;
  ok: boolean;
  messageId: string;
  error: Error | undefined;
};
//#endregion
export { createAttachedChannelResultAdapter as a, buildChannelSendResult as i, attachChannelToResult as n, createEmptyChannelResult as o, attachChannelToResults as r, createRawChannelSendResultAdapter as s, ChannelSendRawResult as t };