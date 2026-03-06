import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TypeXClient } from "./client.js";
import { getTypeXRuntime } from "./runtime.js";
import { sendMessageTypeX } from "./send.js";
import { TypeXMessageEnum, type TypeXMessageEntry } from "./types.js";

export type ProcessTypeXMessageOptions = {
  /** Full OpenClaw gateway config (needed for bindings/routing). */
  cfg?: OpenClawConfig;
  accountId?: string;
  botName?: string;
  typexCfg?: Record<string, any>;
  logger?:
    | { warn: (msg: string) => void; info: (msg: string) => void; error: (msg: string) => void }
    | undefined;
};

export async function processTypeXMessage(
  client: TypeXClient,
  payload: TypeXMessageEntry,
  appId: string,
  options: ProcessTypeXMessageOptions = {},
) {
  // Use the full OpenClaw config for routing/bindings + dispatch.
  // (typexCfg is only the channel-specific config.)
  const cfg = options.cfg;
  const accountId = options.accountId ?? appId;
  const logger = options.logger;
  const runtime = getTypeXRuntime();
  const channel = (runtime as Record<string, unknown>).channel as
    | {
        reply?: {
          dispatchReplyWithBufferedBlockDispatcher?: (opts: unknown) => Promise<unknown>;
        };
        routing?: {
          resolveAgentRoute?: (input: unknown) => any;
        };
      }
    | undefined;
  if (!channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    logger?.error(`[typex:${accountId}] dispatchReplyWithBufferedBlockDispatcher not available`);
    return;
  }

  if (!payload || !payload.chat_id) {
    logger?.warn("Received invalid event payload");
    return;
  }

  const chatId = payload.chat_id;
  const senderId = payload.sender_id;
  // Use content as text for now. If content is JSON string, parse it.
  let text = payload.content.text;
  // Attempt simple parsing if it looks like JSON? For now assume plain text or handle in future.

  // Basic logging
  logger?.info(`Processing TypeX message from ${senderId} in ${chatId}`);

  // Build Context for Agent
  const ctx = {
    Body: text,
    RawBody: text,
    From: senderId,
    To: chatId,
    SenderId: senderId,
    SenderName: payload.sender_name || "User",
    ChatType: "dm", // Simplified, TypeX mostly DM for now?
    Provider: "typex",
    Surface: "typex",
    Timestamp: payload.create_time || Date.now(),
    MessageSid: payload.message_id,
    AccountId: accountId,
    OriginatingChannel: "typex",
    OriginatingTo: chatId,
  };

  if (!cfg) {
    logger?.error(`[typex:${accountId}] missing full OpenClaw cfg; cannot route/bind.`);
    return;
  }

  // Resolve agent route (bindings) and stamp SessionKey so the message runs in the right agent lane.
  try {
    const routing = channel.routing;
    const route = routing?.resolveAgentRoute?.({
      cfg,
      channel: "typex",
      accountId,
      peer: { kind: "direct", id: String(chatId) },
    });
    if (route?.sessionKey) {
      (ctx as any).SessionKey = route.sessionKey;
      logger?.info(
        `[typex:${accountId}] resolved route: agentId=${route.agentId} matchedBy=${route.matchedBy} sessionKey=${route.sessionKey}`,
      );
    }
  } catch (e: any) {
    logger?.error(`[typex:${accountId}] resolveAgentRoute failed: ${e?.message || String(e)}`);
  }

  // Dispatch to Agent
  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      channel: "typex",
      accountId,
      deliver: async (payload: unknown) => {
        const responsePayload = payload as {
          text?: string;
          mediaUrls?: string[];
          mediaUrl?: string;
        };
        // Handle text response
        if (responsePayload.text) {
          await sendMessageTypeX(client, chatId, responsePayload.text, {
            msgType: TypeXMessageEnum.richText,
          });
        }

        // Handle media if present in response
        const mediaUrls = responsePayload.mediaUrls?.length
          ? responsePayload.mediaUrls
          : responsePayload.mediaUrl
            ? [responsePayload.mediaUrl]
            : [];

        for (const mediaUrl of mediaUrls) {
          await sendMessageTypeX(
            client,
            chatId,
            {},
            { mediaUrl, msgType: TypeXMessageEnum.richText },
          );
        }
      },
      onError: (err: Error) => {
        logger?.error(`Reply dispatch error: ${err.message}`);
      },
    },
    replyOptions: {
      disableBlockStreaming: true,
      // Do not use embedded agent; let gateway bindings decide the agent.
      embedded: false,
    },
  });
}
