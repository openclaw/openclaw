/**
 * Channel Plugin for zalouser-free
 * Exports the channel plugin object matching OpenClaw SDK format
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { IncomingMessage } from "./types.js";
import { listAccountIds, resolveAccount, DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { zalouserFreeOnboardingAdapter } from "./onboarding.js";
import { getZalouserFreeRuntime, hasZalouserFreeRuntime } from "./runtime.js";
import { ZaloSessionManager } from "./session-manager.js";

// Shared session manager instance
let sharedSessionManager: ZaloSessionManager | null = null;

export function initSessionManager(sessionPath?: string, logger?: unknown): ZaloSessionManager {
  if (!sharedSessionManager) {
    sharedSessionManager = new ZaloSessionManager(sessionPath, logger);
  }
  return sharedSessionManager;
}

export function getSessionManager(): ZaloSessionManager | null {
  return sharedSessionManager;
}

/**
 * Process incoming message and dispatch to OpenClaw agent
 */
async function processMessage(
  msg: IncomingMessage,
  accountId: string,
  config: OpenClawConfig,
  logger: unknown,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = logger as any;
  if (!hasZalouserFreeRuntime()) {
    log.error?.("[zalouser-free] Runtime not initialized, cannot dispatch message");
    return;
  }

  const core = getZalouserFreeRuntime();
  const account = resolveAccount(config, accountId);
  const chatId = msg.threadId;
  const isGroup = msg.chatType === "group";
  const senderId = msg.senderId;
  const senderName = msg.senderName || "";
  const rawBody = msg.text?.trim() || "";

  if (!rawBody) {
    return;
  }

  // Build the conversation label
  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "zalouser-free",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: isGroup ? chatId : senderId,
    },
  });

  // Build session path
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Resolve envelope format options
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Format the message body for the agent
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo Personal (Free)",
    from: fromLabel,
    timestamp: msg.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build context payload
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `zalouser-free:group:${chatId}` : `zalouser-free:${senderId}`,
    To: `zalouser-free:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: "zalouser-free",
    Surface: "zalouser-free",
    MessageSid: msg.messageId,
    OriginatingChannel: "zalouser-free",
    OriginatingTo: `zalouser-free:${chatId}`,
    CommandAuthorized: true, // Allow commands from whitelisted users
  });

  // Record inbound session
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log.error?.(`[zalouser-free] Failed updating session meta: ${String(err)}`);
    },
  });

  // Dispatch reply
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const textPayload = payload as { text?: string };
        const text = textPayload.text ?? "";

        if (text && sharedSessionManager) {
          const sendResult = await sharedSessionManager.sendText(
            accountId,
            chatId,
            isGroup ? "group" : "direct",
            text,
          );
          if (!sendResult.ok) {
            log.error?.(`[zalouser-free] Failed to send reply: ${sendResult.error}`);
          }
        }
      },
      onError: (err, info) => {
        log.error?.(`[zalouser-free] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

export function createChannelPlugin(sessionManager: ZaloSessionManager, api: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (api as any).logger || console;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (api as any).config as OpenClawConfig;

  // Set config provider for access control
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionManager.setConfigProvider(() => (api as any).config);

  // Message dispatch handler - uses PluginRuntime for proper dispatch
  sessionManager.setMessageHandler((msg, accountId) => {
    logger.info?.(`[zalouser-free] Processing message via PluginRuntime`);
    processMessage(msg, accountId, config, logger).catch((err) => {
      logger.error?.(`[zalouser-free] Failed to process message: ${String(err)}`);
    });
  });

  return {
    id: "zalouser-free",
    meta: {
      id: "zalouser-free",
      label: "Zalo Personal (Free)",
      selectionLabel: "Zalo (Free, Personal Zalo, zca-js)",
      docsPath: "/channels/zalouser-free",
      blurb: "Free Zalo Personal messaging using zca-js library. No API costs.",
      aliases: ["zalo-free", "zfree"],
      order: 86,
    },

    onboarding: zalouserFreeOnboardingAdapter,

    capabilities: {
      chatTypes: ["direct", "group"] as const,
      media: true,
      blockStreaming: true,
      typing: true,
      markRead: true,
    },

    config: {
      listAccountIds: (cfg: unknown): string[] => listAccountIds(cfg),
      resolveAccount: (cfg: unknown, accountId?: string) => resolveAccount(cfg, accountId),
    },

    outbound: {
      deliveryMode: "direct" as const,
      textChunkLimit: 2000,

      sendText: async (params: {
        to: string;
        text: string;
        accountId?: string;
        cfg?: unknown;
      }): Promise<{ channel: string; ok: boolean; messageId?: string; error?: Error }> => {
        const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
        const chatType = sessionManager.getChatType(params.to);
        const result = await sessionManager.sendText(accountId, params.to, chatType, params.text);
        return {
          channel: "zalouser-free",
          ok: result.ok,
          messageId: result.messageId ?? "",
          error: result.error ? new Error(result.error) : undefined,
        };
      },

      sendMedia: async (params: {
        to: string;
        mediaUrl: string;
        text?: string;
        accountId?: string;
        cfg?: unknown;
      }): Promise<{ channel: string; ok: boolean; messageId?: string; error?: Error }> => {
        const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
        const chatType = sessionManager.getChatType(params.to);
        const caption = params.text || "";
        const result = await sessionManager.sendFile(
          accountId,
          params.to,
          chatType,
          caption,
          params.mediaUrl,
        );
        return {
          channel: "zalouser-free",
          ok: result.ok,
          messageId: result.messageId ?? "",
          error: result.error ? new Error(result.error) : undefined,
        };
      },

      sendTyping: async (params: {
        to: string;
        accountId?: string;
      }): Promise<{ ok: boolean; error?: Error }> => {
        const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
        const chatType = sessionManager.getChatType(params.to);
        const result = await sessionManager.sendTypingEvent(accountId, params.to, chatType);
        if (!result.ok) {
          return { ok: false, error: new Error(result.error) };
        }
        return { ok: true };
      },

      markRead: async (params: {
        to: string;
        messageId?: string;
        accountId?: string;
      }): Promise<{ ok: boolean; error?: Error }> => {
        const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
        const chatType = sessionManager.getChatType(params.to);
        if (params.messageId) {
          const result = await sessionManager.sendSeenEvent(
            accountId,
            params.to,
            [params.messageId],
            chatType,
          );
          if (!result.ok) {
            return { ok: false, error: new Error(result.error) };
          }
        }
        return { ok: true };
      },
    },

    gateway: {
      startAccount: async (ctx: unknown): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accountId = (ctx as any).accountId ?? DEFAULT_ACCOUNT_ID;

        if (sessionManager.hasSavedCredentials(accountId)) {
          const result = await sessionManager.restoreSession(accountId);
          if (result.ok) {
            await sessionManager.startListening(accountId);
            logger.info?.(`[zalouser-free] Account ${accountId} started successfully`);
            return;
          }
          logger.warn?.(
            `[zalouser-free] Could not restore session for ${accountId}: ${result.error}`,
          );
        } else {
          logger.warn?.(
            `[zalouser-free] No saved credentials for ${accountId}. Run: openclaw zalouser-free login`,
          );
        }
      },

      stopAccount: async (ctx: unknown): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accountId = (ctx as any).accountId ?? DEFAULT_ACCOUNT_ID;
        await sessionManager.disconnect(accountId);
        logger.info?.(`[zalouser-free] Account ${accountId} stopped`);
      },
    },

    status: {
      getAccountStatus: (accountId: string) => sessionManager.getStatus(accountId),
    },
  };
}
