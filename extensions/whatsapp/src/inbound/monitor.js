import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import { createInboundDebouncer } from "../../../../src/auto-reply/inbound-debounce.js";
import { formatLocationText } from "../../../../src/channels/location.js";
import { logVerbose, shouldLogVerbose } from "../../../../src/globals.js";
import { recordChannelActivity } from "../../../../src/infra/channel-activity.js";
import { getChildLogger } from "../../../../src/logging/logger.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { saveMediaBuffer } from "../../../../src/media/store.js";
import { jidToE164, resolveJidToE164 } from "../../../../src/utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";
async function monitorWebInbox(options) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();
  let onCloseResolve = null;
  const onClose = new Promise((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }
  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey = msg.chatType === "group" ? msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = /* @__PURE__ */ new Set();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries.map((entry) => entry.body).filter(Boolean).join("\n");
      const combinedMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : void 0
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  });
  const groupMetaCache = /* @__PURE__ */ new Map();
  const GROUP_META_TTL_MS = 5 * 60 * 1e3;
  const lidLookup = sock.signalRepository?.lidMapping;
  const resolveInboundJid = async (jid) => resolveJidToE164(jid, { authDir: options.authDir, lidLookup });
  const getGroupMeta = async (jid) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants = (await Promise.all(
        meta.participants?.map(async (p) => {
          const mapped = await resolveInboundJid(p.id);
          return mapped ?? p.id;
        }) ?? []
      )).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };
  const normalizeInboundMessage = async (msg) => {
    const id = msg.key?.id ?? void 0;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }
    const group = isJidGroup(remoteJid) === true;
    if (id) {
      const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
      if (isRecentInboundMessage(dedupeKey)) {
        return null;
      }
    }
    const participantJid = msg.key?.participant ?? void 0;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group ? participantJid ? await resolveInboundJid(participantJid) : null : from;
    let groupSubject;
    let groupParticipants;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1e3 : void 0;
    const access = await checkInboundAccessControl({
      accountId: options.accountId,
      from,
      selfE164,
      senderE164,
      group,
      pushName: msg.pushName ?? void 0,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
      remoteJid
    });
    if (!access.allowed) {
      return null;
    }
    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access
    };
  };
  const maybeMarkInboundAsRead = async (inbound) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ remoteJid, id, participant: participantJid, fromMe: false }]);
        if (shouldLogVerbose()) {
          const suffix = participantJid ? ` (participant ${participantJid})` : "";
          logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
        }
      } catch (err) {
        logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
      }
    } else if (id && access.isSelfChat && shouldLogVerbose()) {
      logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
    }
  };
  const enrichInboundMessage = async (msg) => {
    const location = extractLocationData(msg.message ?? void 0);
    const locationText = location ? formatLocationText(location) : void 0;
    let body = extractText(msg.message ?? void 0);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? void 0);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message);
    let mediaPath;
    let mediaType;
    let mediaFileName;
    try {
      const inboundMedia = await downloadInboundMedia(msg, sock);
      if (inboundMedia) {
        const maxMb = typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0 ? options.mediaMaxMb : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName
        );
        mediaPath = saved.path;
        mediaType = inboundMedia.mimetype;
        mediaFileName = inboundMedia.fileName;
      }
    } catch (err) {
      logVerbose(`Inbound media download failed: ${String(err)}`);
    }
    return {
      body,
      location: location ?? void 0,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName
    };
  };
  const enqueueInboundMessage = async (msg, inbound, enriched) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      try {
        await sock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logVerbose(`Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text) => {
      await sock.sendMessage(chatJid, { text });
    };
    const sendMedia = async (payload) => {
      await sock.sendMessage(chatJid, payload);
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message);
    const senderName = msg.pushName ?? void 0;
    inboundLogger.info(
      {
        from: inbound.from,
        to: selfE164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp
      },
      "inbound message"
    );
    const inboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: selfE164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? void 0,
      senderName,
      replyToId: enriched.replyContext?.id,
      replyToBody: enriched.replyContext?.body,
      replyToSender: enriched.replyContext?.sender,
      replyToSenderJid: enriched.replyContext?.senderJid,
      replyToSenderE164: enriched.replyContext?.senderE164,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentionedJids: mentionedJids ?? void 0,
      selfJid,
      selfE164,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? void 0,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName
    };
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };
  const handleMessagesUpsert = async (upsert) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound"
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }
      await maybeMarkInboundAsRead(inbound);
      if (upsert.type === "append") {
        continue;
      }
      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }
      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);
  const handleConnectionUpdate = (update) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === DisconnectReason.loggedOut,
          error: update.lastDisconnect?.error
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: void 0, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);
  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid, content) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid) => sock.sendPresenceUpdate(presence, jid)
    },
    defaultAccountId: options.accountId
  });
  return {
    close: async () => {
      try {
        const ev = sock.ev;
        const messagesUpsertHandler = handleMessagesUpsert;
        const connectionUpdateHandler = handleConnectionUpdate;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason) => {
      resolveClose(reason ?? { status: void 0, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi
  };
}
export {
  monitorWebInbox
};
