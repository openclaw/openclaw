import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
export { buildChannelTurnContext, filterChannelTurnSupplementalContext } from "./context.js";
export type { BuildChannelTurnContextParams } from "./context.js";
export { deliverDurableInboundReplyPayload, deliverInboundReplyWithMessageSendContext, isDurableInboundReplyDeliveryHandled, throwIfDurableInboundReplyDeliveryFailed, } from "./durable-delivery.js";
export type { DurableInboundReplyDeliveryOptions, DurableInboundReplyDeliveryParams, DurableInboundReplyDeliveryResult, } from "./durable-delivery.js";
import type { AssembledChannelTurn, ChannelTurnDeliveryAdapter, ChannelTurnResult, DispatchedChannelTurnResult, PreparedChannelTurn, RunChannelTurnParams, RunResolvedChannelTurnParams } from "./types.js";
export { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
export { EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, resolveChannelTurnDispatchCounts, type ChannelTurnDispatchResultLike, type ChannelTurnVisibleDeliverySignals, } from "./dispatch-result.js";
export type { AccessFacts, AssembledChannelTurn, ChannelDeliveryInfo, ChannelDeliveryResult, ChannelEventClass, ChannelTurnAdapter, ChannelTurnAdmission, ChannelTurnDeliveryAdapter, ChannelTurnHistoryFinalizeOptions, ChannelTurnDispatcherOptions, ChannelTurnLogEvent, ChannelTurnRecordOptions, ChannelTurnReplyPipelineOptions, ChannelTurnResolved, ChannelTurnResult, DispatchedChannelTurnResult, ConversationFacts, InboundMediaFacts, MessageFacts, NormalizedTurnInput, PreflightFacts, PreparedChannelTurn, ReplyPlanFacts, RouteFacts, RunChannelTurnParams, RunResolvedChannelTurnParams, SenderFacts, SupplementalContextFacts, } from "./types.js";
/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-message` and route send/receive behavior through
 * the message lifecycle helpers.
 */
export declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): ReturnType<typeof createChannelReplyPipeline>;
export declare function createNoopChannelTurnDeliveryAdapter(): ChannelTurnDeliveryAdapter;
export declare function dispatchAssembledChannelTurn(params: AssembledChannelTurn): Promise<DispatchedChannelTurnResult>;
export declare function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: PreparedChannelTurn<TDispatchResult>): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export declare function runChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export declare function runResolvedChannelTurn<TRaw, TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(params: RunResolvedChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
