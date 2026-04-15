/**
 * Core gateway — WebSocket connection, event dispatch, and message handling.
 *
 * All imports use core/ modules or upper-layer files that are shared
 * between both built-in and standalone versions.
 *
 * Only 4 upper-layer files are still imported (heavy I/O, not yet migrated):
 * - outbound.ts (sendDocument, sendMedia)
 * - outbound-deliver.ts (parseAndSendMediaTags, sendPlainReply)
 * - reply-dispatcher.ts (handleStructuredPayload, sendErrorToTarget)
 * - inbound-attachments.ts (processAttachments)
 * - slash-commands.ts (matchSlashCommand — concrete command implementations)
 */

import path from "node:path";
import WebSocket from "ws";
import {
  audioFileToSilkBase64,
  formatDuration,
  convertSilkToWav,
  isVoiceAttachment,
  isAudioFile,
  shouldTranscodeVoice,
  waitForFile,
} from "../../utils/audio-convert.js";
// ---- core/ api facade (singleton + procedural wrappers) ----
import {
  clearTokenCache,
  getAccessToken,
  getGatewayUrl,
  initApiConfig,
  onMessageSent,
  PLUGIN_USER_AGENT,
  sendC2CInputNotify,
  sendC2CMessage,
  sendChannelMessage,
  sendDmMessage,
  sendGroupMessage,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from "../api/facade.js";
// ---- core/ messaging ----
import {
  parseAndSendMediaTags,
  sendPlainReply,
  type DeliverDeps,
} from "../messaging/outbound-deliver.js";
import {
  sendDocument,
  sendMedia,
  sendPhoto,
  sendVoice,
  sendVideoMsg,
  registerOutboundAudioAdapter,
} from "../messaging/outbound.js";
import {
  handleStructuredPayload,
  sendErrorToTarget,
  sendWithTokenRetry,
  type ReplyDispatcherDeps,
} from "../messaging/reply-dispatcher.js";
// ---- core/ ref ----
import { formatRefEntryForAgent } from "../ref/format-ref-entry.js";
import { flushRefIndex, getRefIndex, setRefIndex } from "../ref/store.js";
// ---- core/ session ----
import { flushKnownUsers, recordKnownUser } from "../session/known-users.js";
import { parseRefIndices, parseFaceTags, buildAttachmentSummaries } from "../utils/text-parsing.js";
// ---- core/ utils ----
import { formatVoiceText } from "../utils/voice-text.js";
import { formatAllowFrom } from "./allow-from.js";
// ---- core/ gateway modules ----
import { decodeGatewayMessageData, readOptionalMessageSceneExt } from "./codec.js";
import {
  FULL_INTENTS,
  RECONNECT_DELAYS,
  RATE_LIMIT_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  MAX_QUICK_DISCONNECT_COUNT,
  QUICK_DISCONNECT_THRESHOLD,
} from "./constants.js";
import { runDiagnostics } from "./diagnostics.js";
import { processAttachments, registerAudioConvertAdapter } from "./inbound-attachments.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { clearSession, loadSession, saveSession } from "./session-store.js";
// ---- Upper-layer files NOT yet migrated to core/ (heavy I/O) ----
import { matchSlashCommand } from "./slash-commands-impl.js";
import type { SlashCommandContext } from "./slash-commands.js";
import type { CoreGatewayContext, OutboundResult, RefAttachmentSummary } from "./types.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";

// Re-export context type for consumers.
export type { CoreGatewayContext } from "./types.js";

// ============ Event types (local, avoids importing src/types.ts) ============

interface C2CMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { user_openid: string };
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
  message_scene?: { ext?: string[] };
}

interface GuildMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string };
  channel_id: string;
  guild_id: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
  message_scene?: { ext?: string[] };
}

interface GroupMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { member_openid: string };
  group_openid: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
  message_scene?: { ext?: string[] };
}

interface WSPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

// ============ startGateway ============

/**
 * Start the Gateway WebSocket connection with automatic reconnect support.
 */
export async function startGateway(ctx: CoreGatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log, runtime } = ctx;

  // Register audio conversion adapter for inbound-attachments.
  registerAudioConvertAdapter({ convertSilkToWav, isVoiceAttachment, formatDuration });
  // Register audio adapter for outbound media sends.
  registerOutboundAudioAdapter({
    audioFileToSilkBase64: async (p, f) => (await audioFileToSilkBase64(p, f)) ?? undefined,
    isAudioFile,
    shouldTranscodeVoice,
    waitForFile,
  });

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // Run environment diagnostics during startup.
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // Initialize API behavior such as markdown support.
  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport}`);

  // Cache outbound refIdx values from QQ delivery responses for future quoting.
  onMessageSent(account.appId, (refIdx, meta) => {
    log?.info(
      `[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`,
    );
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  });

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime = 0;
  let quickDisconnectCount = 0;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldRefreshToken = false;

  // Restore a persisted session.
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    log?.info(
      `[qqbot:${account.accountId}] Restored session: sessionId=${sessionId}, lastSeq=${lastSeq}`,
    );
  }

  const msgQueue = createMessageQueue({
    accountId: account.accountId,
    log,
    isAborted: () => isAborted,
  });

  // Slash command interception.
  const URGENT_COMMANDS = ["/stop"];

  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    const content = (msg.content ?? "").trim();
    if (!content.startsWith("/")) {
      msgQueue.enqueue(msg);
      return;
    }

    const contentLower = content.toLowerCase();
    const isUrgentCommand = URGENT_COMMANDS.some(
      (cmd) =>
        contentLower === cmd.toLowerCase() || contentLower.startsWith(cmd.toLowerCase() + " "),
    );
    if (isUrgentCommand) {
      log?.info(`[qqbot:${account.accountId}] Urgent command detected: ${content.slice(0, 20)}`);
      const peerId = msgQueue.getMessagePeerId(msg);
      msgQueue.clearUserQueue(peerId);
      msgQueue.executeImmediate(msg);
      return;
    }

    const receivedAt = Date.now();
    const peerId = msgQueue.getMessagePeerId(msg);
    const cmdCtx: SlashCommandContext = {
      type: msg.type,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      eventTimestamp: msg.timestamp,
      receivedAt,
      rawContent: content,
      args: "",
      channelId: msg.channelId,
      groupOpenid: msg.groupOpenid,
      accountId: account.accountId,
      appId: account.appId,
      accountConfig: account.config,
      commandAuthorized: true,
      queueSnapshot: msgQueue.getSnapshot(peerId),
    };

    try {
      const reply = await matchSlashCommand(cmdCtx);
      if (reply === null) {
        msgQueue.enqueue(msg);
        return;
      }

      log?.info(`[qqbot:${account.accountId}] Slash command matched: ${content}`);
      const token = await getAccessToken(account.appId, account.clientSecret);

      const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
      const replyText = isFileResult ? (reply as { text: string }).text : reply;
      const replyFile = isFileResult ? (reply as { filePath: string }).filePath : null;

      if (msg.type === "c2c") {
        await sendC2CMessage(account.appId, token, msg.senderId, replyText, msg.messageId);
      } else if (msg.type === "group" && msg.groupOpenid) {
        await sendGroupMessage(account.appId, token, msg.groupOpenid, replyText, msg.messageId);
      } else if (msg.channelId) {
        await sendChannelMessage(token, msg.channelId, replyText, msg.messageId);
      } else if (msg.type === "dm" && msg.guildId) {
        await sendDmMessage(token, msg.guildId, replyText, msg.messageId);
      }

      if (replyFile) {
        try {
          const targetType =
            msg.type === "group"
              ? "group"
              : msg.type === "dm"
                ? "dm"
                : msg.type === "c2c"
                  ? "c2c"
                  : "channel";
          const targetId =
            msg.type === "group"
              ? msg.groupOpenid || msg.senderId
              : msg.type === "dm"
                ? msg.guildId || msg.senderId
                : msg.type === "c2c"
                  ? msg.senderId
                  : msg.channelId || msg.senderId;
          await sendDocument(
            {
              targetType,
              targetId,
              account,
              replyToId: msg.messageId,
              logPrefix: `[qqbot:${account.accountId}]`,
            },
            replyFile,
          );
        } catch (fileErr) {
          log?.error(
            `[qqbot:${account.accountId}] Failed to send slash command file: ${String(fileErr)}`,
          );
        }
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Slash command error: ${String(err)}`);
      msgQueue.enqueue(msg);
    }
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    stopBackgroundTokenRefresh(account.appId);
    flushKnownUsers();
    flushRefIndex();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (
      currentWs &&
      (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)
    ) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () =>
    RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(
      `[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        void connect();
      }
    }, delay);
  };

  const connect = async () => {
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);
      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": PLUGIN_USER_AGENT } });
      currentWs = ws;

      // ---- handleMessage ----
      const handleMessage = async (
        event: QueuedMessage & { refMsgIdx?: string; msgIdx?: string },
      ) => {
        log?.info(
          `[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`,
        );

        runtime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        const isC2C = event.type === "c2c" || event.type === "dm";
        const typing: { keepAlive: TypingKeepAlive | null } = { keepAlive: null };

        const inputNotifyPromise: Promise<string | undefined> = (async () => {
          if (!isC2C) {
            return undefined;
          }
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              const resp = await sendC2CInputNotify(
                token,
                event.senderId,
                event.messageId,
                TYPING_INPUT_SECOND,
              );
              typing.keepAlive = new TypingKeepAlive(
                () => getAccessToken(account.appId, account.clientSecret),
                () => clearTokenCache(account.appId),
                (t, o, m, s) => sendC2CInputNotify(t, o, m, s),
                event.senderId,
                event.messageId,
                log,
                `[qqbot:${account.accountId}]`,
              );
              typing.keepAlive.start();
              return resp.refIdx;
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                const resp = await sendC2CInputNotify(
                  token,
                  event.senderId,
                  event.messageId,
                  TYPING_INPUT_SECOND,
                );
                typing.keepAlive = new TypingKeepAlive(
                  () => getAccessToken(account.appId, account.clientSecret),
                  () => clearTokenCache(account.appId),
                  (t, o, m, s) => sendC2CInputNotify(t, o, m, s),
                  event.senderId,
                  event.messageId,
                  log,
                  `[qqbot:${account.accountId}]`,
                );
                typing.keepAlive.start();
                return resp.refIdx;
              }
              throw notifyErr;
            }
          } catch (err) {
            log?.error(
              `[qqbot:${account.accountId}] sendC2CInputNotify error: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          }
        })();

        const isGroupChat = event.type === "guild" || event.type === "group";
        const peerId =
          event.type === "guild"
            ? (event.channelId ?? "unknown")
            : event.type === "group"
              ? (event.groupOpenid ?? "unknown")
              : event.senderId;

        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: { kind: isGroupChat ? "group" : "direct", id: peerId },
        });

        const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }

        const processed = await processAttachments(event.attachments, {
          accountId: account.accountId,
          cfg,
          log,
        });
        const {
          attachmentInfo,
          imageUrls,
          imageMediaTypes,
          voiceAttachmentPaths,
          voiceAttachmentUrls,
          voiceAsrReferTexts,
          voiceTranscripts,
          voiceTranscriptSources,
          attachmentLocalPaths,
        } = processed;

        const voiceText = formatVoiceText(voiceTranscripts);
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");
        const parsedContent = parseFaceTags(event.content);
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        let replyToId: string | undefined;
        let replyToBody: string | undefined;
        let replyToSender: string | undefined;
        let replyToIsQuote = false;

        if (event.refMsgIdx) {
          const refEntry = getRefIndex(event.refMsgIdx);
          if (refEntry) {
            replyToId = event.refMsgIdx;
            replyToBody = formatRefEntryForAgent(refEntry);
            replyToSender = refEntry.senderName ?? refEntry.senderId;
            replyToIsQuote = true;
          } else {
            replyToId = event.refMsgIdx;
            replyToIsQuote = true;
          }
        }

        const inputNotifyRefIdx = await inputNotifyPromise;
        const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
        if (currentMsgIdx) {
          const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
          if (attSummaries && voiceTranscripts.length > 0) {
            let voiceIdx = 0;
            for (const att of attSummaries) {
              if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
                att.transcript = voiceTranscripts[voiceIdx];
                if (voiceIdx < voiceTranscriptSources.length) {
                  att.transcriptSource = voiceTranscriptSources[voiceIdx] as
                    | "stt"
                    | "asr"
                    | "tts"
                    | "fallback";
                }
                voiceIdx++;
              }
            }
          }
          setRefIndex(currentMsgIdx, {
            content: parsedContent,
            senderId: event.senderId,
            senderName: event.senderName,
            timestamp: new Date(event.timestamp).getTime(),
            attachments: attSummaries,
          });
        }

        const body = runtime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: { id: event.senderId, name: event.senderName },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
        const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
        const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);

        const qualifiedTarget = isGroupChat
          ? event.type === "guild"
            ? `qqbot:channel:${event.channelId}`
            : `qqbot:group:${event.groupOpenid}`
          : event.type === "dm"
            ? `qqbot:dm:${event.guildId}`
            : `qqbot:c2c:${event.senderId}`;

        let quotePart = "";
        if (replyToIsQuote) {
          quotePart = replyToBody
            ? `[Quoted message begins]\n${replyToBody}\n[Quoted message ends]\n`
            : `[Quoted message begins]\nOriginal content unavailable\n[Quoted message ends]\n`;
        }

        systemPrompts.unshift(`[QQBot] to=${qualifiedTarget}`);

        const dynLines: string[] = [];
        if (imageUrls.length > 0) {
          dynLines.push(`- Images: ${imageUrls.join(", ")}`);
        }
        if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          dynLines.push(`- Voice: ${[...uniqueVoicePaths, ...uniqueVoiceUrls].join(", ")}`);
        }
        if (uniqueVoiceAsrReferTexts.length > 0) {
          dynLines.push(`- ASR: ${uniqueVoiceAsrReferTexts.join(" | ")}`);
        }
        const dynamicCtx = dynLines.length > 0 ? dynLines.join("\n") + "\n" : "";

        const userMessage = `${quotePart}${userContent}`;
        const agentBody = userContent.startsWith("/")
          ? userContent
          : `${systemPrompts.join("\n")}\n\n${dynamicCtx}${userMessage}`;

        const fromAddress =
          event.type === "guild"
            ? `qqbot:channel:${event.channelId}`
            : event.type === "group"
              ? `qqbot:group:${event.groupOpenid}`
              : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        const normalizedAllowFrom = formatAllowFrom({ allowFrom: account.config?.allowFrom ?? [] });
        const normalizedSenderId = event.senderId.replace(/^qqbot:/i, "").toUpperCase();
        const allowAll =
          normalizedAllowFrom.length === 0 || normalizedAllowFrom.some((e) => e === "*");
        const commandAuthorized = allowAll || normalizedAllowFrom.includes(normalizedSenderId);

        const localMediaPaths: string[] = [];
        const localMediaTypes: string[] = [];
        const remoteMediaUrls: string[] = [];
        const remoteMediaTypes: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const u = imageUrls[i];
          const t = imageMediaTypes[i] ?? "image/png";
          if (u.startsWith("http://") || u.startsWith("https://")) {
            remoteMediaUrls.push(u);
            remoteMediaTypes.push(t);
          } else {
            localMediaPaths.push(u);
            localMediaTypes.push(t);
          }
        }

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroupChat ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
          QQVoiceAsrReferAvailable: hasAsrReferFallback,
          QQVoiceTranscriptSources: voiceTranscriptSources,
          QQVoiceAttachmentPaths: uniqueVoicePaths,
          QQVoiceAttachmentUrls: uniqueVoiceUrls,
          QQVoiceAsrReferTexts: uniqueVoiceAsrReferTexts,
          QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
          CommandAuthorized: commandAuthorized,
          ...(localMediaPaths.length > 0
            ? {
                MediaPaths: localMediaPaths,
                MediaPath: localMediaPaths[0],
                MediaTypes: localMediaTypes,
                MediaType: localMediaTypes[0],
              }
            : {}),
          ...(remoteMediaUrls.length > 0
            ? { MediaUrls: remoteMediaUrls, MediaUrl: remoteMediaUrls[0] }
            : {}),
          ...(replyToId
            ? {
                ReplyToId: replyToId,
                ReplyToBody: replyToBody,
                ReplyToSender: replyToSender,
                ReplyToIsQuote: replyToIsQuote,
              }
            : {}),
        });

        const replyTarget = {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          guildId: event.guildId,
          groupOpenid: event.groupOpenid,
        };
        const replyCtx = { target: replyTarget, account, cfg, log };

        const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
          sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

        const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

        try {
          const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );

          let hasResponse = false;
          let hasBlockResponse = false;
          let toolDeliverCount = 0;
          const toolTexts: string[] = [];
          const toolMediaUrls: string[] = [];
          let toolFallbackSent = false;
          const responseTimeout = 120000;
          const toolOnlyTimeout = 60000;
          const maxToolRenewals = 3;
          let toolRenewalCount = 0;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          const sendToolFallback = async (): Promise<void> => {
            if (toolMediaUrls.length > 0) {
              for (const mediaUrl of toolMediaUrls) {
                const ac = new AbortController();
                try {
                  const result = await Promise.race([
                    sendMedia({
                      to: qualifiedTarget,
                      text: "",
                      mediaUrl,
                      accountId: account.accountId,
                      replyToId: event.messageId,
                      account,
                    }).then((r) => {
                      if (ac.signal.aborted) {
                        return { channel: "qqbot", error: "suppressed" } as OutboundResult;
                      }
                      return r;
                    }),
                    new Promise<OutboundResult>((resolve) =>
                      setTimeout(() => {
                        ac.abort();
                        resolve({ channel: "qqbot", error: "timeout" });
                      }, 45000),
                    ),
                  ]);
                  if (result.error) {
                    log?.error(`[qqbot:${account.accountId}] Tool fallback error: ${result.error}`);
                  }
                } catch (err) {
                  log?.error(`[qqbot:${account.accountId}] Tool fallback failed: ${String(err)}`);
                }
              }
              return;
            }
            if (toolTexts.length > 0) {
              await sendErrorMessage(toolTexts.slice(-3).join("\n---\n").slice(0, 2000));
              return;
            }
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          const dispatchPromise = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (
                payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
                info: { kind: string },
              ) => {
                hasResponse = true;

                if (info.kind === "tool") {
                  toolDeliverCount++;
                  const toolText = (payload.text ?? "").trim();
                  if (toolText) {
                    toolTexts.push(toolText);
                  }
                  if (payload.mediaUrls?.length) {
                    toolMediaUrls.push(...payload.mediaUrls);
                  }
                  if (payload.mediaUrl && !toolMediaUrls.includes(payload.mediaUrl)) {
                    toolMediaUrls.push(payload.mediaUrl);
                  }

                  if (hasBlockResponse && toolMediaUrls.length > 0) {
                    const urlsToSend = [...toolMediaUrls];
                    toolMediaUrls.length = 0;
                    for (const mediaUrl of urlsToSend) {
                      try {
                        await sendMedia({
                          to: qualifiedTarget,
                          text: "",
                          mediaUrl,
                          accountId: account.accountId,
                          replyToId: event.messageId,
                          account,
                        });
                      } catch {}
                    }
                    return;
                  }
                  if (toolFallbackSent) {
                    return;
                  }
                  if (toolOnlyTimeoutId) {
                    if (toolRenewalCount < maxToolRenewals) {
                      clearTimeout(toolOnlyTimeoutId);
                      toolRenewalCount++;
                    } else {
                      return;
                    }
                  }
                  toolOnlyTimeoutId = setTimeout(async () => {
                    if (!hasBlockResponse && !toolFallbackSent) {
                      toolFallbackSent = true;
                      try {
                        await sendToolFallback();
                      } catch {}
                    }
                  }, toolOnlyTimeout);
                  return;
                }

                hasBlockResponse = true;
                typing.keepAlive?.stop();
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                if (toolOnlyTimeoutId) {
                  clearTimeout(toolOnlyTimeoutId);
                  toolOnlyTimeoutId = null;
                }

                const quoteRef = event.msgIdx;
                let quoteRefUsed = false;
                const consumeQuoteRef = (): string | undefined => {
                  if (quoteRef && !quoteRefUsed) {
                    quoteRefUsed = true;
                    return quoteRef;
                  }
                  return undefined;
                };

                let replyText = payload.text ?? "";
                const deliverEvent = {
                  type: event.type,
                  senderId: event.senderId,
                  messageId: event.messageId,
                  channelId: event.channelId,
                  groupOpenid: event.groupOpenid,
                  msgIdx: event.msgIdx,
                };
                const deliverActx = { account, qualifiedTarget, log };

                const deliverDeps: DeliverDeps = {
                  mediaSender: {
                    sendPhoto: (target, imageUrl) => sendPhoto(target as never, imageUrl),
                    sendVoice: (target, voicePath, uploadFormats, transcodeEnabled) =>
                      sendVoice(target as never, voicePath, uploadFormats, transcodeEnabled),
                    sendVideoMsg: (target, videoPath) => sendVideoMsg(target as never, videoPath),
                    sendDocument: (target, filePath) => sendDocument(target as never, filePath),
                    sendMedia: (opts) => sendMedia(opts as never),
                  },
                  chunkText: (text, limit) => runtime.channel.text.chunkMarkdownText(text, limit),
                };

                const mediaResult = await parseAndSendMediaTags(
                  replyText,
                  deliverEvent,
                  deliverActx,
                  sendWithRetry,
                  consumeQuoteRef,
                  deliverDeps,
                );
                if (mediaResult.handled) {
                  runtime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  return;
                }
                replyText = mediaResult.normalizedText;

                const recordOutbound = () =>
                  runtime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                const replyDeps: ReplyDispatcherDeps = {
                  tts: {
                    textToSpeech: (params) => runtime.tts.textToSpeech(params),
                    audioFileToSilkBase64: async (p) =>
                      (await audioFileToSilkBase64(p)) ?? undefined,
                  },
                };
                const handled = await handleStructuredPayload(
                  replyCtx,
                  replyText,
                  recordOutbound,
                  replyDeps,
                );
                if (handled) {
                  return;
                }

                await sendPlainReply(
                  payload,
                  replyText,
                  deliverEvent,
                  deliverActx,
                  sendWithRetry,
                  consumeQuoteRef,
                  toolMediaUrls,
                  deliverDeps,
                );
                runtime.channel.activity.record({
                  channel: "qqbot",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              onError: async (err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${errMsg}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
              },
            },
            replyOptions: { disableBlockStreaming: account.config.streaming?.mode === "off" },
          });

          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          } finally {
            if (toolOnlyTimeoutId) {
              clearTimeout(toolOnlyTimeoutId);
              toolOnlyTimeoutId = null;
            }
            if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              await sendToolFallback();
            }
          }
        } catch (err) {
          log?.error(
            `[qqbot:${account.accountId}] Message processing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          typing.keepAlive?.stop();
        }
      };

      // ---- WebSocket event handlers ----

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false;
        reconnectAttempts = 0;
        lastConnectTime = Date.now();
        msgQueue.startProcessor(handleMessage);
        startBackgroundTokenRefresh(account.appId, account.clientSecret, { log });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = decodeGatewayMessageData(data);
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: 0,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          switch (op) {
            case 10: {
              if (sessionId && lastSeq !== null) {
                ws.send(
                  JSON.stringify({
                    op: 6,
                    d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: lastSeq },
                  }),
                );
              } else {
                ws.send(
                  JSON.stringify({
                    op: 2,
                    d: { token: `QQBot ${accessToken}`, intents: FULL_INTENTS, shard: [0, 1] },
                  }),
                );
              }
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
              }
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                }
              }, interval);
              break;
            }
            case 0: {
              if (t === "READY") {
                sessionId = (d as { session_id: string }).session_id;
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex: 0,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                onReady?.(d);
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: 0,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const ev = d as C2CMessageEvent;
                recordKnownUser({
                  openid: ev.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                const refs = parseRefIndices(ev.message_scene?.ext);
                void trySlashCommandOrEnqueue({
                  type: "c2c",
                  senderId: ev.author.user_openid,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  attachments: ev.attachments,
                  refMsgIdx: refs.refMsgIdx,
                  msgIdx: refs.msgIdx,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const ev = d as GuildMessageEvent;
                const refs = parseRefIndices(
                  readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
                );
                void trySlashCommandOrEnqueue({
                  type: "guild",
                  senderId: ev.author.id,
                  senderName: ev.author.username,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  channelId: ev.channel_id,
                  guildId: ev.guild_id,
                  attachments: ev.attachments,
                  refMsgIdx: refs.refMsgIdx,
                  msgIdx: refs.msgIdx,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const ev = d as GuildMessageEvent;
                const refs = parseRefIndices(
                  readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
                );
                void trySlashCommandOrEnqueue({
                  type: "dm",
                  senderId: ev.author.id,
                  senderName: ev.author.username,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  guildId: ev.guild_id,
                  attachments: ev.attachments,
                  refMsgIdx: refs.refMsgIdx,
                  msgIdx: refs.msgIdx,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const ev = d as GroupMessageEvent;
                recordKnownUser({
                  openid: ev.author.member_openid,
                  type: "group",
                  groupOpenid: ev.group_openid,
                  accountId: account.accountId,
                });
                const refs = parseRefIndices(ev.message_scene?.ext);
                void trySlashCommandOrEnqueue({
                  type: "group",
                  senderId: ev.author.member_openid,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  groupOpenid: ev.group_openid,
                  attachments: ev.attachments,
                  refMsgIdx: refs.refMsgIdx,
                  msgIdx: refs.msgIdx,
                });
              }
              break;
            }
            case 11:
              break;
            case 7: {
              cleanup();
              scheduleReconnect();
              break;
            }
            case 9: {
              const canResume = d as boolean;
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                clearSession(account.accountId);
                shouldRefreshToken = true;
              }
              cleanup();
              scheduleReconnect(3000);
              break;
            }
          }
        } catch (err) {
          log?.error(
            `[qqbot:${account.accountId}] Message parse error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false;

        if (code === 4914 || code === 4915) {
          cleanup();
          return;
        }
        if (code === 4004) {
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }
        if (code === 4008) {
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }
        if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
          sessionId = null;
          lastSeq = null;
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }

        const dur = Date.now() - lastConnectTime;
        if (dur < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            quickDisconnectCount = 0;
            cleanup();
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          quickDisconnectCount = 0;
        }

        cleanup();
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });
    } catch (err) {
      isConnecting = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${errMsg}`);
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  await connect();
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
