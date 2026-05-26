import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { A as LiveMessageState, C as DeriveDurableFinalDeliveryRequirementsParams, E as DurableFinalDeliveryRequirementMap, I as MessageReceiptPartKind, L as MessageReceiptSourceResult, M as LivePreviewFinalizerCapabilityMap, N as MessageDurabilityPolicy, O as DurableMessageSendIntent, P as MessageReceipt, R as MessageSendContext, _ as ChannelMessageSendPollContext, a as ChannelMessageLiveCapability, b as ChannelMessageSendTextContext, c as ChannelMessageReceiveAdapterShape, g as ChannelMessageSendPayloadContext, h as ChannelMessageSendMediaContext, i as ChannelMessageLiveAdapterShape, j as LivePreviewFinalizerCapability, n as ChannelMessageAdapterShape, s as ChannelMessageReceiveAckPolicy, t as ChannelMessageAdapter, w as DurableFinalDeliveryCapability, z as RenderedMessageBatch } from "./types-CxkJAgkR.js";
import { b as OutboundDeliveryResult } from "./outbound.types-D7agCOHK.js";
import { n as CreateChannelReplyPipelineParams, t as ChannelReplyPipeline } from "./reply-pipeline-C0u97xVG.js";
import { i as OutboundDeliveryIntent, t as DeliverOutboundPayloadsParams } from "./deliver-YxyJPFrS.js";
import { n as kernel_d_exports, u as deliverInboundReplyWithMessageSendContext$1 } from "./kernel-Bim1KQTo.js";
import { a as hasVisibleChannelTurnDispatch, i as hasFinalChannelTurnDispatch, o as resolveChannelTurnDispatchCounts } from "./dispatch-result-CBhc_yqr.js";
import { c as inbound_reply_dispatch_d_exports } from "./inbound-reply-dispatch-CLpFQ2PO.js";
//#region src/channels/message/capabilities.d.ts
declare function deriveDurableFinalDeliveryRequirements(params: DeriveDurableFinalDeliveryRequirementsParams): DurableFinalDeliveryRequirementMap;
//#endregion
//#region src/channels/message/outbound-bridge.d.ts
type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
  messageId?: string;
};
type ChannelMessageOutboundBridgeAdapter<TConfig = unknown> = {
  deliveryCapabilities?: {
    durableFinal?: DurableFinalDeliveryRequirementMap;
  };
  sendText?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
  sendMedia?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
  sendPayload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
  sendPoll?: (ctx: ChannelMessageSendPollContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
};
type CreateChannelMessageAdapterFromOutboundParams<TConfig = unknown> = {
  id?: string;
  outbound: ChannelMessageOutboundBridgeAdapter<TConfig>;
  capabilities?: DurableFinalDeliveryRequirementMap;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};
declare function createChannelMessageAdapterFromOutbound<TConfig = unknown>(params: CreateChannelMessageAdapterFromOutboundParams<TConfig>): ChannelMessageAdapterShape<TConfig>;
//#endregion
//#region src/channels/message/contracts.d.ts
type DurableFinalCapabilityProof = () => Promise<void> | void;
type DurableFinalCapabilityProofMap = Partial<Record<DurableFinalDeliveryCapability, DurableFinalCapabilityProof>>;
type DurableFinalCapabilityProofResult = {
  capability: DurableFinalDeliveryCapability;
  status: "verified" | "not_declared";
};
type LivePreviewFinalizerCapabilityProof = () => Promise<void> | void;
type ChannelMessageLiveCapabilityProof = () => Promise<void> | void;
type ChannelMessageReceiveAckPolicyProof = () => Promise<void> | void;
type LivePreviewFinalizerCapabilityProofMap = Partial<Record<LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityProof>>;
type ChannelMessageLiveCapabilityProofMap = Partial<Record<ChannelMessageLiveCapability, ChannelMessageLiveCapabilityProof>>;
type ChannelMessageReceiveAckPolicyProofMap = Partial<Record<ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAckPolicyProof>>;
type LivePreviewFinalizerCapabilityProofResult = {
  capability: LivePreviewFinalizerCapability;
  status: "verified" | "not_declared";
};
type ChannelMessageLiveCapabilityProofResult = {
  capability: ChannelMessageLiveCapability;
  status: "verified" | "not_declared";
};
type ChannelMessageReceiveAckPolicyProofResult = {
  policy: ChannelMessageReceiveAckPolicy;
  status: "verified" | "not_declared";
};
declare function listDeclaredDurableFinalCapabilities(capabilities: DurableFinalDeliveryRequirementMap | undefined): DurableFinalDeliveryCapability[];
declare function listDeclaredLivePreviewFinalizerCapabilities(capabilities: LivePreviewFinalizerCapabilityMap | undefined): LivePreviewFinalizerCapability[];
declare function listDeclaredChannelMessageLiveCapabilities(capabilities: Partial<Record<ChannelMessageLiveCapability, boolean>> | undefined): ChannelMessageLiveCapability[];
declare function listDeclaredReceiveAckPolicies(receive: ChannelMessageAdapterShape["receive"] | undefined): ChannelMessageReceiveAckPolicy[];
declare function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]>;
declare function verifyLivePreviewFinalizerCapabilityProofs(params: {
  adapterName: string;
  capabilities?: LivePreviewFinalizerCapabilityMap;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]>;
declare function verifyChannelMessageLiveCapabilityProofs(params: {
  adapterName: string;
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]>;
declare function verifyChannelMessageReceiveAckPolicyProofs(params: {
  adapterName: string;
  receive?: ChannelMessageAdapterShape["receive"];
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]>;
declare function verifyChannelMessageAdapterCapabilityProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]>;
declare function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "receive">;
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]>;
declare function verifyChannelMessageLiveFinalizerProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]>;
declare function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]>;
//#endregion
//#region src/channels/message/receipt.d.ts
type MessageReceiptInputResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
};
declare function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptInputResult[];
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt;
declare function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[];
declare function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined;
//#endregion
//#region src/channels/message/receive.d.ts
type MessageAckPolicy = ChannelMessageReceiveAckPolicy;
type MessageAckStage = "receive_record" | "agent_dispatch" | "durable_send" | "manual";
type MessageAckState = "pending" | "acked" | "nacked";
type MessageReceiveContext<TMessage = unknown> = {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy: MessageAckPolicy;
  ackState: MessageAckState;
  ackedAt?: number;
  nackErrorMessage?: string;
  receivedAt: number;
  signal: AbortSignal;
  shouldAckAfter(stage: MessageAckStage): boolean;
  ack(): Promise<void>;
  nack(error: unknown): Promise<void>;
};
declare function shouldAckMessageAfterStage(policy: MessageAckPolicy, stage: MessageAckStage): boolean;
declare function createMessageReceiveContext<TMessage>(params: {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy?: MessageAckPolicy;
  receivedAt?: number;
  signal?: AbortSignal;
  onAck?: () => Promise<void> | void;
  onNack?: (error: unknown) => Promise<void> | void;
}): MessageReceiveContext<TMessage>;
//#endregion
//#region src/channels/message/state.d.ts
type DurableMessageSendState = "pending" | "sent" | "suppressed" | "failed" | "unknown_after_send";
type DurableMessageStateRecord = {
  intent: DurableMessageSendIntent;
  state: DurableMessageSendState;
  receipt?: MessageReceipt;
  updatedAt: number;
  errorMessage?: string;
};
declare function createDurableMessageStateRecord(params: {
  intent: DurableMessageSendIntent;
  state?: DurableMessageSendState;
  receipt?: MessageReceipt;
  updatedAt?: number;
  error?: unknown;
}): DurableMessageStateRecord;
declare function classifyDurableSendRecoveryState(params: {
  hasIntent: boolean;
  hasReceipt: boolean;
  platformSendMayHaveStarted: boolean;
  failed?: boolean;
  suppressed?: boolean;
}): DurableMessageSendState;
//#endregion
//#region src/channels/message/send.d.ts
type DurableMessageBatchSendParams = Omit<DeliverOutboundPayloadsParams, "abortSignal" | "onDeliveryIntent" | "payloads" | "queuePolicy"> & {
  payloads: ReplyPayload[];
  attempt?: number;
  signal?: AbortSignal; /** @deprecated Use `signal`. */
  abortSignal?: AbortSignal;
  previousReceipt?: MessageReceipt;
};
type DurableMessageSuppressionReason = "cancelled_by_message_sending_hook" | "empty_after_message_sending_hook" | "no_visible_payload" | "adapter_returned_no_identity" | "no_visible_result";
type DurableMessageFailureStage = "platform_send" | "queue" | "unknown";
type DurableMessagePayloadDeliveryOutcome = {
  index: number;
  status: "sent";
  results: OutboundDeliveryResult[];
} | {
  index: number;
  status: "suppressed";
  reason: DurableMessageSuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
} | {
  index: number;
  status: "failed";
  error: unknown;
  sentBeforeError: boolean;
  stage: DurableMessageFailureStage;
};
type DurableMessageBatchSendResult = {
  status: "sent";
  results: OutboundDeliveryResult[];
  receipt: MessageReceipt;
  deliveryIntent?: OutboundDeliveryIntent;
  payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
} | {
  status: "suppressed";
  results: [];
  receipt: MessageReceipt;
  deliveryIntent?: OutboundDeliveryIntent;
  reason: DurableMessageSuppressionReason;
  payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
} | {
  status: "partial_failed";
  results: OutboundDeliveryResult[];
  receipt: MessageReceipt;
  error: unknown;
  sentBeforeError: true;
  deliveryIntent?: OutboundDeliveryIntent;
  payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
} | {
  status: "failed";
  error: unknown;
  stage?: DurableMessageFailureStage;
  payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
};
type DurableMessageSendContextParams = DurableMessageBatchSendParams & {
  durability?: Exclude<MessageDurabilityPolicy, "disabled">;
  preview?: LiveMessageState<ReplyPayload>;
  onPreviewUpdate?: (rendered: RenderedMessageBatch<ReplyPayload>, state: LiveMessageState<ReplyPayload>) => Promise<LiveMessageState<ReplyPayload>> | LiveMessageState<ReplyPayload>;
  onEditReceipt?: (receipt: MessageReceipt, rendered: RenderedMessageBatch<ReplyPayload>) => Promise<MessageReceipt> | MessageReceipt;
  onDeleteReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onCommitReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onSendFailure?: (error: unknown) => Promise<void> | void;
};
type DurableMessageSendContext = MessageSendContext<ReplyPayload, DurableMessageBatchSendResult>;
//#endregion
//#region src/plugin-sdk/channel-message.d.ts
type ChannelTurnKernelModule = typeof kernel_d_exports;
type InboundReplyDispatchModule = typeof inbound_reply_dispatch_d_exports;
/** @deprecated Use `createChannelMessageReplyPipeline(...)` for compatibility dispatchers. */
declare function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams): ChannelReplyPipeline;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const hasFinalChannelMessageReplyDispatch: typeof hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const hasVisibleChannelMessageReplyDispatch: typeof hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const resolveChannelMessageReplyDispatchCounts: typeof resolveChannelTurnDispatchCounts;
/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
declare const buildChannelMessageReplyDispatchBase: InboundReplyDispatchModule["buildChannelMessageReplyDispatchBase"];
/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
declare const dispatchChannelMessageReplyWithBase: InboundReplyDispatchModule["dispatchChannelMessageReplyWithBase"];
/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
declare const recordChannelMessageReplyDispatch: InboundReplyDispatchModule["recordChannelMessageReplyDispatch"];
declare const deliverInboundReplyWithMessageSendContext: ChannelTurnKernelModule["deliverInboundReplyWithMessageSendContext"];
/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
declare const deliverDurableInboundReplyPayload: typeof deliverInboundReplyWithMessageSendContext$1;
declare function sendDurableMessageBatch(params: DurableMessageBatchSendParams): Promise<DurableMessageBatchSendResult>;
declare function withDurableMessageSendContext<T>(params: DurableMessageSendContextParams, run: (ctx: DurableMessageSendContext) => Promise<T>): Promise<T>;
declare const defaultManualReceiveAdapter: {
  readonly defaultAckPolicy: "manual";
  readonly supportedAckPolicies: readonly ["manual"];
};
type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> = TAdapter & {
  receive: TAdapter["receive"] extends undefined ? typeof defaultManualReceiveAdapter : NonNullable<TAdapter["receive"]>;
};
declare function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(adapter: TAdapter): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
//#endregion
export { verifyLivePreviewFinalizerCapabilityProofs as $, ChannelMessageLiveCapabilityProof as A, LivePreviewFinalizerCapabilityProofMap as B, MessageAckState as C, createMessageReceiptFromOutboundResults as D, shouldAckMessageAfterStage as E, ChannelMessageReceiveAckPolicyProofResult as F, listDeclaredReceiveAckPolicies as G, listDeclaredChannelMessageLiveCapabilities as H, DurableFinalCapabilityProof as I, verifyChannelMessageLiveCapabilityProofs as J, verifyChannelMessageAdapterCapabilityProofs as K, DurableFinalCapabilityProofMap as L, ChannelMessageLiveCapabilityProofResult as M, ChannelMessageReceiveAckPolicyProof as N, listMessageReceiptPlatformIds as O, ChannelMessageReceiveAckPolicyProofMap as P, verifyDurableFinalCapabilityProofs as Q, DurableFinalCapabilityProofResult as R, MessageAckStage as S, createMessageReceiveContext as T, listDeclaredDurableFinalCapabilities as U, LivePreviewFinalizerCapabilityProofResult as V, listDeclaredLivePreviewFinalizerCapabilities as W, verifyChannelMessageReceiveAckPolicyAdapterProofs as X, verifyChannelMessageLiveFinalizerProofs as Y, verifyChannelMessageReceiveAckPolicyProofs as Z, DurableMessageSendState as _, deliverInboundReplyWithMessageSendContext as a, createDurableMessageStateRecord as b, hasVisibleChannelMessageReplyDispatch as c, sendDurableMessageBatch as d, ChannelMessageOutboundBridgeAdapter as et, withDurableMessageSendContext as f, DurableMessageSendContextParams as g, DurableMessageSendContext as h, deliverDurableInboundReplyPayload as i, deriveDurableFinalDeliveryRequirements as it, ChannelMessageLiveCapabilityProofMap as j, resolveMessageReceiptPrimaryId as k, recordChannelMessageReplyDispatch as l, DurableMessageBatchSendResult as m, createChannelTurnReplyPipeline as n, CreateChannelMessageAdapterFromOutboundParams as nt, dispatchChannelMessageReplyWithBase as o, DurableMessageBatchSendParams as p, verifyChannelMessageLiveCapabilityAdapterProofs as q, defineChannelMessageAdapter as r, createChannelMessageAdapterFromOutbound as rt, hasFinalChannelMessageReplyDispatch as s, buildChannelMessageReplyDispatchBase as t, ChannelMessageOutboundBridgeResult as tt, resolveChannelMessageReplyDispatchCounts as u, DurableMessageStateRecord as v, MessageReceiveContext as w, MessageAckPolicy as x, classifyDurableSendRecoveryState as y, LivePreviewFinalizerCapabilityProof as z };