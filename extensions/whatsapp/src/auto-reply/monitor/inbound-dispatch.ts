// Whatsapp plugin module implements inbound dispatch behavior.
import {
  DEFAULT_TIMING,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildChannelInboundEventContext,
  type CommandTurnContext,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasVisibleInboundReplyDispatch } from "openclaw/plugin-sdk/channel-inbound";
import { deliverInboundReplyWithMessageSendContext } from "openclaw/plugin-sdk/channel-outbound";
import { buildInboundHistoryFromEntries } from "openclaw/plugin-sdk/reply-history";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
} from "../../outbound-media-contract.js";
import type { WhatsAppReplyDeliveryResult } from "../deliver-reply.js";
import { markWhatsAppVisibleDeliveryError } from "../util.js";
import { formatGroupMembers } from "./group-members.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import {
  createChannelMessageReplyPipeline,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
  getAgentScopedMediaLocalRoots,
  jidToE164,
  logVerbose,
  resolveChannelMessageSourceReplyDeliveryMode,
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
type ChannelReplyOnModelSelected = NonNullable<
  ReturnType<typeof createChannelMessageReplyPipeline>["onModelSelected"]
>;

type WhatsAppDispatchPipeline = {
  responsePrefix?: string;
} & Record<string, unknown>;

type VisibleReplyTarget = {
  id?: string;
  body?: string;
  sender?: {
    label?: string | null;
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

type ReplyDeliveryInfo = { kind: ReplyLifecycleKind };

type PendingWhatsAppMediaOnlyPayload = {
  info: ReplyDeliveryInfo;
  mediaUrls: Set<string>;
  payload: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
};

type WhatsAppMediaOnlyFlushResult = {
  delivered: number;
  droppedDuplicateMedia: number;
};

function normalizeErrForLog(err: unknown): unknown {
  if (err instanceof Error) {
    const ownEnumerableProps = Object.fromEntries(Object.entries(err));
    return { ...ownEnumerableProps, type: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

type WhatsAppReplyDeliveryVisibility = {
  visibleReplySent: boolean;
};

function whatsAppReplyDeliveryVisibility(
  visibleReplySent: boolean,
): WhatsAppReplyDeliveryVisibility {
  return { visibleReplySent };
}

function whatsAppReplyDeliveryVisibilityFromDurableResult(result: {
  visibleReplySent?: boolean;
}): WhatsAppReplyDeliveryVisibility {
  return whatsAppReplyDeliveryVisibility(result.visibleReplySent === true);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function markWhatsAppReplyDeliveryErrorVisibleAfterFlush(
  error: unknown,
  flushResult: WhatsAppMediaOnlyFlushResult,
): unknown {
  return flushResult.delivered > 0 ? markWhatsAppVisibleDeliveryError(error) : error;
}

function logWhatsAppReplyDeliveryError(params: {
  err: unknown;
  info: ReplyDeliveryInfo;
  connectionId: string;
  msg: AdmittedWebInboundMessage;
  replyLogger: ReturnType<typeof getChildLogger>;
}) {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  params.replyLogger.error(
    {
      err: normalizeErrForLog(params.err),
      replyKind: params.info.kind,
      correlationId: params.msg.event.id ?? null,
      connectionId: params.connectionId,
      conversationId: admission.conversation.id,
      chatId: params.msg.platform.chatJid ?? null,
      to: admission.conversation.id,
      from: params.msg.platform.recipientJid ?? null,
    },
    "auto-reply delivery failed",
  );
}

function resolveWhatsAppDurableReplyToId(params: {
  context: Record<string, unknown>;
  info: ReplyDeliveryInfo;
  msg: AdmittedWebInboundMessage;
  payload: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
}): string | null {
  if (params.payload.replyToId === null) {
    return null;
  }
  const explicitPayloadReplyToId = readTrimmedString(params.payload.replyToId);
  if (explicitPayloadReplyToId) {
    return explicitPayloadReplyToId;
  }
  const hasVisibleInboundReplyTarget =
    Boolean(readTrimmedString(params.context.ReplyToId)) ||
    Boolean(readTrimmedString(params.context.ReplyToIdFull));
  const currentInboundMessageId = readTrimmedString(params.msg.event.id);
  if (params.info.kind === "final" && hasVisibleInboundReplyTarget && currentInboundMessageId) {
    return currentInboundMessageId;
  }
  return null;
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
  if (payload.isError === true) {
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

function getWhatsAppPayloadMediaUrls(payload: ReplyPayload): Set<string> {
  return new Set(
    normalizeStringEntries([
      ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
      ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
    ]),
  );
}

function hasWhatsAppMediaUrlOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const url of left) {
    if (right.has(url)) {
      return true;
    }
  }
  return false;
}

function shouldDeferWhatsAppMediaOnlyPayload(params: {
  info: ReplyDeliveryInfo;
  mediaUrls: Set<string>;
  reply: ReturnType<typeof resolveSendableOutboundReplyParts>;
}): boolean {
  return (
    params.info.kind !== "final" &&
    params.reply.hasMedia &&
    !params.reply.text.trim() &&
    params.mediaUrls.size > 0
  );
}

function createWhatsAppMediaOnlyReplyCoalescer(params: {
  deliver: (pending: PendingWhatsAppMediaOnlyPayload) => Promise<WhatsAppReplyDeliveryVisibility>;
}) {
  const pendingMediaOnlyPayloads: PendingWhatsAppMediaOnlyPayload[] = [];
  const flushExceptDuplicateMedia = async (
    mediaUrls?: Set<string>,
  ): Promise<WhatsAppMediaOnlyFlushResult> => {
    const flushResult: WhatsAppMediaOnlyFlushResult = {
      delivered: 0,
      droppedDuplicateMedia: 0,
    };
    const pending = pendingMediaOnlyPayloads.splice(0);
    for (const candidate of pending) {
      if (mediaUrls && hasWhatsAppMediaUrlOverlap(candidate.mediaUrls, mediaUrls)) {
        flushResult.droppedDuplicateMedia += 1;
        continue;
      }
      try {
        const delivery = await params.deliver(candidate);
        if (delivery.visibleReplySent) {
          flushResult.delivered += 1;
        }
      } catch (error: unknown) {
        throw markWhatsAppReplyDeliveryErrorVisibleAfterFlush(error, flushResult);
      }
    }
    return flushResult;
  };

  return {
    defer(pending: PendingWhatsAppMediaOnlyPayload) {
      pendingMediaOnlyPayloads.push(pending);
    },
    flushExceptDuplicateMedia,
    flushAll: () => flushExceptDuplicateMedia(),
  };
}

function logWhatsAppMediaOnlyFlushResult(result: WhatsAppMediaOnlyFlushResult) {
  if (!shouldLogVerbose()) {
    return;
  }
  if (result.droppedDuplicateMedia > 0) {
    logVerbose(
      `Dropped ${result.droppedDuplicateMedia} deferred media-only WhatsApp reply payload(s) superseded by captioned media`,
    );
  }
  if (result.delivered > 0) {
    logVerbose(`Flushed ${result.delivered} deferred media-only WhatsApp reply payload(s)`);
  }
}

const WHATSAPP_PROGRESS_MESSAGE_DEFAULTS = {
  initialDelayMs: 30_000,
  intervalMs: 45_000,
  maxMessages: 3,
};

type WhatsAppProgressMessagesConfig = {
  enabled?: boolean;
  initialDelayMs?: number;
  intervalMs?: number;
  maxMessages?: number;
};

type WhatsAppProgressMessagesOwnerConfig = {
  progressMessages?: WhatsAppProgressMessagesConfig;
};

type WhatsAppProgressMessagesChannelConfig = WhatsAppProgressMessagesOwnerConfig & {
  accounts?: Record<string, WhatsAppProgressMessagesOwnerConfig | undefined>;
};

type ResolvedWhatsAppProgressMessagesConfig = {
  enabled: boolean;
  initialDelayMs: number;
  intervalMs: number;
  maxMessages: number;
};

function readPositiveProgressNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveWhatsAppProgressMessagesConfig(
  cfg: ReturnType<LoadConfigFn>,
  accountId?: string,
): ResolvedWhatsAppProgressMessagesConfig {
  const channelConfig = cfg.channels?.whatsapp as WhatsAppProgressMessagesChannelConfig | undefined;
  const accountConfig = accountId ? channelConfig?.accounts?.[accountId] : undefined;
  const configured = {
    ...channelConfig?.progressMessages,
    ...accountConfig?.progressMessages,
  };
  if (configured.enabled !== true) {
    return { enabled: false, ...WHATSAPP_PROGRESS_MESSAGE_DEFAULTS };
  }
  return {
    enabled: true,
    initialDelayMs: readPositiveProgressNumber(
      configured.initialDelayMs,
      WHATSAPP_PROGRESS_MESSAGE_DEFAULTS.initialDelayMs,
    ),
    intervalMs: readPositiveProgressNumber(
      configured.intervalMs,
      WHATSAPP_PROGRESS_MESSAGE_DEFAULTS.intervalMs,
    ),
    maxMessages: Math.max(
      1,
      Math.floor(
        readPositiveProgressNumber(
          configured.maxMessages,
          WHATSAPP_PROGRESS_MESSAGE_DEFAULTS.maxMessages,
        ),
      ),
    ),
  };
}

function describeWhatsAppProgressTool(name?: string): string {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return "I'm still working on this and will send the full response when it's ready.";
  }
  if (
    normalized.includes("browser") ||
    normalized.includes("web") ||
    normalized.includes("search")
  ) {
    return "I'm searching and checking the relevant information. I'll send the full response when it's ready.";
  }
  if (
    normalized.includes("exec") ||
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("sandbox")
  ) {
    return "I'm running commands and checking the results. I'll send the full conclusion when it's ready.";
  }
  if (
    normalized.includes("file") ||
    normalized.includes("read") ||
    normalized.includes("write") ||
    normalized.includes("patch")
  ) {
    return "I'm reading or updating files. I'll send the full summary when it's ready.";
  }
  if (normalized.includes("mcp") || normalized.includes("tool")) {
    return "I'm checking external tools. I'll send the response once the data is consolidated.";
  }
  return "I'm still processing the request. I'll send the full response when it's ready.";
}

function createNoopWhatsAppProgressMessages() {
  return {
    enabled: false,
    start() {},
    setThinking() {},
    setTool(_name?: string) {},
    setCompacting() {},
    stop() {},
  };
}

function createWhatsAppThrottledProgressMessages(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string;
  sourceRepliesAreToolOnly: boolean;
  deliverProgress: (
    normalizedProgressPayload: DeliverableWhatsAppOutboundPayload<ReplyPayload>,
  ) => Promise<WhatsAppReplyDeliveryResult>;
}) {
  const config = resolveWhatsAppProgressMessagesConfig(params.cfg, params.accountId);
  if (!config.enabled || params.sourceRepliesAreToolOnly) {
    return createNoopWhatsAppProgressMessages();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let sentCount = 0;
  let sending = false;
  let latestText = "I'm still analyzing this and will update you when it's ready.";
  const startedAt = Date.now();
  let lastSentAt = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
  };

  const schedule = (delayMs: number) => {
    if (stopped || sentCount >= config.maxMessages || timer) {
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        void deliver();
      },
      Math.max(1_000, delayMs),
    );
  };

  const deliver = async () => {
    if (stopped || sending || sentCount >= config.maxMessages) {
      return;
    }
    const now = Date.now();
    if (now - startedAt < config.initialDelayMs) {
      schedule(config.initialDelayMs - (now - startedAt));
      return;
    }
    if (lastSentAt && now - lastSentAt < config.intervalMs) {
      schedule(config.intervalMs - (now - lastSentAt));
      return;
    }

    sending = true;
    clearTimer();
    try {
      const normalizedProgressPayload = normalizeWhatsAppOutboundPayload(
        { text: latestText },
        { normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation },
      );
      const delivery = await params.deliverProgress(normalizedProgressPayload);
      if (delivery.providerAccepted) {
        sentCount += 1;
        lastSentAt = Date.now();
      }
    } catch (err: unknown) {
      logVerbose(`WhatsApp throttled progress message failed: ${String(err)}`);
    } finally {
      sending = false;
    }

    if (!stopped && sentCount < config.maxMessages) {
      schedule(config.intervalMs);
    }
  };

  return {
    enabled: true,
    start() {
      schedule(config.initialDelayMs);
    },
    setThinking() {
      latestText = "I'm still analyzing this and will update you when it's ready.";
    },
    setTool(name?: string) {
      latestText = describeWhatsAppProgressTool(name);
      void deliver();
    },
    setCompacting() {
      latestText =
        "I'm organizing the context so I can continue without losing information. I'll send the full response when it's ready.";
      void deliver();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
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

export async function buildWhatsAppInboundContext(params: {
  bodyForAgent?: string;
  combinedBody: string;
  commandBody?: string;
  commandAuthorized?: boolean;
  commandTurn?: CommandTurnContext;
  commandSource?: "text";
  groupHistory?: GroupHistoryEntry[];
  groupMemberRoster?: Map<string, string>;
  groupSystemPrompt?: string;
  msg: AdmittedWebInboundMessage;
  rawBody?: string;
  route: ReturnType<typeof resolveAgentRoute>;
  sender: SenderContext;
  transcript?: string;
  mediaTranscribedIndexes?: number[];
  replyThreading?: ReplyThreadingContext;
  visibleReplyTo?: VisibleReplyTarget;
  suppressMessageReceivedHooks?: boolean;
}): Promise<FinalizedMsgContext> {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const wasMentioned = params.msg.groupMention?.wasMentioned ?? params.msg.wasMentioned;
  const inboundHistory =
    conversationKind === "group"
      ? buildInboundHistoryFromEntries({
          entries: (params.groupHistory ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
            messageId: entry.id,
          })),
          limit: params.groupHistory?.length ?? 1,
        })
      : undefined;

  const media = toInboundMediaFacts(
    params.msg.payload.media?.path || params.msg.payload.media?.url
      ? [
          {
            path: params.msg.payload.media?.path,
            url: params.msg.payload.media?.url ?? params.msg.payload.media?.path,
            contentType: params.msg.payload.media?.type,
          },
        ]
      : undefined,
    { transcribed: (_entry, index) => params.mediaTranscribedIndexes?.includes(index) === true },
  );
  return buildChannelInboundEventContext({
    channel: "whatsapp",
    finalize: finalizeInboundContext,
    supplemental: {
      quote: params.visibleReplyTo
        ? {
            id: params.visibleReplyTo.id,
            body: params.visibleReplyTo.body,
            sender: params.visibleReplyTo.sender?.label ?? undefined,
          }
        : undefined,
      groupSystemPrompt: params.groupSystemPrompt,
      untrustedContext: params.msg.payload.untrustedStructuredContext,
    },
    media,
    messageId: params.msg.event.id,
    timestamp: params.msg.event.timestamp,
    from: conversationId,
    sender: {
      id: params.sender.id ?? params.sender.e164,
      name: params.sender.name,
    },
    conversation: {
      kind: conversationKind,
      id: conversationId,
      label: conversationId,
    },
    route: {
      agentId: params.route.agentId,
      accountId: params.route.accountId,
      routeSessionKey: params.route.sessionKey,
    },
    reply: {
      to: params.msg.platform.recipientJid,
      originatingTo: conversationId,
    },
    message: {
      body: params.combinedBody,
      bodyForAgent: params.bodyForAgent ?? params.msg.payload.body,
      inboundHistory,
      rawBody: params.rawBody ?? params.msg.payload.body,
      commandBody: params.commandBody ?? params.msg.payload.body,
    },
    access: {
      ...(wasMentioned !== undefined
        ? {
            mentions: {
              canDetectMention: conversationKind === "group",
              wasMentioned,
              requireMention: params.msg.groupMention?.requireMention,
            },
          }
        : {}),
      commands: {
        authorized: params.commandAuthorized,
      },
    },
    commandTurn: params.commandTurn,
    extra: {
      Transcript: params.transcript,
      GroupSubject: params.msg.group?.subject,
      GroupMembers: formatGroupMembers({
        participants: params.msg.group?.participants,
        roster: params.groupMemberRoster,
        fallbackE164: params.sender.e164,
      }),
      SenderE164: params.sender.e164,
      CommandSource:
        params.commandSource ??
        (params.commandTurn?.source === "native" || params.commandTurn?.source === "text"
          ? params.commandTurn.source
          : undefined),
      ReplyThreading: params.replyThreading,
      SuppressMessageReceivedHooks: params.suppressMessageReceivedHooks,
      ...(params.msg.payload.location ? toLocationContext(params.msg.payload.location) : {}),
    },
  });
}

function normalizeCommandTurnFromContext(value: unknown): CommandTurnContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<CommandTurnContext>;
  const kind = record.kind;
  const source = record.source;
  if (kind === "native" && source === "native" && typeof record.authorized === "boolean") {
    return {
      kind: "native",
      source: "native",
      authorized: record.authorized,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  if (kind === "text-slash" && source === "text" && typeof record.authorized === "boolean") {
    return {
      kind: "text-slash",
      source: "text",
      authorized: record.authorized,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  if (kind === "normal" && source === "message") {
    return {
      kind: "normal",
      source: "message",
      authorized: false,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  return undefined;
}

export function resolveWhatsAppDmRouteTarget(params: {
  msg: AdmittedWebInboundMessage;
  senderE164?: string;
  normalizeE164: (value: string) => string | null;
}): string | undefined {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const conversationId = admission.conversation.id;
  if (admission.conversation.kind === "group") {
    return undefined;
  }
  if (params.senderE164) {
    return params.normalizeE164(params.senderE164) ?? undefined;
  }
  if (conversationId.includes("@")) {
    return jidToE164(conversationId) ?? undefined;
  }
  return params.normalizeE164(conversationId) ?? undefined;
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
  deliverReply: (params: {
    replyResult: ReplyPayload;
    normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
    msg: AdmittedWebInboundMessage;
    mediaLocalRoots: readonly string[];
    maxMediaBytes: number;
    textLimit: number;
    chunkMode?: ReturnType<typeof resolveChunkMode>;
    replyLogger: ReturnType<typeof getChildLogger>;
    connectionId?: string;
    skipLog?: boolean;
    tableMode?: ReturnType<typeof resolveMarkdownTableMode>;
  }) => Promise<WhatsAppReplyDeliveryResult>;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  maxMediaBytes: number;
  maxMediaTextChunkLimit?: number;
  msg: AdmittedWebInboundMessage;
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
  statusReactionController?: StatusReactionController | null;
}) {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const statusReactionController = params.statusReactionController ?? null;
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...params.cfg.messages?.statusReactions?.timing,
  };
  const removeAckAfterReply = params.cfg.messages?.removeAckAfterReply ?? false;
  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  const sourceReplyChatType =
    typeof params.context.ChatType === "string" ? params.context.ChatType : conversationKind;
  const sourceReplyCommandSource =
    params.context.CommandSource === "native" || params.context.CommandSource === "text"
      ? params.context.CommandSource
      : undefined;
  const sourceReplyCommandTurn = normalizeCommandTurnFromContext(params.context.CommandTurn);
  const sourceReplyCommandAuthorized =
    typeof params.context.CommandAuthorized === "boolean"
      ? params.context.CommandAuthorized
      : undefined;
  const sourceReplyDeliveryMode =
    sourceReplyChatType === "group" || sourceReplyChatType === "channel"
      ? resolveChannelMessageSourceReplyDeliveryMode({
          cfg: params.cfg,
          ctx: {
            ChatType: sourceReplyChatType,
            CommandTurn: sourceReplyCommandTurn,
            CommandSource: sourceReplyCommandSource,
            CommandAuthorized: sourceReplyCommandAuthorized,
          },
        })
      : undefined;
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const disableBlockStreaming = sourceRepliesAreToolOnly
    ? true
    : resolveWhatsAppDisableBlockStreaming(params.cfg);
  let didSendReply = false;
  let didLogHeartbeatStrip = false;

  const deliverNormalizedPayload = async (
    normalizedDeliveryPayload: DeliverableWhatsAppOutboundPayload<ReplyPayload>,
    info: ReplyDeliveryInfo,
  ): Promise<WhatsAppReplyDeliveryVisibility> => {
    const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
    if (!reply.hasMedia && !reply.text.trim()) {
      return whatsAppReplyDeliveryVisibility(false);
    }
    const delivery = await params.deliverReply({
      replyResult: normalizedDeliveryPayload,
      normalizedReplyResult: normalizedDeliveryPayload,
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
    if (!delivery.providerAccepted) {
      params.replyLogger.warn(
        {
          correlationId: params.msg.event.id ?? null,
          connectionId: params.connectionId,
          conversationId,
          chatId: params.msg.platform.chatJid,
          to: conversationId,
          from: params.msg.platform.recipientJid,
          replyKind: info.kind,
        },
        "auto-reply was not accepted by WhatsApp provider",
      );
      return whatsAppReplyDeliveryVisibility(false);
    }
    didSendReply = true;
    const shouldLog = normalizedDeliveryPayload.text ? true : undefined;
    params.rememberSentText(normalizedDeliveryPayload.text, {
      combinedBody: params.context.Body as string | undefined,
      combinedBodySessionKey: params.route.sessionKey,
      logVerboseMessage: shouldLog,
    });
    const fromDisplay = conversationId;
    if (shouldLogVerbose()) {
      const preview = normalizedDeliveryPayload.text != null ? reply.text : "<media>";
      logVerbose(`Reply body: ${preview}${reply.hasMedia ? " (media)" : ""} -> ${fromDisplay}`);
    }
    return whatsAppReplyDeliveryVisibility(true);
  };

  const mediaOnlyCoalescer = createWhatsAppMediaOnlyReplyCoalescer({
    deliver: async (pending) => {
      return await deliverNormalizedPayload(pending.payload, pending.info);
    },
  });
  const progressMessages = createWhatsAppThrottledProgressMessages({
    cfg: params.cfg,
    accountId: params.route.accountId,
    sourceRepliesAreToolOnly,
    deliverProgress: async (normalizedProgressPayload) =>
      await params.deliverReply({
        replyResult: normalizedProgressPayload,
        normalizedReplyResult: normalizedProgressPayload,
        msg: params.msg,
        mediaLocalRoots,
        maxMediaBytes: params.maxMediaBytes,
        textLimit,
        chunkMode,
        replyLogger: params.replyLogger,
        connectionId: params.connectionId,
        skipLog: true,
        tableMode,
      }),
  });

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  let dispatchResult: Awaited<ReturnType<typeof dispatchReplyWithBufferedBlockDispatcher>>;
  try {
    dispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
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
          if (info.kind === "final") {
            progressMessages.stop();
          }
          const deliveryPayload = resolveWhatsAppDeliverablePayload(payload, info);
          if (!deliveryPayload) {
            return whatsAppReplyDeliveryVisibility(false);
          }
          const normalizedOutboundPayload = normalizeWhatsAppOutboundPayload(deliveryPayload, {
            normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
          });
          const normalizedDeliveryPayload =
            deliveryPayload.text === undefined
              ? { ...normalizedOutboundPayload, text: undefined }
              : normalizedOutboundPayload;
          const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
          if (!reply.hasMedia && !reply.text.trim()) {
            return whatsAppReplyDeliveryVisibility(false);
          }
          if (!reply.hasMedia) {
            const flushResult = await mediaOnlyCoalescer.flushAll();
            logWhatsAppMediaOnlyFlushResult(flushResult);
            try {
              const durable = await deliverInboundReplyWithMessageSendContext({
                cfg: params.cfg,
                channel: "whatsapp",
                accountId: params.route.accountId,
                agentId: params.route.agentId,
                ctxPayload: params.context as FinalizedMsgContext,
                payload: normalizedDeliveryPayload,
                info,
                to: conversationId,
                replyToId: resolveWhatsAppDurableReplyToId({
                  context: params.context,
                  info,
                  msg: params.msg,
                  payload: normalizedDeliveryPayload,
                }),
                formatting: {
                  textLimit,
                  tableMode,
                  chunkMode,
                },
              });
              if (durable.status === "failed") {
                if (durable.sentBeforeError === true) {
                  throw markWhatsAppVisibleDeliveryError(durable.error);
                }
                throw durable.error;
              }
              if (durable.status === "handled_visible") {
                didSendReply = true;
                const shouldLog = normalizedDeliveryPayload.text ? true : undefined;
                params.rememberSentText(normalizedDeliveryPayload.text, {
                  combinedBody: params.context.Body as string | undefined,
                  combinedBodySessionKey: params.route.sessionKey,
                  logVerboseMessage: shouldLog,
                });
                return whatsAppReplyDeliveryVisibilityFromDurableResult(durable.delivery);
              }
              if (durable.status === "handled_no_send") {
                return flushResult.delivered > 0
                  ? whatsAppReplyDeliveryVisibility(true)
                  : whatsAppReplyDeliveryVisibilityFromDurableResult(durable.delivery);
              }
              const delivery = await deliverNormalizedPayload(normalizedDeliveryPayload, info);
              return flushResult.delivered > 0 && !delivery.visibleReplySent
                ? whatsAppReplyDeliveryVisibility(true)
                : delivery;
            } catch (error: unknown) {
              throw markWhatsAppReplyDeliveryErrorVisibleAfterFlush(error, flushResult);
            }
          }
          const mediaUrls = getWhatsAppPayloadMediaUrls(normalizedDeliveryPayload);
          if (shouldDeferWhatsAppMediaOnlyPayload({ info, mediaUrls, reply })) {
            mediaOnlyCoalescer.defer({
              info,
              mediaUrls,
              payload: normalizedDeliveryPayload,
            });
            return whatsAppReplyDeliveryVisibility(false);
          }
          const flushResult = await mediaOnlyCoalescer.flushExceptDuplicateMedia(mediaUrls);
          logWhatsAppMediaOnlyFlushResult(flushResult);
          try {
            const delivery = await deliverNormalizedPayload(normalizedDeliveryPayload, info);
            return flushResult.delivered > 0 && !delivery.visibleReplySent
              ? whatsAppReplyDeliveryVisibility(true)
              : delivery;
          } catch (error: unknown) {
            throw markWhatsAppReplyDeliveryErrorVisibleAfterFlush(error, flushResult);
          }
        },
        onSettled: async () => {
          progressMessages.stop();
          const flushResult = await mediaOnlyCoalescer.flushAll();
          logWhatsAppMediaOnlyFlushResult(flushResult);
          return whatsAppReplyDeliveryVisibility(flushResult.delivered > 0);
        },
        onReplyStart: async () => {
          progressMessages.setThinking();
          progressMessages.start();
          await params.msg.platform.sendComposing?.();
        },
        ...(statusReactionController || progressMessages.enabled
          ? {
              onCompactionStart: async () => {
                progressMessages.setCompacting();
                await statusReactionController?.setCompacting();
              },
              onCompactionEnd: async () => {
                progressMessages.setThinking();
                statusReactionController?.cancelPending();
                await statusReactionController?.setThinking();
              },
            }
          : {}),
        onError: (err, info) => {
          logWhatsAppReplyDeliveryError({
            err,
            info,
            connectionId: params.connectionId,
            msg: params.msg,
            replyLogger: params.replyLogger,
          });
        },
      },
      replyOptions: {
        // Message-tool-only unmentioned group turns have no automatic visible reply.
        // Suppress composing there so silent background runs do not leak presence.
        suppressTyping:
          sourceRepliesAreToolOnly &&
          conversationKind === "group" &&
          !(params.msg.groupMention?.wasMentioned ?? params.msg.wasMentioned),
        disableBlockStreaming,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
        onModelSelected: params.onModelSelected,
        ...(statusReactionController || progressMessages.enabled
          ? {
              onToolStart: async (payload: { name?: string }) => {
                const toolName = payload.name?.trim();
                progressMessages.setTool(toolName);
                if (toolName) {
                  await statusReactionController?.setTool(toolName);
                }
              },
            }
          : {}),
      },
    });
  } finally {
    progressMessages.stop();
  }
  const didQueueVisibleReply = hasVisibleInboundReplyDispatch(dispatchResult);
  const didDeliverVisibleReply = didSendReply || dispatchResult.observedReplyDelivery === true;
  if (!didQueueVisibleReply) {
    if (statusReactionController) {
      void finalizeWhatsAppStatusReaction({
        controller: statusReactionController,
        outcome: "error",
        hasFinalResponse: false,
        removeAckAfterReply,
        timing: statusReactionTiming,
      });
    }
    if (params.shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (statusReactionController) {
    void finalizeWhatsAppStatusReaction({
      controller: statusReactionController,
      outcome: didDeliverVisibleReply ? "done" : "error",
      hasFinalResponse: didDeliverVisibleReply,
      removeAckAfterReply,
      timing: statusReactionTiming,
    });
  }

  if (params.shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didDeliverVisibleReply;
}

async function finalizeWhatsAppStatusReaction(params: {
  controller: StatusReactionController;
  outcome: "done" | "error";
  hasFinalResponse: boolean;
  removeAckAfterReply: boolean;
  timing: typeof DEFAULT_TIMING;
}): Promise<void> {
  if (params.outcome === "done") {
    await params.controller.setDone();
    if (params.removeAckAfterReply) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.timing.doneHoldMs);
      });
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  await params.controller.setError();
  if (params.hasFinalResponse) {
    if (params.removeAckAfterReply) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.timing.errorHoldMs);
      });
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  if (params.removeAckAfterReply) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, params.timing.errorHoldMs);
    });
  }
  await params.controller.restoreInitial();
}
