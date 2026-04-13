import type { AnyMessageContent, proto, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { createInboundDebouncer, formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
import { readWebSelfIdentity } from "../auth-store.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  isRecentInboundMessage,
  isRecentOutboundMessage,
  rememberRecentOutboundMessage,
} from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia } from "./media.js";
import { DisconnectReason, isJidGroup, saveMediaBuffer } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

export type MonitorWebInboxOptions = {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
};

export async function attachWebInboxToSocket(
  options: MonitorWebInboxOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  const presence = options.selfChatMode ? "unavailable" : "available";

  try {
    await sock.sendPresenceUpdate(presence);
    if (shouldLogVerbose()) {
      logVerbose(`Sent global '${presence}' presence on connect`);
    }
  } catch (err) {
    logVerbose(`Failed to send '${presence}' presence on connect: ${String(err)}`);
  }

  const self = await readWebSelfIdentity(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  // Track message IDs that are currently buffered in the debouncer (not yet
  // flushed to the agent). Used by the messages.update handler to silently
  // swap in the edited text before the agent ever sees the original.
  const pendingMessageIds = new Map<string, WebInboundMessage>();
  // Track message IDs that have been fully processed (flushed + onMessage
  // completed). Only edits to these messages trigger a notification — this
  // prevents edits to ignored, historical, or access-denied messages from
  // producing unexpected outbound replies.
  const processedMessageIds = new Set<string>();
  const MAX_PROCESSED_IDS = 512;
  const rememberProcessedId = (id: string) => {
    if (processedMessageIds.size >= MAX_PROCESSED_IDS) {
      // Evict the oldest entry (Sets preserve insertion order).
      const first = processedMessageIds.values().next().value;
      if (first !== undefined) {
        processedMessageIds.delete(first);
      }
    }
    processedMessageIds.add(id);
  };

  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const sender = msg.sender;
      const senderKey =
        msg.chatType === "group"
          ? (getPrimaryIdentityId(sender ?? null) ??
            msg.senderJid ??
            msg.senderE164 ??
            msg.senderName ??
            msg.from)
          : msg.from;
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
      let messageToDeliver: WebInboundMessage;
      if (entries.length === 1) {
        messageToDeliver = last;
      } else {
        const mentioned = new Set<string>();
        for (const entry of entries) {
          for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
            mentioned.add(jid);
          }
        }
        const combinedBody = entries
          .map((entry) => entry.body)
          .filter(Boolean)
          .join("\n");
        messageToDeliver = {
          ...last,
          body: combinedBody,
          mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
        };
      }
      // Deliver first, then update tracking. This closes the race where an
      // edit event arrives after pendingMessageIds is cleared but before
      // onMessage completes — without this ordering, Case 2 would fire
      // a "already processed" notification while the agent is still handling
      // the original body.
      // Use try/finally so pendingMessageIds is always cleared even if
      // onMessage rejects — preventing stale entries from accumulating.
      // rememberProcessedId runs only on success: a failed flush means the
      // agent never actually processed the message, so later edits should
      // not trigger a "already processed" notification.
      let deliverySucceeded = false;
      try {
        await options.onMessage(messageToDeliver);
        deliverySucceeded = true;
      } finally {
        for (const entry of entries) {
          if (entry.id) {
            pendingMessageIds.delete(entry.id);
            if (deliverySucceeded) {
              rememberProcessedId(entry.id);
            }
          }
        }
      }
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const rememberOutboundMessage = (remoteJid: string, result: unknown) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      remoteJid,
      messageId,
    });
  };

  const sendTrackedMessage = async (jid: string, content: AnyMessageContent) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          const result = await currentSock.sendMessage(jid, content);
          rememberOutboundMessage(jid, result);
          return result;
        } catch (err) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) {
            throw err;
          }
          lastErr = err;
          if (
            shouldClearSocketRefAfterSendFailure(err) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logVerbose(
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      logVerbose(`Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`);
      return null;
    }
    if (id) {
      const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
      if (isRecentInboundMessage(dedupeKey)) {
        return null;
      }
    }
    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    const access = await checkInboundAccessControl({
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      sock: { sendMessage: (jid, content) => sendTrackedMessage(jid, content) },
      remoteJid,
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
      access,
    };
  };

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
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
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
      if (inboundMedia) {
        const maxMb =
          typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
            ? options.mediaMaxMb
            : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName,
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
      location: location ?? undefined,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logVerbose(`Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string) => {
      await sendTrackedMessage(chatJid, { text });
    };
    const sendMedia = async (payload: AnyMessageContent) => {
      await sendTrackedMessage(chatJid, payload);
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const inboundMessage: WebInboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: self.e164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? undefined,
      senderName,
      replyTo: enriched.replyContext ?? undefined,
      replyToId: enriched.replyContext?.id,
      replyToBody: enriched.replyContext?.body,
      replyToSender: enriched.replyContext?.sender?.label ?? undefined,
      replyToSenderJid: enriched.replyContext?.sender?.jid ?? undefined,
      replyToSenderE164: enriched.replyContext?.sender?.e164 ?? undefined,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentions: mentionedJids ?? undefined,
      mentionedJids: mentionedJids ?? undefined,
      self,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      selfE164: self.e164 ?? undefined,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? undefined,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName,
    };
    // Register this message as pending so the edit handler can swap its body
    // before the debouncer flushes it to the agent.
    if (inboundMessage.id) {
      pendingMessageIds.set(inboundMessage.id, inboundMessage);
    }
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

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  // Handle message edits and revocations from WhatsApp.
  //
  // Two cases:
  //   1. Message is still pending in the debouncer → silently swap the body,
  //      the agent never sees the original typo.
  //   2. Message already flushed (agent already replied) → send a notification
  //      so the user knows their edit was seen after the fact.
  const handleMessagesUpdate = async (
    updates: Array<{
      update: Partial<WAMessage>;
      key: { id?: string; remoteJid?: string; fromMe?: boolean };
    }>,
  ) => {
    for (const { update, key } of updates) {
      const msgId = key.id;
      const remoteJid = key.remoteJid;

      // Skip messages with no id or remoteJid.
      // Do NOT skip fromMe unconditionally: in self-chat mode the owner's own
      // messages have fromMe=true but should still be tracked for edits.
      // Instead, skip only outbound bot messages that were sent by sendTrackedMessage
      // (those are already filtered by the rememberRecentOutboundMessage dedupe path
      // in normalizeInboundMessage and will not be in pendingMessageIds).
      if (!msgId || !remoteJid) {
        continue;
      }

      // Detect revocation: protocolMessage with type REVOKE (0).
      const protocolMsg = update.message?.protocolMessage;
      const isRevoke =
        protocolMsg != null &&
        (protocolMsg.type === 0 || (protocolMsg as { type?: number }).type === 0);

      if (isRevoke) {
        logVerbose(`Message ${msgId} revoked by user — ignoring`);
        continue;
      }

      // Detect edit: editedMessage present in the protocol message (type 14).
      const isEdit =
        protocolMsg != null &&
        ((protocolMsg as { type?: number }).type === 14 || protocolMsg.editedMessage != null);

      if (!isEdit) {
        continue;
      }

      // Extract new text from the edited message.
      // protocolMsg.editedMessage is proto.IMessage, which has .conversation
      // and .extendedTextMessage directly (no intermediate .message wrapper).
      const editedMsg = protocolMsg?.editedMessage as
        | { conversation?: string | null; extendedTextMessage?: { text?: string | null } | null }
        | null
        | undefined;
      const editedBody = editedMsg?.conversation ?? editedMsg?.extendedTextMessage?.text ?? null;

      if (!editedBody) {
        logVerbose(`Edit event for ${msgId} had no extractable text — skipping`);
        continue;
      }

      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });

      const pending = pendingMessageIds.get(msgId);
      if (pending) {
        // ✅ Case 1: Still buffered — swap the body in place. The debouncer
        // will flush the updated version; the agent sees only the corrected text.
        pending.body = editedBody;
        if (shouldLogVerbose()) {
          logVerbose(`Swapped pending message ${msgId} body to edited version: "${editedBody}"`);
        }
      } else if (processedMessageIds.has(msgId)) {
        // ⚠️ Case 2: Already flushed and confirmed processed — notify the user
        // that we've seen an edit after the fact so they can decide to resend.
        // We only notify for messages that passed access-control and were
        // actually delivered to the agent; edits to ignored or historical
        // messages are silently dropped.
        if (shouldLogVerbose()) {
          logVerbose(`Edit received for already-processed message ${msgId} — notifying user`);
        }
        try {
          await sendTrackedMessage(remoteJid, {
            text: `✏️ (You edited a message I already processed. If you'd like me to handle the updated version, please resend it.)`,
          });
        } catch (err) {
          logVerbose(`Failed to send edit-notification for ${msgId}: ${String(err)}`);
        }
      } else {
        logVerbose(`Edit received for unknown/ignored message ${msgId} — skipping notification`);
      }
    }
  };

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsert as unknown as (...args: unknown[]) => void,
  );
  const detachMessagesUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.update",
    handleMessagesUpdate as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      if (shouldLogVerbose()) {
        logVerbose(`Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`);
      }
    } catch (err) {
      const error = String(err);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logVerbose(`Failed to hydrate participating groups on connect: ${error}`);
    }
  })();

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
    },
    defaultAccountId: options.accountId,
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachMessagesUpdate();
        detachConnectionUpdate();
        closeInboundMonitorSocket(sock);
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  return attachWebInboxToSocket({
    ...options,
    sock,
  });
}
