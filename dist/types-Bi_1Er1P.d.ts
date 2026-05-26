import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { r as GroupKeyResolution } from "./types-D2DuU_TB.js";
import { n as MsgContext, t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { N as MessageReceipt } from "./types-Bu3TUX-L.js";
import { t as ReplyDispatchKind } from "./reply-dispatcher.types-CGAU-6ZQ.js";
import { n as RecordInboundSession, t as InboundLastRouteUpdate } from "./session.types-D13vJnoJ.js";
import { r as GetReplyFromConfig, t as DispatchFromConfigResult } from "./dispatch-from-config.types-CYgSbSAE.js";
import { n as CreateChannelReplyPipelineParams } from "./reply-pipeline-DaurkekJ.js";
import { r as HistoryEntry } from "./history-0cWkJHfd.js";
import { i as ReplyDispatcherWithTypingOptions, t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-CZaOPGb3.js";
import { a as OutboundDeliveryQueuePolicy, r as DurableFinalDeliveryRequirements, t as DeliverOutboundPayloadsParams } from "./deliver-BFHGr8Aj.js";

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
export { PreparedChannelTurn as C, RunResolvedChannelTurnParams as D, RunChannelTurnParams as E, SenderFacts as O, PreflightFacts as S, RouteFacts as T, ConversationFacts as _, ChannelDeliveryResult as a, MessageFacts as b, ChannelTurnAdmission as c, ChannelTurnHistoryFinalizeOptions as d, ChannelTurnLogEvent as f, ChannelTurnResult as g, ChannelTurnResolved as h, ChannelDeliveryIntent as i, SupplementalContextFacts as k, ChannelTurnDeliveryAdapter as l, ChannelTurnReplyPipelineOptions as m, AssembledChannelTurn as n, ChannelEventClass as o, ChannelTurnRecordOptions as p, ChannelDeliveryInfo as r, ChannelTurnAdapter as s, AccessFacts as t, ChannelTurnDispatcherOptions as u, DispatchedChannelTurnResult as v, ReplyPlanFacts as w, NormalizedTurnInput as x, InboundMediaFacts as y };