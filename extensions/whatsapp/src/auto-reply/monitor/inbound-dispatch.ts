import { handleWhatsAppReactAction } from "../../channel-react-action.js";
import {
  analyzeWhatsAppEmotionTextShape,
  type WhatsAppEmotionTextShape,
} from "../../emotion-pulse.js";
import { resolveWhatsAppAllowedReactions } from "../../reaction-policy.js";
import type { WebInboundMsg } from "../types.js";
import type { GroupAddresseeDecision } from "./group-addressee.js";
import { formatGroupMembers } from "./group-members.js";
import type { GroupMessageSignalDecision } from "./group-message-signal.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import {
  createChannelReplyPipeline,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
  getAgentScopedMediaLocalRoots,
  jidToE164,
  logVerbose,
  resolveChunkMode,
  resolveIdentityNamePrefix,
  resolveInboundLastRouteSessionKey,
  resolveMarkdownTableMode,
  resolveSendableOutboundReplyParts,
  resolveTextChunkLimit,
  shouldLogVerbose,
  toLocationContext,
  type getChildLogger,
  type getReplyFromConfig,
  type LoadConfigFn,
  type ReplyPayload,
  type resolveAgentRoute,
} from "./inbound-dispatch.runtime.js";

type ReplyLifecycleKind = "tool" | "block" | "final";
type WhatsAppSourceReplyDeliveryMode = "automatic" | "message_tool_only";
type ChannelReplyOnModelSelected = NonNullable<
  ReturnType<typeof createChannelReplyPipeline>["onModelSelected"]
>;

type WhatsAppDispatchPipeline = {
  responsePrefix?: string;
} & Record<string, unknown>;

type VisibleReplyTarget = {
  id?: string;
  body?: string;
  sender?: {
    label?: string | null;
    jid?: string | null;
    lid?: string | null;
    e164?: string | null;
  } | null;
};

type ReplyThreadingContext = {
  implicitCurrentMessage?: "default" | "allow" | "deny";
};

type SenderContext = {
  id?: string;
  name?: string;
  e164?: string;
};

type WhatsAppAutonomyDecision =
  | { kind: "silence"; reason?: string }
  | { kind: "defer"; reason?: string }
  | { kind: "reaction"; emoji: string; messageId?: string }
  | { kind: "text"; body: string }
  | { kind: "text_and_reaction"; body: string; emoji: string; messageId?: string };

function parseWhatsAppAutonomyDecision(text: string | undefined): WhatsAppAutonomyDecision | null {
  const trimmed = text?.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const envelope = (parsed as Record<string, unknown>).openclaw_reply;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return null;
  }
  const record = envelope as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  const emoji = typeof record.emoji === "string" ? record.emoji.trim() : "";
  const messageId =
    typeof record.messageId === "string"
      ? record.messageId.trim()
      : typeof record.message_id === "string"
        ? record.message_id.trim()
        : undefined;
  if (kind === "silence") {
    return { kind, reason: typeof record.reason === "string" ? record.reason.trim() : undefined };
  }
  if (kind === "defer") {
    return { kind, reason: typeof record.reason === "string" ? record.reason.trim() : undefined };
  }
  if (kind === "reaction" && emoji) {
    return { kind, emoji, ...(messageId ? { messageId } : {}) };
  }
  if (kind === "text" && body) {
    return { kind, body };
  }
  if (kind === "text_and_reaction" && body && emoji) {
    return { kind, body, emoji, ...(messageId ? { messageId } : {}) };
  }
  return null;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function sameLooseIdentity(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = a?.replace(/\D/g, "") ?? "";
  const right = b?.replace(/\D/g, "") ?? "";
  if (left.length >= 6 && right.length >= 6 && left === right) {
    return true;
  }
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

function isLikelySelfHistoryEntry(entry: GroupHistoryEntry, msg: WebInboundMsg): boolean {
  return (
    sameLooseIdentity(entry.senderJid, msg.selfJid) ||
    sameLooseIdentity(entry.senderJid, msg.selfE164) ||
    /\bshoar\b/i.test(entry.sender)
  );
}

function isLikelySiblingBotEntry(entry: GroupHistoryEntry, msg: WebInboundMsg): boolean {
  if (isLikelySelfHistoryEntry(entry, msg)) {
    return false;
  }
  return /\bbrodie\b/i.test(entry.sender);
}

function resolveReplyTargetKind(params: {
  msg: WebInboundMsg;
  visibleReplyTo?: VisibleReplyTarget;
}): "self" | "other" | "unknown" | undefined {
  const target = params.visibleReplyTo?.sender;
  if (!target) {
    return undefined;
  }
  if (
    sameLooseIdentity(target.jid ?? target.lid, params.msg.selfJid ?? params.msg.self?.jid) ||
    sameLooseIdentity(target.e164, params.msg.selfE164 ?? params.msg.self?.e164)
  ) {
    return "self";
  }
  return target.jid || target.lid || target.e164 || target.label ? "other" : "unknown";
}

function isOwnerPullForSmallResponse(addressee?: GroupAddresseeDecision): boolean {
  return (
    addressee?.reason === "owner_shoar_behavior_pull" ||
    addressee?.reason === "owner_self_reply_for_model_judgment" ||
    addressee?.reason === "second_person_owner_for_model_judgment" ||
    addressee?.reason === "owner_context_continuation_for_model_judgment" ||
    addressee?.reason === "owner_fragment_continuation_for_model_judgment" ||
    addressee?.reason === "owner_multi_agent_pull_for_model_judgment"
  );
}

function resolveRecommendedShape(params: {
  addressee?: GroupAddresseeDecision;
  signal?: GroupMessageSignalDecision;
  lane?: WebInboundMsg["queueLane"];
}): { shape: string; reason: string } {
  if (params.addressee?.allowReply === false) {
    return { shape: "silence", reason: `routing_guidance:${params.addressee.reason}` };
  }
  if (params.lane?.id === "direct_owner_pull" || isSelfAddressedGroupTurn(params.addressee)) {
    return { shape: "small_text", reason: "direct_pull_should_not_hide" };
  }
  if (params.lane?.id === "inline_reply_to_self") {
    return { shape: "small_text", reason: "inline_reply_to_self" };
  }
  if (isOwnerPullForSmallResponse(params.addressee)) {
    return { shape: "small_text", reason: "owner_pull_deserves_small_response" };
  }
  if (params.addressee?.confidence === "low") {
    return { shape: "silence", reason: "low_confidence_turn_take_only_if_it_adds_value" };
  }
  if (params.signal?.state === "casual_vibe") {
    return { shape: "tiny_ack", reason: "casual_room_smallest_complete_reply" };
  }
  return { shape: "small_text", reason: "default_group_reply_shape" };
}

function buildConversationStatePacket(params: {
  conversationId: string;
  groupHistory?: GroupHistoryEntry[];
  groupMessageSignal?: GroupMessageSignalDecision;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  sender: SenderContext;
  sourceReplyDeliveryMode?: WhatsAppSourceReplyDeliveryMode;
  visibleReplyTo?: VisibleReplyTarget;
}) {
  const history = params.groupHistory ?? [];
  const nowMs = normalizeTimestampMs(params.msg.timestamp) ?? Date.now();
  let lastGroupTimestamp: number | undefined;
  for (const entry of history.toReversed()) {
    const timestamp = normalizeTimestampMs(entry.timestamp);
    if (timestamp !== undefined) {
      lastGroupTimestamp = timestamp;
      break;
    }
  }
  const lastSelf = history
    .toReversed()
    .find((entry) => isLikelySelfHistoryEntry(entry, params.msg));
  const lastSelfTimestamp = normalizeTimestampMs(lastSelf?.timestamp);
  const lastSibling = history
    .toReversed()
    .find((entry) => isLikelySiblingBotEntry(entry, params.msg));
  const lastSiblingTimestamp = normalizeTimestampMs(lastSibling?.timestamp);
  const senderRecentEntries = history.filter((entry) => {
    const ts = normalizeTimestampMs(entry.timestamp);
    if (ts === undefined || nowMs - ts > 5 * 60_000) {
      return false;
    }
    return entry.senderJid
      ? sameLooseIdentity(entry.senderJid, params.msg.senderJid) ||
          sameLooseIdentity(entry.senderJid, params.msg.senderE164)
      : entry.sender === params.msg.senderName;
  });
  const recommended = resolveRecommendedShape({
    addressee: params.msg.groupAddressee,
    signal: params.groupMessageSignal,
    lane: params.msg.queueLane,
  });
  const replyRunPriorityLane = params.msg.queueLane
    ? params.msg.queueLane.priority <= 3
      ? "foreground"
      : "ambient"
    : undefined;
  return {
    schema: "openclaw.conversation_state.v1",
    channel: "whatsapp",
    account_id: params.route.accountId,
    session_key: params.route.sessionKey,
    chat: {
      id: params.conversationId,
      type: params.msg.chatType,
      subject: params.msg.groupSubject,
      is_multi_bot: params.msg.groupSubject
        ? /bot[-\s]?bros/i.test(params.msg.groupSubject)
        : undefined,
    },
    message: {
      id: params.msg.id,
      timestamp_ms: normalizeTimestampMs(params.msg.timestamp),
      was_mentioned: params.msg.wasMentioned === true,
      mentioned_jids: params.msg.mentionedJids,
    },
    sender: {
      id: params.sender.id,
      jid: params.msg.senderJid,
      e164: params.sender.e164,
      name: params.sender.name,
    },
    self: {
      jid: params.msg.selfJid ?? params.msg.self?.jid,
      lid: params.msg.selfLid ?? params.msg.self?.lid,
      e164: params.msg.selfE164 ?? params.msg.self?.e164,
    },
    reply_to: params.visibleReplyTo
      ? {
          id: params.visibleReplyTo.id,
          sender_label: params.visibleReplyTo.sender?.label,
          sender_jid: params.visibleReplyTo.sender?.jid ?? params.visibleReplyTo.sender?.lid,
          sender_e164: params.visibleReplyTo.sender?.e164,
          target_kind: resolveReplyTargetKind(params),
          body: params.visibleReplyTo.body,
        }
      : undefined,
    routing: {
      addressee: params.msg.groupAddressee
        ? {
            state: params.msg.groupAddressee.state,
            allow_reply: params.msg.groupAddressee.allowReply,
            reason: params.msg.groupAddressee.reason,
            confidence: params.msg.groupAddressee.confidence,
            debug: params.msg.groupAddressee.debug,
          }
        : undefined,
      lane: params.msg.queueLane,
      reply_run_priority_lane: replyRunPriorityLane,
    },
    signal: params.groupMessageSignal
      ? {
          state: params.groupMessageSignal.state,
          reason: params.groupMessageSignal.reason,
          max_reply_lines: params.groupMessageSignal.maxReplyLines,
          emotion_pulse: params.groupMessageSignal.emotionPulse,
          debug: params.groupMessageSignal.debug,
        }
      : undefined,
    burst: {
      size: params.msg.queueBurst?.size ?? (params.msg.isBatched ? undefined : 1),
      window_ms: params.msg.queueBurst?.windowMs,
      debounce_ms: params.msg.queueBurst?.debounceMs,
      max_wait_ms: params.msg.queueBurst?.maxWaitMs,
      max_batch_items: params.msg.queueBurst?.maxBatchItems,
      pending_ambient_burst: params.msg.pendingAmbientBurst,
    },
    tempo: {
      ms_since_last_group_message:
        lastGroupTimestamp === undefined ? undefined : Math.max(0, nowMs - lastGroupTimestamp),
      ms_since_last_shoar_message:
        lastSelfTimestamp === undefined ? undefined : Math.max(0, nowMs - lastSelfTimestamp),
      owner_cadence_last_5min: {
        messages: senderRecentEntries.length,
        avg_length:
          senderRecentEntries.length === 0
            ? undefined
            : Math.round(
                senderRecentEntries.reduce((sum, entry) => sum + entry.body.length, 0) /
                  senderRecentEntries.length,
              ),
      },
    },
    sibling_bot: {
      responded_since_last_shoar_message:
        lastSiblingTimestamp !== undefined &&
        (lastSelfTimestamp === undefined || lastSiblingTimestamp > lastSelfTimestamp),
      last_message: lastSibling
        ? {
            sender: lastSibling.sender,
            sender_jid: lastSibling.senderJid,
            body: lastSibling.body,
            timestamp_ms: lastSiblingTimestamp,
          }
        : undefined,
    },
    self_context: {
      last_message: lastSelf
        ? {
            body: lastSelf.body,
            timestamp_ms: lastSelfTimestamp,
          }
        : undefined,
    },
    delivery: {
      source_reply_delivery_mode: params.sourceReplyDeliveryMode,
    },
    output_guidance: {
      recommended_shape: recommended.shape,
      recommended_shape_reason: recommended.reason,
      max_reply_lines_advisory: params.groupMessageSignal?.maxReplyLines,
      reaction_tool: 'message(action="react")',
      structured_output_envelope:
        '{"openclaw_reply":{"kind":"text|reaction|text_and_reaction|silence|defer","body":"...","emoji":"..."}}',
    },
  };
}

function resolveWhatsAppDisableBlockStreaming(cfg: ReturnType<LoadConfigFn>): boolean | undefined {
  if (typeof cfg.channels?.whatsapp?.blockStreaming !== "boolean") {
    return undefined;
  }
  return !cfg.channels.whatsapp.blockStreaming;
}

function resolveWhatsAppDeliverablePayload(
  payload: ReplyPayload,
  info: { kind: ReplyLifecycleKind },
): ReplyPayload | null {
  if (payload.isReasoning === true || payload.isCompactionNotice === true) {
    return null;
  }
  if (info.kind === "tool") {
    if (!resolveSendableOutboundReplyParts(payload).hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  }
  return payload;
}

function countNonEmptyLines(value: string): number {
  return value.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}']+/gu)?.length ?? 0;
}

function isExactNoReplyText(value: string): boolean {
  return value.trim() === "NO_REPLY";
}

function isSelfAddressedGroupTurn(decision?: GroupAddresseeDecision): boolean {
  return (
    decision?.allowReply === true &&
    (decision.state === "addressed_to_self" || decision.state === "direct_task_to_self")
  );
}

function splitCompleteSentences(value: string): string[] {
  return value.match(/[^.!?\n]+[.!?]+(?=\s|$)/gu)?.map((sentence) => sentence.trim()) ?? [];
}

function summarizeGroupSignalText(
  value: string,
  cap: { maxReplyLines: number; maxWords: number; maxChars: number },
): string | undefined {
  const completeLines = value
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const lineCandidate = completeLines.slice(0, cap.maxReplyLines).join("\n").trim();
  if (
    lineCandidate &&
    countNonEmptyLines(lineCandidate) <= cap.maxReplyLines &&
    countWords(lineCandidate) <= cap.maxWords &&
    lineCandidate.length <= cap.maxChars
  ) {
    return lineCandidate;
  }

  const sentences = splitCompleteSentences(value);
  const chosen: string[] = [];
  for (const sentence of sentences) {
    const candidate = [...chosen, sentence].join(" ").trim();
    if (
      countNonEmptyLines(candidate) > cap.maxReplyLines ||
      countWords(candidate) > cap.maxWords ||
      candidate.length > cap.maxChars
    ) {
      break;
    }
    chosen.push(sentence);
  }

  return chosen.join(" ").trim() || undefined;
}

function resolveGroupSignalTextCap(params: {
  payload: ReplyPayload;
  signal?: GroupMessageSignalDecision;
  addressee?: GroupAddresseeDecision;
  allowedEmojis?: readonly string[];
  hasMedia: boolean;
}):
  | {
      exceeded: false;
    }
  | {
      exceeded: true;
      lineCount: number;
      wordCount: number;
      charCount: number;
      maxReplyLines: number;
      maxWords: number;
      maxChars: number;
      shapeReason?: string;
      shape?: WhatsAppEmotionTextShape;
    } {
  const maxReplyLines = params.signal?.maxReplyLines;
  if (
    params.hasMedia ||
    !maxReplyLines ||
    (params.signal?.state !== "low_signal_burst" && params.signal?.state !== "casual_vibe") ||
    typeof params.payload.text !== "string"
  ) {
    return { exceeded: false };
  }

  const text = params.payload.text.trim();
  if (!text) {
    return { exceeded: false };
  }
  if (isExactNoReplyText(text)) {
    return { exceeded: false };
  }

  const lineCount = countNonEmptyLines(text);
  const wordCount = countWords(text);
  const charCount = text.length;
  const directSelfTurn =
    isSelfAddressedGroupTurn(params.addressee) || isOwnerPullForSmallResponse(params.addressee);
  const effectiveMaxReplyLines = directSelfTurn ? Math.max(maxReplyLines, 4) : maxReplyLines;
  const maxWords = effectiveMaxReplyLines * (directSelfTurn ? 22 : 11);
  const maxChars = effectiveMaxReplyLines * (directSelfTurn ? 140 : 70);
  const shape = analyzeWhatsAppEmotionTextShape({
    text,
    allowedEmojis: params.allowedEmojis,
  });
  const shapeReason =
    !shape.emojiOnly && shape.emojiCount > 2
      ? "too_many_text_emojis"
      : shape.emojiOnly && shape.emojiCount > 7
        ? "emoji_only_burst_too_long"
        : shape.uppercaseWordCount > 5
          ? "too_many_caps_words"
          : shape.uppercaseWordCount >= 2 && shape.emojiCount > 2
            ? "mixed_caps_and_emoji_bursts"
            : undefined;
  if (shapeReason) {
    return {
      exceeded: true,
      lineCount,
      wordCount,
      charCount,
      maxReplyLines: effectiveMaxReplyLines,
      maxWords,
      maxChars,
      shapeReason,
      shape,
    };
  }
  if (lineCount <= effectiveMaxReplyLines && wordCount <= maxWords && charCount <= maxChars) {
    return { exceeded: false };
  }
  return {
    exceeded: true,
    lineCount,
    wordCount,
    charCount,
    maxReplyLines: effectiveMaxReplyLines,
    maxWords,
    maxChars,
    shape,
  };
}

export function resolveWhatsAppResponsePrefix(params: {
  cfg: ReturnType<LoadConfigFn>;
  agentId: string;
  isSelfChat: boolean;
  pipelineResponsePrefix?: string;
}): string | undefined {
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  return (
    params.pipelineResponsePrefix ??
    (configuredResponsePrefix === undefined && params.isSelfChat
      ? resolveIdentityNamePrefix(params.cfg, params.agentId)
      : undefined)
  );
}

export function buildWhatsAppInboundContext(params: {
  bodyForAgent?: string;
  combinedBody: string;
  commandBody?: string;
  commandAuthorized?: boolean;
  conversationId: string;
  groupHistory?: GroupHistoryEntry[];
  groupMemberRoster?: Map<string, string>;
  groupMessageSignal?: GroupMessageSignalDecision;
  groupSystemPrompt?: string;
  msg: WebInboundMsg;
  rawBody?: string;
  route: ReturnType<typeof resolveAgentRoute>;
  sender: SenderContext;
  transcript?: string;
  mediaTranscribedIndexes?: number[];
  replyThreading?: ReplyThreadingContext;
  sourceReplyDeliveryMode?: WhatsAppSourceReplyDeliveryMode;
  visibleReplyTo?: VisibleReplyTarget;
  // shoar local: mention enrichment so the model knows exactly who was @mentioned in groups
  mentionedJids?: string[];
  selfJid?: string;
  selfLid?: string;
  selfE164?: string;
  mentionedContacts?: string;
}) {
  const conversationStatePacket =
    params.msg.chatType === "group"
      ? buildConversationStatePacket({
          conversationId: params.conversationId,
          groupHistory: params.groupHistory,
          groupMessageSignal: params.groupMessageSignal,
          msg: params.msg,
          route: params.route,
          sender: params.sender,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          visibleReplyTo: params.visibleReplyTo,
        })
      : undefined;
  const replyRunPriorityLane =
    params.msg.queueLane === undefined
      ? undefined
      : params.msg.queueLane.priority <= 3
        ? "foreground"
        : "ambient";
  const replyRunBaseKey = replyRunPriorityLane ? params.route.sessionKey : undefined;
  const replyRunKey =
    replyRunPriorityLane && replyRunBaseKey
      ? `${replyRunBaseKey}:reply-lane:${replyRunPriorityLane}`
      : undefined;
  const inboundHistory =
    params.msg.chatType === "group"
      ? (params.groupHistory ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const result = finalizeInboundContext({
    Body: params.combinedBody,
    BodyForAgent: params.bodyForAgent ?? params.msg.body,
    InboundHistory: inboundHistory,
    RawBody: params.rawBody ?? params.msg.body,
    CommandBody: params.commandBody ?? params.msg.body,
    Transcript: params.transcript,
    From: params.msg.from,
    To: params.msg.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    MessageSid: params.msg.id,
    MessageParticipant: params.msg.chatType === "group" ? params.msg.senderJid : undefined,
    ReplyToId: params.visibleReplyTo?.id,
    ReplyToBody: params.visibleReplyTo?.body,
    ReplyToSender: params.visibleReplyTo?.sender?.label,
    ReplyToSenderJid:
      params.visibleReplyTo?.sender?.jid ?? params.visibleReplyTo?.sender?.lid ?? undefined,
    ReplyToSenderE164: params.visibleReplyTo?.sender?.e164 ?? undefined,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    MediaTranscribedIndexes: params.mediaTranscribedIndexes,
    ChatType: params.msg.chatType,
    Timestamp: params.msg.timestamp,
    ConversationLabel: params.msg.chatType === "group" ? params.conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberRoster,
      fallbackE164: params.sender.e164,
    }),
    SenderName: params.sender.name,
    SenderId: params.sender.id ?? params.sender.e164,
    SenderE164: params.sender.e164,
    CommandAuthorized: params.commandAuthorized,
    ReplyThreading: params.replyThreading,
    WasMentioned: params.msg.wasMentioned,
    GroupAddresseeState: params.msg.groupAddressee?.state,
    GroupAddresseeReason: params.msg.groupAddressee?.reason,
    GroupAddresseeConfidence: params.msg.groupAddressee?.confidence,
    GroupMessageSignalState: params.groupMessageSignal?.state,
    GroupMessageSignalReason: params.groupMessageSignal?.reason,
    GroupMessageSignalMaxReplyLines: params.groupMessageSignal?.maxReplyLines,
    GroupEmotionPulse: params.groupMessageSignal?.emotionPulse?.id,
    GroupEmotionCarrier: params.groupMessageSignal?.emotionPulse?.carrier,
    GroupEmotionIntensity: params.groupMessageSignal?.emotionPulse?.intensity,
    GroupSystemPrompt: params.groupSystemPrompt,
    ConversationStatePacket: conversationStatePacket,
    ReplyRunPriorityLane: replyRunPriorityLane,
    ReplyRunBaseKey: replyRunBaseKey,
    ReplyRunKey: replyRunKey,
    UntrustedStructuredContext: params.msg.untrustedStructuredContext,
    MentionedJids: params.mentionedJids,
    SelfJid: params.selfJid ?? params.msg.selfJid ?? params.msg.self?.jid ?? undefined,
    SelfLid: params.selfLid ?? params.msg.selfLid ?? params.msg.self?.lid ?? undefined,
    SelfE164: params.selfE164 ?? params.msg.selfE164 ?? params.msg.self?.e164 ?? undefined,
    MentionedContacts: params.mentionedContacts,
    ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from,
  });
  return result;
}

export function resolveWhatsAppDmRouteTarget(params: {
  msg: WebInboundMsg;
  senderE164?: string;
  normalizeE164: (value: string) => string | null;
}): string | undefined {
  if (params.msg.chatType === "group") {
    return undefined;
  }
  if (params.senderE164) {
    return params.normalizeE164(params.senderE164) ?? undefined;
  }
  if (params.msg.from.includes("@")) {
    return jidToE164(params.msg.from) ?? undefined;
  }
  return params.normalizeE164(params.msg.from) ?? undefined;
}

export function updateWhatsAppMainLastRoute(params: {
  backgroundTasks: Set<Promise<unknown>>;
  cfg: ReturnType<LoadConfigFn>;
  ctx: Record<string, unknown>;
  dmRouteTarget?: string;
  pinnedMainDmRecipient: string | null;
  route: ReturnType<typeof resolveAgentRoute>;
  updateLastRoute: (params: {
    cfg: ReturnType<LoadConfigFn>;
    backgroundTasks: Set<Promise<unknown>>;
    storeAgentId: string;
    sessionKey: string;
    channel: "whatsapp";
    to: string;
    accountId?: string;
    ctx: Record<string, unknown>;
    warn: ReturnType<typeof getChildLogger>["warn"];
  }) => void;
  warn: ReturnType<typeof getChildLogger>["warn"];
}) {
  const shouldUpdateMainLastRoute =
    !params.pinnedMainDmRecipient || params.pinnedMainDmRecipient === params.dmRouteTarget;
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route: params.route,
    sessionKey: params.route.sessionKey,
  });

  if (
    params.dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    shouldUpdateMainLastRoute
  ) {
    params.updateLastRoute({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: params.dmRouteTarget,
      accountId: params.route.accountId,
      ctx: params.ctx,
      warn: params.warn,
    });
    return;
  }

  if (
    params.dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    params.pinnedMainDmRecipient
  ) {
    logVerbose(
      `Skipping main-session last route update for ${params.dmRouteTarget} (pinned owner ${params.pinnedMainDmRecipient})`,
    );
  }
}

export async function dispatchWhatsAppBufferedReply(params: {
  cfg: ReturnType<LoadConfigFn>;
  connectionId: string;
  context: Record<string, unknown>;
  conversationId: string;
  deliverReply: (params: {
    replyResult: ReplyPayload;
    msg: WebInboundMsg;
    mediaLocalRoots: readonly string[];
    maxMediaBytes: number;
    textLimit: number;
    chunkMode?: ReturnType<typeof resolveChunkMode>;
    replyLogger: ReturnType<typeof getChildLogger>;
    connectionId?: string;
    skipLog?: boolean;
    tableMode?: ReturnType<typeof resolveMarkdownTableMode>;
  }) => Promise<void>;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  maxMediaBytes: number;
  maxMediaTextChunkLimit?: number;
  msg: WebInboundMsg;
  onModelSelected?: ChannelReplyOnModelSelected;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  replyLogger: ReturnType<typeof getChildLogger>;
  replyPipeline: WhatsAppDispatchPipeline;
  replyResolver: typeof getReplyFromConfig;
  route: ReturnType<typeof resolveAgentRoute>;
  shouldClearGroupHistory: boolean;
  groupAddresseeDecision?: GroupAddresseeDecision;
  groupMessageSignalDecision?: GroupMessageSignalDecision;
  sourceReplyDeliveryMode?: WhatsAppSourceReplyDeliveryMode;
}) {
  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  const disableBlockStreaming = resolveWhatsAppDisableBlockStreaming(params.cfg);
  let didSendReply = false;
  let didLogHeartbeatStrip = false;
  let suppressedGeneratedReply:
    | {
        reason: string;
        lineCount: number;
        wordCount: number;
        charCount: number;
        maxReplyLines: number;
        maxWords: number;
        maxChars: number;
        shapeReason?: string;
      }
    | undefined;
  const { queuedFinal, counts } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.context,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      ...params.replyPipeline,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload: ReplyPayload, info: { kind: ReplyLifecycleKind }) => {
        let deliveryPayload = resolveWhatsAppDeliverablePayload(payload, info);
        if (!deliveryPayload) {
          return;
        }
        const autonomyDecision = parseWhatsAppAutonomyDecision(deliveryPayload.text);
        if (autonomyDecision) {
          if (autonomyDecision.kind === "silence" || autonomyDecision.kind === "defer") {
            params.replyLogger.info(
              {
                conversationId: params.conversationId,
                decision: autonomyDecision.kind,
                reason: autonomyDecision.reason,
                queueLane: params.msg.queueLane?.id,
                addresseeState: params.groupAddresseeDecision?.state,
                addresseeReason: params.groupAddresseeDecision?.reason,
              },
              "WhatsApp autonomy output chose no visible text reply",
            );
            return;
          }
          if (
            autonomyDecision.kind === "reaction" ||
            autonomyDecision.kind === "text_and_reaction"
          ) {
            await handleWhatsAppReactAction({
              action: "react",
              params: {
                to: params.conversationId,
                messageId: autonomyDecision.messageId ?? params.msg.id,
                emoji: autonomyDecision.emoji,
              },
              cfg: params.cfg,
              accountId: params.route.accountId,
              requesterSenderId:
                typeof params.context.SenderId === "string" ? params.context.SenderId : undefined,
              toolContext: {
                currentChannelId: params.conversationId,
                currentChannelProvider: "whatsapp",
                currentMessageId: params.msg.id,
                currentMessageParticipant: params.msg.senderJid,
              },
            });
            didSendReply = true;
            if (autonomyDecision.kind === "reaction") {
              return;
            }
          }
          if (autonomyDecision.kind === "text" || autonomyDecision.kind === "text_and_reaction") {
            deliveryPayload = { ...deliveryPayload, text: autonomyDecision.body };
          }
        }
        const reply = resolveSendableOutboundReplyParts(deliveryPayload);
        const signalCap = resolveGroupSignalTextCap({
          payload: deliveryPayload,
          signal: params.groupMessageSignalDecision,
          addressee: params.groupAddresseeDecision,
          allowedEmojis: resolveWhatsAppAllowedReactions({
            cfg: params.cfg,
            accountId: params.route.accountId,
          }),
          hasMedia: reply.hasMedia,
        });
        if (signalCap.exceeded) {
          const shortenedText =
            params.groupMessageSignalDecision?.state === "casual_vibe" &&
            !signalCap.shapeReason &&
            typeof deliveryPayload.text === "string"
              ? summarizeGroupSignalText(deliveryPayload.text, signalCap)
              : undefined;
          if (shortenedText) {
            const shortenedPayload = { ...deliveryPayload, text: shortenedText };
            params.replyLogger.info(
              {
                conversationId: params.conversationId,
                signalState: params.groupMessageSignalDecision?.state,
                signalReason: params.groupMessageSignalDecision?.reason,
                addresseeState: params.groupAddresseeDecision?.state,
                addresseeReason: params.groupAddresseeDecision?.reason,
                originalLineCount: signalCap.lineCount,
                originalWordCount: signalCap.wordCount,
                originalCharCount: signalCap.charCount,
                maxReplyLines: signalCap.maxReplyLines,
                maxWords: signalCap.maxWords,
                maxChars: signalCap.maxChars,
              },
              "shortened overlong WhatsApp casual-vibe reply before delivery",
            );
            await params.deliverReply({
              replyResult: shortenedPayload,
              msg: params.msg,
              mediaLocalRoots,
              maxMediaBytes: params.maxMediaBytes,
              textLimit,
              chunkMode,
              replyLogger: params.replyLogger,
              connectionId: params.connectionId,
              skipLog: false,
              tableMode,
            });
            didSendReply = true;
            params.rememberSentText(shortenedPayload.text, {
              combinedBody: params.context.Body as string | undefined,
              combinedBodySessionKey: params.route.sessionKey,
              logVerboseMessage: true,
            });
            return;
          }

          suppressedGeneratedReply = {
            reason: "group_signal_cap",
            lineCount: signalCap.lineCount,
            wordCount: signalCap.wordCount,
            charCount: signalCap.charCount,
            maxReplyLines: signalCap.maxReplyLines,
            maxWords: signalCap.maxWords,
            maxChars: signalCap.maxChars,
            shapeReason: signalCap.shapeReason,
          };
          params.replyLogger.debug(
            {
              conversationId: params.conversationId,
              signalState: params.groupMessageSignalDecision?.state,
              signalReason: params.groupMessageSignalDecision?.reason,
              addresseeState: params.groupAddresseeDecision?.state,
              addresseeReason: params.groupAddresseeDecision?.reason,
              lineCount: signalCap.lineCount,
              wordCount: signalCap.wordCount,
              charCount: signalCap.charCount,
              maxReplyLines: signalCap.maxReplyLines,
              maxWords: signalCap.maxWords,
              maxChars: signalCap.maxChars,
              shapeReason: signalCap.shapeReason,
              emojiCount: signalCap.shape?.emojiCount,
              emojiOnly: signalCap.shape?.emojiOnly,
              uppercaseWordCount: signalCap.shape?.uppercaseWordCount,
            },
            "group message signal capped WhatsApp reply",
          );
          logVerbose(
            `Skipping outbound WhatsApp payload: group message signal capped text reply (${params.groupMessageSignalDecision?.state}:${params.groupMessageSignalDecision?.reason})`,
          );
          return;
        }
        await params.deliverReply({
          replyResult: deliveryPayload,
          msg: params.msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          skipLog: false,
          tableMode,
        });
        didSendReply = true;
        const shouldLog = deliveryPayload.text ? true : undefined;
        params.rememberSentText(deliveryPayload.text, {
          combinedBody: params.context.Body as string | undefined,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog,
        });
        const fromDisplay =
          params.msg.chatType === "group" ? params.conversationId : (params.msg.from ?? "unknown");
        if (shouldLogVerbose()) {
          const preview = deliveryPayload.text != null ? reply.text : "<media>";
          logVerbose(`Reply body: ${preview}${reply.hasMedia ? " (media)" : ""} -> ${fromDisplay}`);
        }
      },
      onReplyStart: params.msg.sendComposing,
    },
    replyOptions: {
      disableBlockStreaming,
      onModelSelected: params.onModelSelected,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    },
  });

  const didQueueVisibleReply =
    queuedFinal || counts.tool > 0 || counts.block > 0 || counts.final > 0;
  if (!didQueueVisibleReply) {
    if (params.shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (params.shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  if (!didSendReply && suppressedGeneratedReply) {
    params.replyLogger.warn(
      {
        conversationId: params.conversationId,
        signalState: params.groupMessageSignalDecision?.state,
        signalReason: params.groupMessageSignalDecision?.reason,
        addresseeState: params.groupAddresseeDecision?.state,
        addresseeReason: params.groupAddresseeDecision?.reason,
        ...suppressedGeneratedReply,
      },
      "generated WhatsApp reply suppressed before delivery",
    );
  }

  return didSendReply;
}
