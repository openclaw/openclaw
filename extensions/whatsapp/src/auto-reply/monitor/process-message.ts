import { resolveIdentityNamePrefix } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveInboundSessionEnvelopeContext,
  toLocationContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-detection";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { recordSessionMetaFromInbound } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  buildHistoryContextFromEntries,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveInboundLastRouteSessionKey,
  type resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolvePinnedMainDmOwnerFromAllowlist,
  resolveDmGroupAccessWithCommandGate,
} from "openclaw/plugin-sdk/security-runtime";
import { jidToE164, normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "../../accounts.js";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
} from "../../identity.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog, whatsappOutboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { formatGroupMembers } from "./group-members.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

async function resolveWhatsAppCommandAuthorized(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const isGroup = params.msg.chatType === "group";
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const senderE164 = normalizeE164(
    isGroup ? (sender.e164 ?? "") : (sender.e164 ?? params.msg.from ?? ""),
  );
  if (!senderE164) {
    return false;
  }

  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  const dmPolicy = account.dmPolicy ?? "pairing";
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);

  const storeAllowFrom = isGroup
    ? []
    : await readStoreAllowFromForDmPolicy({
        provider: "whatsapp",
        accountId: params.msg.accountId,
        dmPolicy,
      });
  const dmAllowFrom =
    configuredAllowFrom.length > 0 ? configuredAllowFrom : self.e164 ? [self.e164] : [];
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: dmAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowEntries) => {
      if (allowEntries.includes("*")) {
        return true;
      }
      const normalizedEntries = allowEntries
        .map((entry) => normalizeE164(String(entry)))
        .filter((entry): entry is string => Boolean(entry));
      return normalizedEntries.includes(senderE164);
    },
    command: {
      useAccessGroups,
      allowTextCommands: true,
      hasControlCommand: true,
    },
  });
  return access.commandAuthorized;
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
}): string | null {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: account.allowFrom,
    normalizeEntry: (entry) => normalizeE164(entry),
  });
}

export async function processMessage(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
}) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });
  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let shouldClearGroupHistory = false;

  if (params.msg.chatType === "group") {
    const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // Send ack reaction immediately upon message receipt (post-gating)
  maybeSendAckReaction({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    conversationId,
    verbose: params.verbose,
    accountId: params.route.accountId,
    info: params.replyLogger.info.bind(params.replyLogger),
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const correlationId = params.msg.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: params.msg.chatType === "group" ? conversationId : params.msg.from,
      to: params.msg.to,
      body: elide(combinedBody, 240),
      mediaType: params.msg.mediaType ?? null,
      mediaPath: params.msg.mediaPath ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const replyTo = getReplyContext(params.msg);
  const dmRouteTarget =
    params.msg.chatType !== "group"
      ? (() => {
          if (sender.e164) {
            return normalizeE164(sender.e164);
          }
          // In direct chats, `msg.from` is already the canonical conversation id.
          if (params.msg.from.includes("@")) {
            return jidToE164(params.msg.from);
          }
          return normalizeE164(params.msg.from);
        })()
      : undefined;

  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  let didLogHeartbeatStrip = false;
  let didSendReply = false;
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg })
    : undefined;
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const isSelfChat =
    params.msg.chatType !== "group" &&
    Boolean(self.e164) &&
    normalizeE164(params.msg.from) === normalizeE164(self.e164 ?? "");
  const responsePrefix =
    replyPipeline.responsePrefix ??
    (configuredResponsePrefix === undefined && isSelfChat
      ? resolveIdentityNamePrefix(params.cfg, params.route.agentId)
      : undefined);

  const inboundHistory =
    params.msg.chatType === "group"
      ? (params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? []).map(
          (entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }),
        )
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: params.msg.body,
    InboundHistory: inboundHistory,
    RawBody: params.msg.body,
    CommandBody: params.msg.body,
    From: params.msg.from,
    To: params.msg.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    MessageSid: params.msg.id,
    ReplyToId: replyTo?.id,
    ReplyToBody: replyTo?.body,
    ReplyToSender: replyTo?.sender?.label,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    ChatType: params.msg.chatType,
    Timestamp: params.msg.timestamp,
    ConversationLabel: params.msg.chatType === "group" ? conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberNames.get(params.groupHistoryKey),
      fallbackE164: sender.e164 ?? undefined,
    }),
    SenderName: sender.name ?? undefined,
    SenderId: getPrimaryIdentityId(sender) ?? undefined,
    SenderE164: sender.e164 ?? undefined,
    CommandAuthorized: commandAuthorized,
    WasMentioned: params.msg.wasMentioned,
    ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from,
  });

  // Only update main session's lastRoute when DM actually IS the main session.
  // When dmScope="per-channel-peer", the DM uses an isolated sessionKey,
  // and updating mainSessionKey would corrupt routing for the session owner.
  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    msg: params.msg,
  });
  const shouldUpdateMainLastRoute =
    !pinnedMainDmRecipient || pinnedMainDmRecipient === dmRouteTarget;
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route: params.route,
    sessionKey: params.route.sessionKey,
  });
  if (
    dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    shouldUpdateMainLastRoute
  ) {
    updateLastRouteInBackground({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: dmRouteTarget,
      accountId: params.route.accountId,
      ctx: ctxPayload,
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  } else if (
    dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    pinnedMainDmRecipient
  ) {
    logVerbose(
      `Skipping main-session last route update for ${dmRouteTarget} (pinned owner ${pinnedMainDmRecipient})`,
    );
  }

  const metaTask = recordSessionMetaFromInbound({
    storePath,
    sessionKey: params.route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    params.replyLogger.warn(
      {
        error: formatError(err),
        storePath,
        sessionKey: params.route.sessionKey,
      },
      "failed updating session meta",
    );
  });
  trackBackgroundTask(params.backgroundTasks, metaTask);

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      ...replyPipeline,
      responsePrefix,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload: ReplyPayload, info) => {
        if (info.kind !== "final") {
          // Only deliver final replies to external messaging channels (WhatsApp).
          // Block (reasoning/thinking) and tool updates are meant for the internal
          // web UI only; sending them here leaks chain-of-thought to end users.
          return;
        }
        await deliverWebReply({
          replyResult: payload,
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
        const shouldLog = payload.text ? true : undefined;
        params.rememberSentText(payload.text, {
          combinedBody,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog,
        });
        const fromDisplay =
          params.msg.chatType === "group" ? conversationId : (params.msg.from ?? "unknown");
        const reply = resolveSendableOutboundReplyParts(payload);
        const hasMedia = reply.hasMedia;
        whatsappOutboundLog.info(`Auto-replied to ${fromDisplay}${hasMedia ? " (media)" : ""}`);
        if (shouldLogVerbose()) {
          const preview = payload.text != null ? elide(reply.text, 400) : "<media>";
          whatsappOutboundLog.debug(`Reply body: ${preview}${hasMedia ? " (media)" : ""}`);
        }
      },
      onError: (err, info) => {
        const label =
          info.kind === "tool"
            ? "tool update"
            : info.kind === "block"
              ? "block update"
              : "auto-reply";
        whatsappOutboundLog.error(
          `Failed sending web ${label} to ${params.msg.from ?? conversationId}: ${formatError(err)}`,
        );
      },
      onReplyStart: params.msg.sendComposing,
    },
    replyOptions: {
      // WhatsApp delivery intentionally suppresses non-final payloads.
      // Keep block streaming disabled so final replies are still produced.
      disableBlockStreaming: true,
      onModelSelected,
    },
  });

  if (!queuedFinal) {
    if (shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}
