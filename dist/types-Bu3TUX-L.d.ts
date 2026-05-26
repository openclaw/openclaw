import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { T as ReplyToMode } from "./types.base-DCoxbfrn.js";
import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { t as OutboundSendDeps } from "./send-deps--cyJDjZ7.js";
import { t as OutboundMediaAccess } from "./load-options-Dc-kAx-U.js";

//#region src/channels/message/types.d.ts
type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";
declare const durableFinalDeliveryCapabilities: readonly ["text", "media", "payload", "silent", "replyTo", "thread", "nativeQuote", "messageSendingHooks", "batch", "reconcileUnknownSend", "afterSendSuccess", "afterCommit"];
type DurableFinalDeliveryCapability = (typeof durableFinalDeliveryCapabilities)[number];
type DurableFinalDeliveryRequirementMap = Partial<Record<DurableFinalDeliveryCapability, boolean>>;
type DurableFinalDeliveryPayloadShape = {
  text?: string | null;
  replyToId?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: readonly (string | null | undefined)[] | null;
};
type MessageReceiptSourceResult = {
  channel?: string;
  messageId?: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  toJid?: string;
  pollId?: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
};
type MessageReceiptPartKind = "text" | "media" | "voice" | "card" | "preview" | "unknown";
type MessageReceiptPart = {
  platformMessageId: string;
  kind: MessageReceiptPartKind;
  index: number;
  threadId?: string;
  replyToId?: string;
  raw?: MessageReceiptSourceResult;
};
type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: readonly MessageReceiptSourceResult[];
};
type RenderedMessageBatchPlanKind = "text" | "media" | "voice" | "presentation" | "interactive" | "channelData" | "empty";
type RenderedMessageBatchPlanItem = {
  index: number;
  kinds: readonly RenderedMessageBatchPlanKind[];
  text?: string;
  mediaUrls: readonly string[];
  audioAsVoice?: boolean;
  presentationBlockCount?: number;
  hasInteractive?: boolean;
  hasChannelData?: boolean;
};
type RenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};
type RenderedMessageBatch<TPayload = unknown> = {
  payloads: TPayload[];
  plan: RenderedMessageBatchPlan;
};
type LiveMessagePhase = "idle" | "previewing" | "finalizing" | "finalized" | "cancelled";
type LiveMessageState<TPayload = unknown> = {
  phase: LiveMessagePhase;
  canFinalizeInPlace: boolean;
  receipt?: MessageReceipt;
  lastRendered?: RenderedMessageBatch<TPayload>;
};
type MessageSendContext<TPayload = unknown, TSendResult = unknown> = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  attempt: number;
  signal: AbortSignal;
  intent?: DurableMessageSendIntent;
  previousReceipt?: MessageReceipt;
  preview?: LiveMessageState<TPayload>;
  render(): Promise<RenderedMessageBatch<TPayload>>;
  previewUpdate(rendered: RenderedMessageBatch<TPayload>): Promise<LiveMessageState<TPayload>>;
  send(rendered: RenderedMessageBatch<TPayload>): Promise<TSendResult>;
  edit(receipt: MessageReceipt, rendered: RenderedMessageBatch<TPayload>): Promise<MessageReceipt>;
  delete(receipt: MessageReceipt): Promise<void>;
  commit(receipt: MessageReceipt): Promise<void>;
  fail(error: unknown): Promise<void>;
};
type ChannelMessageSendTextContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  to: string;
  text: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
  gatewayClientScopes?: readonly string[];
};
type ChannelMessageSendMediaContext<TConfig = OpenClawConfig> = ChannelMessageSendTextContext<TConfig> & {
  mediaUrl: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  audioAsVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
};
type ChannelMessageSendPayloadContext<TConfig = OpenClawConfig> = ChannelMessageSendTextContext<TConfig> & {
  payload: ReplyPayload;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  audioAsVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
};
type ChannelMessageSendResult = {
  receipt: MessageReceipt;
  messageId?: string;
};
type ChannelMessageSendAttemptKind = "text" | "media" | "payload";
type ChannelMessageSendAttemptContext<TConfig = OpenClawConfig> = (ChannelMessageSendTextContext<TConfig> & {
  kind: "text";
}) | (ChannelMessageSendMediaContext<TConfig> & {
  kind: "media";
}) | (ChannelMessageSendPayloadContext<TConfig> & {
  kind: "payload";
});
type ChannelMessageSendSuccessContext<TConfig = OpenClawConfig, TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult> = ChannelMessageSendAttemptContext<TConfig> & {
  result: TSendResult;
  attemptToken?: unknown;
};
type ChannelMessageSendFailureContext<TConfig = OpenClawConfig> = ChannelMessageSendAttemptContext<TConfig> & {
  error: unknown;
  attemptToken?: unknown;
};
type ChannelMessageSendCommitContext<TConfig = OpenClawConfig, TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult> = ChannelMessageSendSuccessContext<TConfig, TSendResult>;
type ChannelMessageUnknownSendContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  queueId: string;
  channel: string;
  to: string;
  accountId?: string | null;
  enqueuedAt: number;
  retryCount: number;
  platformSendStartedAt?: number;
  payloads: readonly ReplyPayload[];
  renderedBatchPlan?: RenderedMessageBatchPlan;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
};
type ChannelMessageUnknownSendReconciliationResult = {
  status: "sent";
  receipt: MessageReceipt;
  messageId?: string;
} | {
  status: "not_sent";
} | {
  status: "unresolved";
  error?: string;
  retryable?: boolean;
};
type ChannelMessageSendLifecycleAdapter<TConfig = OpenClawConfig, TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult> = {
  beforeSendAttempt?: (ctx: ChannelMessageSendAttemptContext<TConfig>) => unknown;
  afterSendSuccess?: (ctx: ChannelMessageSendSuccessContext<TConfig, TSendResult>) => Promise<void> | void;
  afterSendFailure?: (ctx: ChannelMessageSendFailureContext<TConfig>) => Promise<void> | void;
  afterCommit?: (ctx: ChannelMessageSendCommitContext<TConfig, TSendResult>) => Promise<void> | void;
};
type ChannelMessageSendAdapter<TConfig = OpenClawConfig, TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult> = {
  text?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<TSendResult>;
  media?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<TSendResult>;
  payload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<TSendResult>;
  lifecycle?: ChannelMessageSendLifecycleAdapter<TConfig, TSendResult>;
};
type ChannelMessageDurableFinalAdapter = {
  capabilities?: DurableFinalDeliveryRequirementMap;
  reconcileUnknownSend?: (ctx: ChannelMessageUnknownSendContext) => Promise<ChannelMessageUnknownSendReconciliationResult | null> | ChannelMessageUnknownSendReconciliationResult | null;
};
type ChannelMessageLiveCapability = "draftPreview" | "previewFinalization" | "progressUpdates" | "nativeStreaming" | "quietFinalization";
declare const livePreviewFinalizerCapabilities: readonly ["finalEdit", "normalFallback", "discardPending", "previewReceipt", "retainOnAmbiguousFailure"];
type LivePreviewFinalizerCapability = (typeof livePreviewFinalizerCapabilities)[number];
type LivePreviewFinalizerCapabilityMap = Partial<Record<LivePreviewFinalizerCapability, boolean>>;
type ChannelMessageLiveFinalizerAdapterShape = {
  capabilities?: LivePreviewFinalizerCapabilityMap;
};
type ChannelMessageLiveAdapterShape = {
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  finalizer?: ChannelMessageLiveFinalizerAdapterShape;
};
type ChannelMessageReceiveAckPolicy = "after_receive_record" | "after_agent_dispatch" | "after_durable_send" | "manual";
type ChannelMessageReceiveAdapterShape = {
  defaultAckPolicy?: ChannelMessageReceiveAckPolicy;
  supportedAckPolicies?: readonly ChannelMessageReceiveAckPolicy[];
};
type ChannelMessageAdapterShape<TConfig = OpenClawConfig, TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult> = {
  id?: string;
  durableFinal?: ChannelMessageDurableFinalAdapter;
  send?: ChannelMessageSendAdapter<TConfig, TSendResult>;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};
type ChannelMessageAdapter<TAdapter extends ChannelMessageAdapterShape = ChannelMessageAdapterShape> = TAdapter;
type DurableFinalRequirementExtras = DurableFinalDeliveryRequirementMap;
type DeriveDurableFinalDeliveryRequirementsParams = {
  payload: DurableFinalDeliveryPayloadShape;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean;
  messageSendingHooks?: boolean;
  payloadTransport?: boolean;
  batch?: boolean;
  reconcileUnknownSend?: boolean;
  afterSendSuccess?: boolean;
  afterCommit?: boolean;
  extraCapabilities?: DurableFinalRequirementExtras;
};
type DurableMessageSendIntent<TPayload = unknown> = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  renderedBatch?: RenderedMessageBatch<TPayload>;
};
//#endregion
export { LivePreviewFinalizerCapability as A, RenderedMessageBatchPlanItem as B, DurableFinalDeliveryCapability as C, DurableMessageSendIntent as D, DurableFinalRequirementExtras as E, MessageReceiptPartKind as F, MessageReceiptSourceResult as I, MessageSendContext as L, MessageDurabilityPolicy as M, MessageReceipt as N, LiveMessagePhase as O, MessageReceiptPart as P, RenderedMessageBatch as R, DeriveDurableFinalDeliveryRequirementsParams as S, DurableFinalDeliveryRequirementMap as T, RenderedMessageBatchPlanKind as V, ChannelMessageSendResult as _, ChannelMessageLiveCapability as a, ChannelMessageUnknownSendContext as b, ChannelMessageReceiveAdapterShape as c, ChannelMessageSendAttemptKind as d, ChannelMessageSendCommitContext as f, ChannelMessageSendPayloadContext as g, ChannelMessageSendMediaContext as h, ChannelMessageLiveAdapterShape as i, LivePreviewFinalizerCapabilityMap as j, LiveMessageState as k, ChannelMessageSendAdapter as l, ChannelMessageSendLifecycleAdapter as m, ChannelMessageAdapterShape as n, ChannelMessageLiveFinalizerAdapterShape as o, ChannelMessageSendFailureContext as p, ChannelMessageDurableFinalAdapter as r, ChannelMessageReceiveAckPolicy as s, ChannelMessageAdapter as t, ChannelMessageSendAttemptContext as u, ChannelMessageSendSuccessContext as v, DurableFinalDeliveryPayloadShape as w, ChannelMessageUnknownSendReconciliationResult as x, ChannelMessageSendTextContext as y, RenderedMessageBatchPlan as z };