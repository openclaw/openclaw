import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { N as MessageReceipt } from "./types-Bu3TUX-L.js";
import { i as createChannelReplyPipeline, n as CreateChannelReplyPipelineParams } from "./reply-pipeline-DaurkekJ.js";
import { n as DurableFinalDeliveryRequirement, r as DurableFinalDeliveryRequirements, t as DeliverOutboundPayloadsParams } from "./deliver-BFHGr8Aj.js";
import { C as PreparedChannelTurn, D as RunResolvedChannelTurnParams, E as RunChannelTurnParams, O as SenderFacts, S as PreflightFacts, T as RouteFacts, _ as ConversationFacts, a as ChannelDeliveryResult, b as MessageFacts, c as ChannelTurnAdmission, d as ChannelTurnHistoryFinalizeOptions, f as ChannelTurnLogEvent, g as ChannelTurnResult, h as ChannelTurnResolved, i as ChannelDeliveryIntent, k as SupplementalContextFacts, l as ChannelTurnDeliveryAdapter, m as ChannelTurnReplyPipelineOptions, n as AssembledChannelTurn, o as ChannelEventClass, p as ChannelTurnRecordOptions, r as ChannelDeliveryInfo, s as ChannelTurnAdapter, t as AccessFacts, u as ChannelTurnDispatcherOptions, v as DispatchedChannelTurnResult, w as ReplyPlanFacts, x as NormalizedTurnInput, y as InboundMediaFacts } from "./types-Bi_1Er1P.js";
import { i as filterChannelTurnSupplementalContext, r as buildChannelTurnContext, t as BuildChannelTurnContextParams } from "./context-C26G2xsV.js";
import { a as hasVisibleChannelTurnDispatch, i as hasFinalChannelTurnDispatch, n as ChannelTurnVisibleDeliverySignals, o as resolveChannelTurnDispatchCounts, r as EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, t as ChannelTurnDispatchResultLike } from "./dispatch-result-DbVjm0Te.js";

//#region src/channels/turn/durable-delivery.d.ts
type DurableInboundReplyDeliveryOptions = Pick<DeliverOutboundPayloadsParams, "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};
type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
};
type DurableInboundReplyDeliveryResult = {
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
declare function isDurableInboundReplyDeliveryHandled(result: DurableInboundReplyDeliveryResult): result is Extract<DurableInboundReplyDeliveryResult, {
  status: "handled_visible" | "handled_no_send";
}>;
declare function throwIfDurableInboundReplyDeliveryFailed(result: DurableInboundReplyDeliveryResult): void;
declare function deliverInboundReplyWithMessageSendContext(params: DurableInboundReplyDeliveryParams): Promise<DurableInboundReplyDeliveryResult>;
/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
declare const deliverDurableInboundReplyPayload: typeof deliverInboundReplyWithMessageSendContext;
//#endregion
//#region src/channels/turn/delivery-result.d.ts
declare function createChannelDeliveryResultFromReceipt(params: {
  receipt: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult;
declare namespace kernel_d_exports {
  export { AccessFacts, AssembledChannelTurn, BuildChannelTurnContextParams, ChannelDeliveryInfo, ChannelDeliveryResult, ChannelEventClass, ChannelTurnAdapter, ChannelTurnAdmission, ChannelTurnDeliveryAdapter, ChannelTurnDispatchResultLike, ChannelTurnDispatcherOptions, ChannelTurnHistoryFinalizeOptions, ChannelTurnLogEvent, ChannelTurnRecordOptions, ChannelTurnReplyPipelineOptions, ChannelTurnResolved, ChannelTurnResult, ChannelTurnVisibleDeliverySignals, ConversationFacts, DispatchedChannelTurnResult, DurableInboundReplyDeliveryOptions, DurableInboundReplyDeliveryParams, DurableInboundReplyDeliveryResult, EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, InboundMediaFacts, MessageFacts, NormalizedTurnInput, PreflightFacts, PreparedChannelTurn, ReplyPlanFacts, RouteFacts, RunChannelTurnParams, RunResolvedChannelTurnParams, SenderFacts, SupplementalContextFacts, buildChannelTurnContext, createChannelDeliveryResultFromReceipt, createChannelTurnReplyPipeline, createNoopChannelTurnDeliveryAdapter, deliverDurableInboundReplyPayload, deliverInboundReplyWithMessageSendContext, dispatchAssembledChannelTurn, filterChannelTurnSupplementalContext, hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, isDurableInboundReplyDeliveryHandled, resolveChannelTurnDispatchCounts, runChannelTurn, runPreparedChannelTurn, runResolvedChannelTurn, throwIfDurableInboundReplyDeliveryFailed };
}
/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-message` and route send/receive behavior through
 * the message lifecycle helpers.
 */
declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): ReturnType<typeof createChannelReplyPipeline>;
declare function createNoopChannelTurnDeliveryAdapter(): ChannelTurnDeliveryAdapter;
declare function dispatchAssembledChannelTurn(params: AssembledChannelTurn): Promise<DispatchedChannelTurnResult>;
declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurn<TDispatchResult>): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
declare function runChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
declare function runResolvedChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunResolvedChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
//#endregion
export { runResolvedChannelTurn as a, DurableInboundReplyDeliveryResult as c, runPreparedChannelTurn as i, deliverInboundReplyWithMessageSendContext as l, kernel_d_exports as n, DurableInboundReplyDeliveryOptions as o, runChannelTurn as r, DurableInboundReplyDeliveryParams as s, dispatchAssembledChannelTurn as t };