import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { d as ContextVisibilityMode } from "./types.base-CN1BlTRP.js";
import { r as GroupKeyResolution } from "./types-Choy2DhC.js";
import { r as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-eDPD5YMs.js";
import { n as MsgContext, t as FinalizedMsgContext } from "./templating-DxY-klDK.js";
import { N as MessageReceipt } from "./types-1FFtdezw.js";
import { t as ReplyDispatchKind } from "./reply-dispatcher.types-0N-YQrvq.js";
import { n as RecordInboundSession, t as InboundLastRouteUpdate } from "./session.types-BpTftTrX.js";
import { r as GetReplyFromConfig, t as DispatchFromConfigResult } from "./dispatch-from-config.types-DjXN9YsE.js";
import { i as createChannelReplyPipeline, n as CreateChannelReplyPipelineParams } from "./reply-pipeline-BPInIQpI.js";
import { r as HistoryEntry } from "./history-CS-CwrxB.js";
import { i as ReplyDispatcherWithTypingOptions, t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-CaRZ30w6.js";
import { a as OutboundDeliveryQueuePolicy, n as DurableFinalDeliveryRequirement, r as DurableFinalDeliveryRequirements, t as DeliverOutboundPayloadsParams } from "./deliver-cQqrRkeK.js";
import { a as hasVisibleChannelTurnDispatch, i as hasFinalChannelTurnDispatch, n as ChannelTurnVisibleDeliverySignals, o as resolveChannelTurnDispatchCounts, r as EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, t as ChannelTurnDispatchResultLike } from "./dispatch-result-DNqTNc9v.js";

//#region src/channels/turn/types.d.ts
type ChannelTurnAdmission = {
  kind: "dispatch";
  reason?: string;
} | {
  kind: "observeOnly";
  reason: string;
} | {
  kind: "handled";
  reason: string;
} | {
  kind: "drop";
  reason: string;
  recordHistory?: boolean;
};
type ChannelEventClass = {
  kind: "message" | "command" | "interaction" | "reaction" | "lifecycle" | "unknown";
  canStartAgentTurn: boolean;
  requiresImmediateAck?: boolean;
};
type NormalizedTurnInput = {
  id: string;
  timestamp?: number;
  rawText: string;
  textForAgent?: string;
  textForCommands?: string;
  raw?: unknown;
};
type SenderFacts = {
  id: string;
  name?: string;
  username?: string;
  tag?: string;
  roles?: string[];
  isBot?: boolean;
  isSelf?: boolean;
  displayLabel?: string;
};
type ConversationFacts = {
  kind: "direct" | "group" | "channel";
  id: string;
  label?: string;
  spaceId?: string;
  parentId?: string;
  threadId?: string;
  nativeChannelId?: string;
  routePeer: {
    kind: "direct" | "group" | "channel";
    id: string;
  };
};
type RouteFacts = {
  agentId: string;
  accountId?: string;
  routeSessionKey: string;
  dispatchSessionKey?: string;
  persistedSessionKey?: string;
  parentSessionKey?: string;
  modelParentSessionKey?: string;
  mainSessionKey?: string;
  createIfMissing?: boolean;
};
type ReplyPlanFacts = {
  to: string;
  originatingTo: string;
  nativeChannelId?: string;
  replyTarget?: string;
  deliveryTarget?: string;
  replyToId?: string;
  replyToIdFull?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sourceReplyDeliveryMode?: "thread" | "reply" | "channel" | "direct" | "none";
};
type AccessFacts = {
  dm?: {
    decision: "allow" | "pairing" | "deny";
    reason?: string;
    allowFrom: string[];
  };
  group?: {
    policy: "open" | "allowlist" | "disabled";
    routeAllowed: boolean;
    senderAllowed: boolean;
    allowFrom: string[];
    requireMention: boolean;
  };
  commands?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    authorizers: Array<{
      configured: boolean;
      allowed: boolean;
    }>;
  };
  mentions?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: Array<"reply_to_bot" | "bot_thread_participant" | "native">;
  };
};
type MessageFacts = {
  body?: string;
  rawBody: string;
  bodyForAgent?: string;
  commandBody?: string;
  envelopeFrom: string;
  senderLabel?: string;
  preview?: string;
  inboundHistory?: Array<{
    sender: string;
    body: string;
    timestamp?: number;
  }>;
};
type SupplementalContextFacts = {
  quote?: {
    id?: string;
    fullId?: string;
    body?: string;
    sender?: string;
    senderAllowed?: boolean;
    isExternal?: boolean;
    isQuote?: boolean;
  };
  forwarded?: {
    from?: string;
    fromType?: string;
    fromId?: string;
    date?: number;
    senderAllowed?: boolean;
  };
  thread?: {
    id?: string;
    starterBody?: string;
    historyBody?: string;
    label?: string;
    parentSessionKey?: string;
    modelParentSessionKey?: string;
    senderAllowed?: boolean;
  };
  untrustedContext?: unknown[];
  groupSystemPrompt?: string;
};
type InboundMediaFacts = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
};
type PreflightFacts = {
  admission?: ChannelTurnAdmission;
  message?: Partial<MessageFacts>;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
};
type ChannelDeliveryInfo = {
  kind: ReplyDispatchKind;
};
type ChannelDeliveryIntent = {
  id: string;
  kind: "outbound_queue";
  queuePolicy: OutboundDeliveryQueuePolicy;
};
type ChannelDeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  deliveryIntent?: ChannelDeliveryIntent;
};
type ChannelTurnDurableDeliveryOptions = Pick<DeliverOutboundPayloadsParams, "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};
type ChannelTurnDeliveryAdapter = {
  preparePayload?: (payload: ReplyPayload, info: ChannelDeliveryInfo) => Promise<ReplyPayload> | ReplyPayload;
  deliver: (payload: ReplyPayload, info: ChannelDeliveryInfo) => Promise<ChannelDeliveryResult | void>;
  durable?: false | ChannelTurnDurableDeliveryOptions | ((payload: ReplyPayload, info: ChannelDeliveryInfo) => false | ChannelTurnDurableDeliveryOptions | Promise<false | ChannelTurnDurableDeliveryOptions>);
  onDelivered?: (payload: ReplyPayload, info: ChannelDeliveryInfo, result: ChannelDeliveryResult | void) => Promise<void> | void;
  onError?: (err: unknown, info: {
    kind: string;
  }) => void;
};
type ChannelTurnRecordOptions = {
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError?: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
};
type ChannelTurnHistoryFinalizeOptions = {
  isGroup?: boolean;
  historyKey?: string;
  historyMap?: Map<string, HistoryEntry[]>;
  limit?: number;
};
type ChannelTurnDispatcherOptions = Omit<ReplyDispatcherWithTypingOptions, "deliver" | "onError">;
type ChannelTurnReplyPipelineOptions = Omit<CreateChannelReplyPipelineParams, "cfg" | "agentId" | "channel" | "accountId">;
type AssembledChannelTurn = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  delivery: ChannelTurnDeliveryAdapter;
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  admission?: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};
type PreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  onPreDispatchFailure?: (err: unknown) => void | Promise<void>;
  runDispatch: () => Promise<TDispatchResult>;
  observeOnlyDispatchResult?: TDispatchResult;
  admission?: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};
type ChannelTurnResolved<TDispatchResult = DispatchFromConfigResult> = (AssembledChannelTurn & {
  admission?: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
}) | (PreparedChannelTurn<TDispatchResult> & {
  admission?: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
});
type ChannelTurnStage = "ingest" | "classify" | "preflight" | "resolve" | "authorize" | "assemble" | "record" | "dispatch" | "finalize";
type ChannelTurnLogEvent = {
  stage: ChannelTurnStage;
  event: "start" | "done" | "drop" | "handled" | "error";
  channel: string;
  accountId?: string;
  messageId?: string;
  sessionKey?: string;
  admission?: ChannelTurnAdmission["kind"];
  reason?: string;
  error?: unknown;
};
type ChannelTurnResult<TDispatchResult = DispatchFromConfigResult> = DispatchedChannelTurnResult<TDispatchResult> | {
  admission: ChannelTurnAdmission;
  dispatched: false;
  ctxPayload?: MsgContext;
  routeSessionKey?: string;
};
type DispatchedChannelTurnResult<TDispatchResult = DispatchFromConfigResult> = {
  admission: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
  dispatched: true;
  ctxPayload: MsgContext;
  routeSessionKey: string;
  dispatchResult: TDispatchResult;
};
type ChannelTurnAdapter<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  ingest: (raw: TRaw) => Promise<NormalizedTurnInput | null> | NormalizedTurnInput | null;
  classify?: (input: NormalizedTurnInput) => Promise<ChannelEventClass> | ChannelEventClass;
  preflight?: (input: NormalizedTurnInput, eventClass: ChannelEventClass) => Promise<PreflightFacts | ChannelTurnAdmission | null | undefined> | PreflightFacts | ChannelTurnAdmission | null | undefined;
  resolveTurn: (input: NormalizedTurnInput, eventClass: ChannelEventClass, preflight: PreflightFacts) => Promise<ChannelTurnResolved<TDispatchResult>> | ChannelTurnResolved<TDispatchResult>;
  onFinalize?: (result: ChannelTurnResult<TDispatchResult>) => Promise<void> | void;
};
type RunChannelTurnParams<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  raw: TRaw;
  adapter: ChannelTurnAdapter<TRaw, TDispatchResult>;
  log?: (event: ChannelTurnLogEvent) => void;
};
type RunResolvedChannelTurnParams<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  raw: TRaw;
  input: NormalizedTurnInput | ((raw: TRaw) => Promise<NormalizedTurnInput | null> | NormalizedTurnInput | null);
  resolveTurn: (input: NormalizedTurnInput, eventClass: ChannelEventClass, preflight: PreflightFacts) => Promise<ChannelTurnResolved<TDispatchResult>> | ChannelTurnResolved<TDispatchResult>;
  log?: (event: ChannelTurnLogEvent) => void;
};
//#endregion
//#region src/channels/turn/context.d.ts
type BuildChannelTurnContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  access?: AccessFacts;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};
declare function filterChannelTurnSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined;
declare function buildChannelTurnContext(params: BuildChannelTurnContextParams): FinalizedMsgContext;
//#endregion
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
export { runResolvedChannelTurn as a, DurableInboundReplyDeliveryResult as c, ChannelTurnRecordOptions as d, ChannelTurnResult as f, RunChannelTurnParams as h, runPreparedChannelTurn as i, deliverInboundReplyWithMessageSendContext as l, PreparedChannelTurn as m, kernel_d_exports as n, DurableInboundReplyDeliveryOptions as o, DispatchedChannelTurnResult as p, runChannelTurn as r, DurableInboundReplyDeliveryParams as s, dispatchAssembledChannelTurn as t, buildChannelTurnContext as u };