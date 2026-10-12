import type { WAMessageKey, WASocket } from "baileys";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { createSubsystemLogger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createWaSocket, waitForWaConnection } from "../session.js";
import { resolveWhatsAppSocketTiming, type WhatsAppSocketTimingOptions } from "../socket-timing.js";
import {
  readWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
  type WhatsAppBaileysMessageCache,
} from "./baileys-cache.js";
import {
  createWhatsAppGroupMetadataCacheOwner,
  type WhatsAppGroupMetadataCache,
} from "./group-metadata-cache.js";
import { closeInboundMonitorSocket, holdInboundUntilIntake, takeHeldInbound } from "./lifecycle.js";
import { createWhatsAppMessageDeliveryCoordinator } from "./message-delivery.js";
import { createWebSendApi } from "./send-api.js";
import { createWhatsAppAttachedSocketSession } from "./socket-session.js";

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (enabled) {
    defaultRuntime.log(message);
  }
}

type MonitorWebInboxOptions = Omit<
  Parameters<typeof createWhatsAppMessageDeliveryCoordinator>[0],
  "sock" | "socketSession" | "groupMetadata"
> &
  Omit<
    Parameters<typeof createWhatsAppAttachedSocketSession>[0],
    "sock" | "socketTiming" | "logVerbose" | "logConnectionError"
  > & {
    socketTiming?: Required<WhatsAppSocketTimingOptions>;
    /** Shared group metadata cache used only for inbound metadata fallback after fetch failures. */
    groupMetadataCache?: WhatsAppGroupMetadataCache;
    baileysGroupMetaCache?: WhatsAppBaileysGroupMetadataCache;
  };

type AttachWebInboxToSocketOptions = MonitorWebInboxOptions & {
  socketTiming: Required<WhatsAppSocketTimingOptions>;
};

export async function attachWebInboxToSocket(
  options: AttachWebInboxToSocketOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const socketSession = await createWhatsAppAttachedSocketSession({
    ...options,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    logConnectionError: (error) => {
      inboundLogger.error({ error: String(error) }, "connection.update handler error");
    },
  });
  const groupMetadata = createWhatsAppGroupMetadataCacheOwner({
    sock: options.sock,
    getCurrentSock: socketSession.getCurrentSock,
    resolveInboundJid: socketSession.resolveInboundJid,
    reconnectCache: options.groupMetadataCache,
    baileysCache: options.baileysGroupMetaCache,
    listen: socketSession.listen,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    logHydrationWarning: (error) => {
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
    },
  });
  const delivery = createWhatsAppMessageDeliveryCoordinator({
    ...options,
    socketSession,
    groupMetadata,
  });
  const sendApi = createWebSendApi({
    sock: socketSession.socketOperations,
    defaultAccountId: options.accountId,
    resolveOutboundMentions: ({ jid, text }) => groupMetadata.resolveOutboundMentions(jid, text),
    authDir: options.authDir,
  });

  delivery.start();
  socketSession.start();
  groupMetadata.start();

  return {
    close: async () => {
      delivery.stopIntake();
      socketSession.stop();
      groupMetadata.close();
      try {
        await delivery.drain();
      } catch (error) {
        logWhatsAppVerbose(options.verbose, `Inbound close drain failed: ${String(error)}`);
      } finally {
        socketSession.closeSocket();
      }
    },
    onClose: socketSession.onClose,
    signalClose: socketSession.signalClose,
    assertSendReady: socketSession.assertSendReady,
    sendComposingTo: sendApi.sendComposingTo,
    sendMessage: sendApi.sendMessage,
    sendPoll: sendApi.sendPoll,
    sendReaction: sendApi.sendReaction,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const socketTiming = options.socketTiming ?? resolveWhatsAppSocketTiming();
  const recentMessageKeys: WhatsAppBaileysMessageCache = options.recentMessageKeys ?? new Map();
  const baileysGroupMetaCache: WhatsAppBaileysGroupMetadataCache =
    options.baileysGroupMetaCache ?? new Map();

  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    ...socketTiming,
    getMessage: async (key: WAMessageKey) =>
      key.id && key.remoteJid
        ? readWhatsAppBaileysCacheEntry(recentMessageKeys, `${key.remoteJid}:${key.id}`)
        : undefined,
    cachedGroupMetadata: async (jid: string) => {
      const meta = readWhatsAppBaileysCacheEntry(baileysGroupMetaCache, jid);
      return meta?.participants?.length ? meta : undefined;
    },
  });
  holdInboundUntilIntake(sock);
  try {
    await waitForWaConnection(sock, { timeoutMs: socketTiming.connectTimeoutMs });
  } catch (error) {
    closeInboundMonitorSocket(sock);
    throw error;
  }
  try {
    return await attachWebInboxToSocket({
      ...options,
      socketTiming,
      sock,
      recentMessageKeys,
      baileysGroupMetaCache,
    });
  } catch (error) {
    takeHeldInbound(sock);
    throw error;
  }
}
