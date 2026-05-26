import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { r as GroupKeyResolution } from "./types-ChLEnNVH.js";
import { a as CommandTurnKind, n as MsgContext, t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { n as HistoryMediaEntry, t as HistoryEntry } from "./history.types-D_WxL2c8.js";
import { P as MessageReceipt } from "./types-CxkJAgkR.js";
import { t as ReplyDispatchKind } from "./reply-dispatcher.types-ZeVAzUxF.js";
import { n as RecordInboundSession, t as InboundLastRouteUpdate } from "./session.types-B-nEI62r.js";
import { r as GetReplyFromConfig, t as DispatchFromConfigResult } from "./dispatch-from-config.types-D9GatrrF.js";
import { n as CreateChannelReplyPipelineParams } from "./reply-pipeline-C0u97xVG.js";
import { i as ReplyDispatcherWithTypingOptions, t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-sSkHKICV.js";
import { a as OutboundDeliveryQueuePolicy, r as DurableFinalDeliveryRequirements, t as DeliverOutboundPayloadsParams } from "./deliver-YxyJPFrS.js";
import { a as PairLoopGuardResult, i as PairLoopGuardConfig, s as PairLoopGuardSnapshotEntry } from "./pair-loop-guard-runtime-Dsjpip3a.js";

//#region src/channels/turn/bot-loop-protection.d.ts
type ChannelBotLoopProtectionFacts = {
  scopeId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  config?: PairLoopGuardConfig;
  defaultsConfig?: PairLoopGuardConfig;
  defaultEnabled: boolean;
  nowMs?: number;
};
declare function recordChannelBotPairLoopAndCheckSuppression(params: ChannelBotLoopProtectionFacts): PairLoopGuardResult;
declare function clearChannelBotPairLoopGuardForTests(): void;
declare function listTrackedChannelBotPairsForTests(): PairLoopGuardSnapshotEntry[];
//#endregion
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
  id?: string;
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
  messageThreadId?: string | number;
  threadParentId?: string;
  sourceReplyDeliveryMode?: "thread" | "reply" | "channel" | "direct" | "none";
};
type ProjectedAllowlistAccessFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode?: string;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
};
type ProjectedEventAccessFacts = {
  kind: "message" | "reaction" | "button" | "postback" | "native-command" | "slash-command" | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  authorized: boolean;
  reasonCode?: string;
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
};
type AccessFacts = {
  dm?: {
    decision: "allow" | "pairing" | "deny";
    reason?: string;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  group?: {
    policy: "open" | "allowlist" | "disabled";
    routeAllowed: boolean;
    senderAllowed: boolean;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    requireMention: boolean;
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  commands?: {
    authorized?: boolean;
    shouldBlockControlCommand?: boolean;
    reasonCode?: string;
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    /**
     * @deprecated Shared ingress projections do not expose raw authorizer lists.
     * Use authorized and reasonCode instead.
     */
    authorizers: Array<{
      configured: boolean;
      allowed: boolean;
    }>;
  };
  event?: ProjectedEventAccessFacts;
  mentions?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: Array<"reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native">;
    requireMention?: boolean;
    effectiveWasMentioned?: boolean;
    shouldSkip?: boolean;
  };
};
type MessageFacts = {
  inboundEventKind?: InboundEventKind;
  body?: string;
  rawBody: string;
  bodyForAgent?: string;
  commandBody?: string;
  envelopeFrom: string;
  senderLabel?: string;
  preview?: string;
  inboundHistory?: HistoryEntry[];
};
type CommandFacts = {
  kind: CommandTurnKind;
  body?: string;
  name?: string;
  authorized?: boolean;
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
  untrustedContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
  groupSystemPrompt?: string;
};
type InboundMediaFacts = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
  messageId?: string;
};
type MaybePromise<T> = T | Promise<T>;
type PreflightFacts = {
  admission?: ChannelTurnAdmission;
  command?: CommandFacts;
  message?: Partial<MessageFacts>;
  media?: readonly InboundMediaFacts[] | (() => MaybePromise<readonly InboundMediaFacts[] | readonly HistoryMediaEntry[] | null | undefined>);
  supplemental?: SupplementalContextFacts;
  history?: ChannelTurnDroppedHistoryOptions;
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
type ChannelEventDeliveryAdapter = {
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
type ChannelTurnDroppedHistoryOptions = {
  key: string;
  limit: number;
  historyMap: Map<string, HistoryEntry[]>;
  recordOnDrop?: boolean;
  mediaLimit?: number;
  shouldRecord?: () => boolean;
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
  delivery: ChannelEventDeliveryAdapter;
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  admission?: Extract<ChannelTurnAdmission, {
    kind: "dispatch" | "observeOnly";
  }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
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
  botLoopProtection?: ChannelBotLoopProtectionFacts;
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
export { SenderFacts as A, NormalizedTurnInput as C, RouteFacts as D, ReplyPlanFacts as E, recordChannelBotPairLoopAndCheckSuppression as F, ChannelBotLoopProtectionFacts as M, clearChannelBotPairLoopGuardForTests as N, RunChannelTurnParams as O, listTrackedChannelBotPairsForTests as P, MessageFacts as S, PreparedChannelTurn as T, ChannelTurnResult as _, ChannelDeliveryResult as a, DispatchedChannelTurnResult as b, ChannelTurnAdapter as c, ChannelTurnDroppedHistoryOptions as d, ChannelTurnHistoryFinalizeOptions as f, ChannelTurnResolved as g, ChannelTurnReplyPipelineOptions as h, ChannelDeliveryIntent as i, SupplementalContextFacts as j, RunResolvedChannelTurnParams as k, ChannelTurnAdmission as l, ChannelTurnRecordOptions as m, AssembledChannelTurn as n, ChannelEventClass as o, ChannelTurnLogEvent as p, ChannelDeliveryInfo as r, ChannelEventDeliveryAdapter as s, AccessFacts as t, ChannelTurnDispatcherOptions as u, CommandFacts as v, PreflightFacts as w, InboundMediaFacts as x, ConversationFacts as y };