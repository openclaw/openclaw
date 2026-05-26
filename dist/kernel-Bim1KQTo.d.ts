import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { P as MessageReceipt } from "./types-CxkJAgkR.js";
import { i as createChannelReplyPipeline, n as CreateChannelReplyPipelineParams } from "./reply-pipeline-C0u97xVG.js";
import { n as DurableFinalDeliveryRequirement, r as DurableFinalDeliveryRequirements, t as DeliverOutboundPayloadsParams } from "./deliver-YxyJPFrS.js";
import { A as SenderFacts, C as NormalizedTurnInput, D as RouteFacts, E as ReplyPlanFacts, F as recordChannelBotPairLoopAndCheckSuppression, M as ChannelBotLoopProtectionFacts, N as clearChannelBotPairLoopGuardForTests, O as RunChannelTurnParams, P as listTrackedChannelBotPairsForTests, S as MessageFacts, T as PreparedChannelTurn, _ as ChannelTurnResult, a as ChannelDeliveryResult, b as DispatchedChannelTurnResult, c as ChannelTurnAdapter, d as ChannelTurnDroppedHistoryOptions, f as ChannelTurnHistoryFinalizeOptions, g as ChannelTurnResolved, h as ChannelTurnReplyPipelineOptions, i as ChannelDeliveryIntent, j as SupplementalContextFacts, k as RunResolvedChannelTurnParams, l as ChannelTurnAdmission, m as ChannelTurnRecordOptions, n as AssembledChannelTurn, o as ChannelEventClass, p as ChannelTurnLogEvent, r as ChannelDeliveryInfo, s as ChannelEventDeliveryAdapter, t as AccessFacts, u as ChannelTurnDispatcherOptions, w as PreflightFacts, x as InboundMediaFacts, y as ConversationFacts } from "./types-C4IQ1Uoz.js";
import { i as filterChannelInboundSupplementalContext, r as buildChannelInboundEventContext, t as BuildChannelInboundEventContextParams } from "./context-BXUdnr2u.js";
import { n as createChannelHistoryWindow, t as ChannelHistoryWindow } from "./history-window-DpOfKxmG.js";
import { a as hasVisibleChannelTurnDispatch, i as hasFinalChannelTurnDispatch, n as ChannelTurnVisibleDeliverySignals, o as resolveChannelTurnDispatchCounts, r as EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, t as ChannelTurnDispatchResultLike } from "./dispatch-result-CBhc_yqr.js";

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
  export { AccessFacts, AssembledChannelTurn, BuildChannelInboundEventContextParams, ChannelBotLoopProtectionFacts, ChannelDeliveryInfo, ChannelDeliveryResult, ChannelEventClass, ChannelEventDeliveryAdapter, ChannelHistoryWindow, ChannelTurnAdapter, ChannelTurnAdmission, ChannelTurnDispatchResultLike, ChannelTurnDispatcherOptions, ChannelTurnDroppedHistoryOptions, ChannelTurnHistoryFinalizeOptions, ChannelTurnLogEvent, ChannelTurnRecordOptions, ChannelTurnReplyPipelineOptions, ChannelTurnResolved, ChannelTurnResult, ChannelTurnVisibleDeliverySignals, ConversationFacts, DispatchedChannelTurnResult, DurableInboundReplyDeliveryOptions, DurableInboundReplyDeliveryParams, DurableInboundReplyDeliveryResult, EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, InboundMediaFacts, MessageFacts, NormalizedTurnInput, PreflightFacts, PreparedChannelTurn, ReplyPlanFacts, RouteFacts, RunChannelTurnParams, RunResolvedChannelTurnParams, SenderFacts, SupplementalContextFacts, buildChannelInboundEventContext, clearChannelBotPairLoopGuardForTests, createChannelDeliveryResultFromReceipt, createChannelHistoryWindow, createChannelTurnReplyPipeline, createNoopChannelEventDeliveryAdapter, deliverDurableInboundReplyPayload, deliverInboundReplyWithMessageSendContext, dispatchAssembledChannelTurn, filterChannelInboundSupplementalContext, hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, isDurableInboundReplyDeliveryHandled, listTrackedChannelBotPairsForTests, recordChannelBotPairLoopAndCheckSuppression, recordDroppedChannelTurnHistory, resolveChannelTurnDispatchCounts, runChannelTurn, runPreparedChannelTurn, runResolvedChannelTurn, throwIfDurableInboundReplyDeliveryFailed };
}
/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-message` and route send/receive behavior through
 * the message lifecycle helpers.
 */
declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): ReturnType<typeof createChannelReplyPipeline>;
declare function createNoopChannelEventDeliveryAdapter(): ChannelEventDeliveryAdapter;
declare function recordDroppedChannelTurnHistory(params: {
  input: NormalizedTurnInput;
  preflight: PreflightFacts;
  admission?: ChannelTurnAdmission;
}): Promise<void>;
type AssembledChannelTurnWithBotLoopProtection = AssembledChannelTurn & {
  botLoopProtection: NonNullable<AssembledChannelTurn["botLoopProtection"]>;
};
type AssembledChannelTurnWithoutBotLoopProtection = Omit<AssembledChannelTurn, "botLoopProtection"> & {
  botLoopProtection?: undefined;
};
declare function dispatchAssembledChannelTurn(params: AssembledChannelTurnWithBotLoopProtection): Promise<ChannelTurnResult>;
declare function dispatchAssembledChannelTurn(params: AssembledChannelTurnWithoutBotLoopProtection): Promise<DispatchedChannelTurnResult>;
declare function dispatchAssembledChannelTurn(params: AssembledChannelTurn): Promise<ChannelTurnResult>;
type PreparedChannelTurnWithBotLoopProtection<TDispatchResult> = PreparedChannelTurn<TDispatchResult> & {
  botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
};
type PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult> = Omit<PreparedChannelTurn<TDispatchResult>, "botLoopProtection"> & {
  botLoopProtection?: undefined;
};
declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurnWithBotLoopProtection<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult>): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
declare function runChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
declare function runResolvedChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunResolvedChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
//#endregion
export { runPreparedChannelTurn as a, DurableInboundReplyDeliveryParams as c, runChannelTurn as i, DurableInboundReplyDeliveryResult as l, kernel_d_exports as n, runResolvedChannelTurn as o, recordDroppedChannelTurnHistory as r, DurableInboundReplyDeliveryOptions as s, dispatchAssembledChannelTurn as t, deliverInboundReplyWithMessageSendContext as u };