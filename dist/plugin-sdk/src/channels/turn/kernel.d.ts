import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
export { buildChannelInboundEventContext, filterChannelInboundSupplementalContext, } from "../inbound-event/context.js";
export type { BuildChannelInboundEventContextParams } from "../inbound-event/context.js";
export { clearChannelBotPairLoopGuardForTests, listTrackedChannelBotPairsForTests, recordChannelBotPairLoopAndCheckSuppression, } from "./bot-loop-protection.js";
export { createChannelHistoryWindow } from "./history-window.js";
export type { ChannelHistoryWindow } from "./history-window.js";
export type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";
export { deliverDurableInboundReplyPayload, deliverInboundReplyWithMessageSendContext, isDurableInboundReplyDeliveryHandled, throwIfDurableInboundReplyDeliveryFailed, } from "./durable-delivery.js";
export type { DurableInboundReplyDeliveryOptions, DurableInboundReplyDeliveryParams, DurableInboundReplyDeliveryResult, } from "./durable-delivery.js";
import type { AssembledChannelTurn, ChannelTurnAdmission, ChannelEventDeliveryAdapter, ChannelTurnResult, DispatchedChannelTurnResult, NormalizedTurnInput, PreparedChannelTurn, PreflightFacts, RunChannelTurnParams, RunResolvedChannelTurnParams } from "./types.js";
export { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
export { EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, resolveChannelTurnDispatchCounts, type ChannelTurnDispatchResultLike, type ChannelTurnVisibleDeliverySignals, } from "./dispatch-result.js";
export type { AccessFacts, AssembledChannelTurn, ChannelDeliveryInfo, ChannelDeliveryResult, ChannelEventClass, ChannelTurnAdapter, ChannelTurnAdmission, ChannelEventDeliveryAdapter, ChannelTurnDroppedHistoryOptions, ChannelTurnHistoryFinalizeOptions, ChannelTurnDispatcherOptions, ChannelTurnLogEvent, ChannelTurnRecordOptions, ChannelTurnReplyPipelineOptions, ChannelTurnResolved, ChannelTurnResult, DispatchedChannelTurnResult, ConversationFacts, MessageFacts, NormalizedTurnInput, PreflightFacts, PreparedChannelTurn, ReplyPlanFacts, RouteFacts, RunChannelTurnParams, RunResolvedChannelTurnParams, SenderFacts, SupplementalContextFacts, } from "./types.js";
export type { InboundMediaFacts } from "./types.js";
/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-message` and route send/receive behavior through
 * the message lifecycle helpers.
 */
export declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): ReturnType<typeof createChannelReplyPipeline>;
export declare function createNoopChannelEventDeliveryAdapter(): ChannelEventDeliveryAdapter;
export declare function recordDroppedChannelTurnHistory(params: {
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
export declare function dispatchAssembledChannelTurn(params: AssembledChannelTurnWithBotLoopProtection): Promise<ChannelTurnResult>;
export declare function dispatchAssembledChannelTurn(params: AssembledChannelTurnWithoutBotLoopProtection): Promise<DispatchedChannelTurnResult>;
export declare function dispatchAssembledChannelTurn(params: AssembledChannelTurn): Promise<ChannelTurnResult>;
type PreparedChannelTurnWithBotLoopProtection<TDispatchResult> = PreparedChannelTurn<TDispatchResult> & {
    botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
};
type PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult> = Omit<PreparedChannelTurn<TDispatchResult>, "botLoopProtection"> & {
    botLoopProtection?: undefined;
};
export declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurnWithBotLoopProtection<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult>): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export declare function runChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export declare function runResolvedChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunResolvedChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
