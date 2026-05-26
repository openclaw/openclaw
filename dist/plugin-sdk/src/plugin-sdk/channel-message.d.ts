import type { ChannelMessageAdapter, ChannelMessageAdapterShape } from "../channels/message/index.js";
import type { DurableMessageBatchSendParams, DurableMessageBatchSendResult, DurableMessageSendContext, DurableMessageSendContextParams } from "../channels/message/runtime.js";
import { hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, resolveChannelTurnDispatchCounts } from "../channels/turn/dispatch-result.js";
import { type CreateChannelReplyPipelineParams } from "./channel-reply-core.js";
export type { DurableInboundReplyDeliveryOptions, DurableInboundReplyDeliveryParams, DurableInboundReplyDeliveryResult, } from "../channels/turn/kernel.js";
export type { DurableMessageBatchSendParams, DurableMessageBatchSendResult, DurableMessageSendContext, DurableMessageSendContextParams, } from "../channels/message/runtime.js";
export { createChannelReplyPipeline as createChannelMessageReplyPipeline, createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks, resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode, } from "./channel-reply-core.js";
export { classifyDurableSendRecoveryState, createChannelMessageAdapterFromOutbound, createMessageReceiptFromOutboundResults, listMessageReceiptPlatformIds, createMessageReceiveContext, createPreviewMessageReceipt, defineFinalizableLivePreviewAdapter, deriveDurableFinalDeliveryRequirements, deliverFinalizableLivePreview, deliverWithFinalizableLivePreviewAdapter, listDeclaredChannelMessageLiveCapabilities, listDeclaredDurableFinalCapabilities, listDeclaredLivePreviewFinalizerCapabilities, listDeclaredReceiveAckPolicies, createLiveMessageState, createDurableMessageStateRecord, markLiveMessageCancelled, markLiveMessageFinalized, markLiveMessagePreviewUpdated, resolveMessageReceiptPrimaryId, shouldAckMessageAfterStage, verifyChannelMessageAdapterCapabilityProofs, verifyChannelMessageLiveCapabilityAdapterProofs, verifyChannelMessageLiveCapabilityProofs, verifyChannelMessageLiveFinalizerProofs, verifyChannelMessageReceiveAckPolicyAdapterProofs, verifyChannelMessageReceiveAckPolicyProofs, verifyDurableFinalCapabilityProofs, verifyLivePreviewFinalizerCapabilityProofs, } from "../channels/message/index.js";
export type { ChannelMessageAdapter, ChannelMessageAdapterShape, ChannelMessageDurableFinalAdapter, ChannelMessageLiveFinalizerAdapterShape, ChannelMessageLiveAdapterShape, ChannelMessageLiveCapability, ChannelMessageOutboundBridgeAdapter, ChannelMessageOutboundBridgeResult, ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAdapterShape, ChannelMessageSendAdapter, ChannelMessageSendAttemptContext, ChannelMessageSendAttemptKind, ChannelMessageSendCommitContext, ChannelMessageSendFailureContext, ChannelMessageSendLifecycleAdapter, ChannelMessageSendMediaContext, ChannelMessageSendPayloadContext, ChannelMessageSendPollContext, ChannelMessageSendResult, ChannelMessageSendSuccessContext, ChannelMessageSendTextContext, ChannelMessageUnknownSendContext, ChannelMessageUnknownSendReconciliationResult, CreateChannelReplyPipelineParams, CreateChannelMessageAdapterFromOutboundParams, DeriveDurableFinalDeliveryRequirementsParams, ChannelMessageLiveCapabilityProof, ChannelMessageLiveCapabilityProofMap, ChannelMessageLiveCapabilityProofResult, ChannelMessageReceiveAckPolicyProof, ChannelMessageReceiveAckPolicyProofMap, ChannelMessageReceiveAckPolicyProofResult, DurableFinalCapabilityProof, DurableFinalCapabilityProofMap, DurableFinalCapabilityProofResult, DurableFinalDeliveryCapability, DurableFinalDeliveryPayloadShape, DurableFinalDeliveryRequirementMap, DurableFinalRequirementExtras, DurableMessageSendIntent, DurableMessageSendState, DurableMessageStateRecord, FinalizableLivePreviewAdapter, LiveMessagePhase, LiveMessageState, LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityMap, LivePreviewFinalizerDraft, LivePreviewFinalizerCapabilityProof, LivePreviewFinalizerCapabilityProofMap, LivePreviewFinalizerCapabilityProofResult, LivePreviewFinalizerResult, LivePreviewFinalizerResultKind, MessageAckPolicy, MessageAckStage, MessageAckState, MessageReceiveContext, MessageSendContext, MessageDurabilityPolicy, MessageReceipt, MessageReceiptPart, MessageReceiptPartKind, MessageReceiptSourceResult, RenderedMessageBatch, RenderedMessageBatchPlan, RenderedMessageBatchPlanItem, RenderedMessageBatchPlanKind, } from "../channels/message/index.js";
export { hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, resolveChannelTurnDispatchCounts, };
type ChannelTurnKernelModule = typeof import("../channels/turn/kernel.js");
type InboundReplyDispatchModule = typeof import("./inbound-reply-dispatch.js");
/** @deprecated Use `createChannelMessageReplyPipeline(...)` for compatibility dispatchers. */
export declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): import("./channel-reply-core.js").ChannelReplyPipeline;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export declare const hasFinalChannelMessageReplyDispatch: typeof hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export declare const hasVisibleChannelMessageReplyDispatch: typeof hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export declare const resolveChannelMessageReplyDispatchCounts: typeof resolveChannelTurnDispatchCounts;
/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export declare const buildChannelMessageReplyDispatchBase: InboundReplyDispatchModule["buildChannelMessageReplyDispatchBase"];
/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export declare const dispatchChannelMessageReplyWithBase: InboundReplyDispatchModule["dispatchChannelMessageReplyWithBase"];
/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export declare const recordChannelMessageReplyDispatch: InboundReplyDispatchModule["recordChannelMessageReplyDispatch"];
export declare const deliverInboundReplyWithMessageSendContext: ChannelTurnKernelModule["deliverInboundReplyWithMessageSendContext"];
/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
export declare const deliverDurableInboundReplyPayload: typeof import("./inbound-reply-dispatch.js").deliverInboundReplyWithMessageSendContext;
export declare function sendDurableMessageBatch(params: DurableMessageBatchSendParams): Promise<DurableMessageBatchSendResult>;
export declare function withDurableMessageSendContext<T>(params: DurableMessageSendContextParams, run: (ctx: DurableMessageSendContext) => Promise<T>): Promise<T>;
declare const defaultManualReceiveAdapter: {
    readonly defaultAckPolicy: "manual";
    readonly supportedAckPolicies: readonly ["manual"];
};
type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> = TAdapter & {
    receive: TAdapter["receive"] extends undefined ? typeof defaultManualReceiveAdapter : NonNullable<TAdapter["receive"]>;
};
export declare function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(adapter: TAdapter): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
