import { resolveIdentityNamePrefix } from "../../../../../src/agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../../../../src/auto-reply/chunk.js";
import { shouldComputeCommandAuthorized } from "../../../../../src/auto-reply/command-detection.js";
import { formatInboundEnvelope } from "../../../../../src/auto-reply/envelope.js";
import {
  buildHistoryContextFromEntries
} from "../../../../../src/auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../../../src/auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../../../src/auto-reply/reply/provider-dispatcher.js";
import { toLocationContext } from "../../../../../src/channels/location.js";
import { createReplyPrefixOptions } from "../../../../../src/channels/reply-prefix.js";
import { resolveInboundSessionEnvelopeContext } from "../../../../../src/channels/session-envelope.js";
import { resolveMarkdownTableMode } from "../../../../../src/config/markdown-tables.js";
import { recordSessionMetaFromInbound } from "../../../../../src/config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../../../../../src/globals.js";
import { getAgentScopedMediaLocalRoots } from "../../../../../src/media/local-roots.js";
import {
  resolveInboundLastRouteSessionKey
} from "../../../../../src/routing/resolve-route.js";
import {
  readStoreAllowFromForDmPolicy,
  resolvePinnedMainDmOwnerFromAllowlist,
  resolveDmGroupAccessWithCommandGate
} from "../../../../../src/security/dm-policy-shared.js";
import { jidToE164, normalizeE164 } from "../../../../../src/utils.js";
import { resolveWhatsAppAccount } from "../../accounts.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog, whatsappOutboundLog } from "../loggers.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { formatGroupMembers } from "./group-members.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
async function resolveWhatsAppCommandAuthorized(params) {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }
  const isGroup = params.msg.chatType === "group";
  const senderE164 = normalizeE164(
    isGroup ? params.msg.senderE164 ?? "" : params.msg.senderE164 ?? params.msg.from ?? ""
  );
  if (!senderE164) {
    return false;
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  const dmPolicy = account.dmPolicy ?? "pairing";
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom = account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : void 0);
  const storeAllowFrom = isGroup ? [] : await readStoreAllowFromForDmPolicy({
    provider: "whatsapp",
    accountId: params.msg.accountId,
    dmPolicy
  });
  const dmAllowFrom = configuredAllowFrom.length > 0 ? configuredAllowFrom : params.msg.selfE164 ? [params.msg.selfE164] : [];
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
      const normalizedEntries = allowEntries.map((entry) => normalizeE164(String(entry))).filter((entry) => Boolean(entry));
      return normalizedEntries.includes(senderE164);
    },
    command: {
      useAccessGroups,
      allowTextCommands: true,
      hasControlCommand: true
    }
  });
  return access.commandAuthorized;
}
function resolvePinnedMainDmRecipient(params) {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: account.allowFrom,
    normalizeEntry: (entry) => normalizeE164(entry)
  });
}
async function processMessage(params) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey
  });
  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions
  });
  let shouldClearGroupHistory = false;
  if (params.msg.chatType === "group") {
    const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
    if (history.length > 0) {
      const historyEntries = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp
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
            envelope: envelopeOptions
          });
        }
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }
  maybeSendAckReaction({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    conversationId,
    verbose: params.verbose,
    accountId: params.route.accountId,
    info: params.replyLogger.info.bind(params.replyLogger),
    warn: params.replyLogger.warn.bind(params.replyLogger)
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
      mediaPath: params.msg.mediaPath ?? null
    },
    "inbound web message"
  );
  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }
  const dmRouteTarget = params.msg.chatType !== "group" ? (() => {
    if (params.msg.senderE164) {
      return normalizeE164(params.msg.senderE164);
    }
    if (params.msg.from.includes("@")) {
      return jidToE164(params.msg.from);
    }
    return normalizeE164(params.msg.from);
  })() : void 0;
  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  let didLogHeartbeatStrip = false;
  let didSendReply = false;
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg) ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg }) : void 0;
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId
  });
  const isSelfChat = params.msg.chatType !== "group" && Boolean(params.msg.selfE164) && normalizeE164(params.msg.from) === normalizeE164(params.msg.selfE164 ?? "");
  const responsePrefix = prefixOptions.responsePrefix ?? (configuredResponsePrefix === void 0 && isSelfChat ? resolveIdentityNamePrefix(params.cfg, params.route.agentId) : void 0);
  const inboundHistory = params.msg.chatType === "group" ? (params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? []).map(
    (entry) => ({
      sender: entry.sender,
      body: entry.body,
      timestamp: entry.timestamp
    })
  ) : void 0;
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
    ReplyToId: params.msg.replyToId,
    ReplyToBody: params.msg.replyToBody,
    ReplyToSender: params.msg.replyToSender,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    ChatType: params.msg.chatType,
    ConversationLabel: params.msg.chatType === "group" ? conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberNames.get(params.groupHistoryKey),
      fallbackE164: params.msg.senderE164
    }),
    SenderName: params.msg.senderName,
    SenderId: params.msg.senderJid?.trim() || params.msg.senderE164,
    SenderE164: params.msg.senderE164,
    CommandAuthorized: commandAuthorized,
    WasMentioned: params.msg.wasMentioned,
    ...params.msg.location ? toLocationContext(params.msg.location) : {},
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from
  });
  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    msg: params.msg
  });
  const shouldUpdateMainLastRoute = !pinnedMainDmRecipient || pinnedMainDmRecipient === dmRouteTarget;
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route: params.route,
    sessionKey: params.route.sessionKey
  });
  if (dmRouteTarget && inboundLastRouteSessionKey === params.route.mainSessionKey && shouldUpdateMainLastRoute) {
    updateLastRouteInBackground({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: dmRouteTarget,
      accountId: params.route.accountId,
      ctx: ctxPayload,
      warn: params.replyLogger.warn.bind(params.replyLogger)
    });
  } else if (dmRouteTarget && inboundLastRouteSessionKey === params.route.mainSessionKey && pinnedMainDmRecipient) {
    logVerbose(
      `Skipping main-session last route update for ${dmRouteTarget} (pinned owner ${pinnedMainDmRecipient})`
    );
  }
  const metaTask = recordSessionMetaFromInbound({
    storePath,
    sessionKey: params.route.sessionKey,
    ctx: ctxPayload
  }).catch((err) => {
    params.replyLogger.warn(
      {
        error: formatError(err),
        storePath,
        sessionKey: params.route.sessionKey
      },
      "failed updating session meta"
    );
  });
  trackBackgroundTask(params.backgroundTasks, metaTask);
  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      ...prefixOptions,
      responsePrefix,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload, info) => {
        if (info.kind !== "final") {
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
          tableMode
        });
        didSendReply = true;
        const shouldLog = payload.text ? true : void 0;
        params.rememberSentText(payload.text, {
          combinedBody,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog
        });
        const fromDisplay2 = params.msg.chatType === "group" ? conversationId : params.msg.from ?? "unknown";
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        whatsappOutboundLog.info(`Auto-replied to ${fromDisplay2}${hasMedia ? " (media)" : ""}`);
        if (shouldLogVerbose()) {
          const preview = payload.text != null ? elide(payload.text, 400) : "<media>";
          whatsappOutboundLog.debug(`Reply body: ${preview}${hasMedia ? " (media)" : ""}`);
        }
      },
      onError: (err, info) => {
        const label = info.kind === "tool" ? "tool update" : info.kind === "block" ? "block update" : "auto-reply";
        whatsappOutboundLog.error(
          `Failed sending web ${label} to ${params.msg.from ?? conversationId}: ${formatError(err)}`
        );
      },
      onReplyStart: params.msg.sendComposing
    },
    replyOptions: {
      // WhatsApp delivery intentionally suppresses non-final payloads.
      // Keep block streaming disabled so final replies are still produced.
      disableBlockStreaming: true,
      onModelSelected
    }
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
export {
  processMessage
};
