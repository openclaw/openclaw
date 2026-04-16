/**
 * Core gateway entry point — thin shell that wires together:
 *
 * - GatewayConnection: WebSocket lifecycle, heartbeat, reconnect
 * - buildInboundContext: content building, attachments, quote resolution
 * - dispatchOutbound: AI dispatch, deliver callbacks, timeouts
 *
 * The only responsibilities of this file are:
 * 1. Register audio adapters
 * 2. Initialize API config + refIdx cache hook
 * 3. Create the message handler (inbound → outbound pipeline)
 * 4. Start GatewayConnection
 */

import path from "node:path";
import { registerOutboundAudioAdapter } from "../messaging/outbound.js";
import {
  clearTokenCache,
  getAccessToken,
  initApiConfig,
  onMessageSent,
  sendInputNotify as senderSendInputNotify,
  createRawInputNotifyFn,
  accountToCreds,
} from "../messaging/sender.js";
import { setRefIndex } from "../ref/store.js";
import {
  audioFileToSilkBase64,
  convertSilkToWav,
  isVoiceAttachment,
  isAudioFile,
  shouldTranscodeVoice,
  waitForFile,
} from "../utils/audio.js";
import { runDiagnostics } from "../utils/diagnostics.js";
import { formatDuration } from "../utils/format.js";
import { GatewayConnection } from "./gateway-connection.js";
import { registerAudioConvertAdapter } from "./inbound-attachments.js";
import { buildInboundContext } from "./inbound-pipeline.js";
import type { QueuedMessage } from "./message-queue.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type {
  CoreGatewayContext,
  GatewayAccount,
  GatewayLogger,
  RefAttachmentSummary,
} from "./types.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";

// Re-export context type for consumers.
export type { CoreGatewayContext } from "./types.js";

// ============ startGateway ============

/**
 * Start the Gateway WebSocket connection with automatic reconnect support.
 */
export async function startGateway(ctx: CoreGatewayContext): Promise<void> {
  const { account, log, runtime } = ctx;

  // ---- 1. Register audio adapters ----
  registerAudioConvertAdapter({ convertSilkToWav, isVoiceAttachment, formatDuration });
  registerOutboundAudioAdapter({
    audioFileToSilkBase64: async (p, f) => (await audioFileToSilkBase64(p, f)) ?? undefined,
    isAudioFile,
    shouldTranscodeVoice,
    waitForFile,
  });

  // ---- 2. Validate ----
  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // ---- 3. Diagnostics ----
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // ---- 4. API config ----
  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport}`);

  // ---- 5. Outbound refIdx cache hook ----
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

  // ---- 6. Message handler ----
  const handleMessage = async (event: QueuedMessage): Promise<void> => {
    log?.info(
      `[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`,
    );

    runtime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "inbound",
    });

    const inbound = await buildInboundContext(event, {
      account,
      cfg: ctx.cfg,
      log,
      runtime,
      startTyping: (ev) => startTypingForEvent(ev, account, log),
    });

    try {
      await dispatchOutbound(inbound, { runtime, cfg: ctx.cfg, account, log });
    } catch (err) {
      log?.error(
        `[qqbot:${account.accountId}] Message processing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inbound.typing.keepAlive?.stop();
    }
  };

  // ---- 7. Start connection ----
  const connection = new GatewayConnection({
    account,
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    log,
    runtime,
    onReady: ctx.onReady,
    onError: ctx.onError,
    handleMessage,
  });

  await connection.start();
}

// ============ Typing helper ============

/**
 * Start typing indicator for a C2C event.
 * Returns the refIdx from InputNotify and a TypingKeepAlive handle.
 */
async function startTypingForEvent(
  event: QueuedMessage,
  account: GatewayAccount,
  log?: GatewayLogger,
): Promise<{ refIdx?: string; keepAlive: TypingKeepAlive | null }> {
  const isC2C = event.type === "c2c" || event.type === "dm";
  if (!isC2C) {
    return { keepAlive: null };
  }
  try {
    const creds = accountToCreds(account);
    const rawNotifyFn = createRawInputNotifyFn(account.appId);
    try {
      const resp = await senderSendInputNotify(
        event.senderId,
        creds,
        event.messageId,
        TYPING_INPUT_SECOND,
      );
      const keepAlive = new TypingKeepAlive(
        () => getAccessToken(account.appId, account.clientSecret),
        () => clearTokenCache(account.appId),
        rawNotifyFn,
        event.senderId,
        event.messageId,
        log,
        `[qqbot:${account.accountId}]`,
      );
      keepAlive.start();
      return { refIdx: resp.refIdx, keepAlive };
    } catch (notifyErr) {
      const errMsg = String(notifyErr);
      if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
        clearTokenCache(account.appId);
        const resp = await senderSendInputNotify(
          event.senderId,
          creds,
          event.messageId,
          TYPING_INPUT_SECOND,
        );
        const keepAlive = new TypingKeepAlive(
          () => getAccessToken(account.appId, account.clientSecret),
          () => clearTokenCache(account.appId),
          rawNotifyFn,
          event.senderId,
          event.messageId,
          log,
          `[qqbot:${account.accountId}]`,
        );
        keepAlive.start();
        return { refIdx: resp.refIdx, keepAlive };
      }
      throw notifyErr;
    }
  } catch (err) {
    log?.error(
      `[qqbot:${account.accountId}] sendInputNotify error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { keepAlive: null };
  }
}
