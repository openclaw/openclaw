/**
 * WebSocket-based monitor for Feishu events using long connection mode.
 * Uses the official @larksuiteoapi/node-sdk WSClient for receiving events
 * via WebSocket - no public IP or webhook setup needed.
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode
 */

import * as Lark from "@larksuiteoapi/node-sdk";

import type { ClawdbotConfig, MarkdownTableMode } from "clawdbot/plugin-sdk";

import type {
  FeishuMessageEvent,
  FeishuReceiveIdType,
  ResolvedFeishuAccount,
} from "./types.js";
import { sendMessage } from "./api.js";
import { getFeishuRuntime } from "./runtime.js";

export type FeishuRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type FeishuMonitorOptions = {
  account: ResolvedFeishuAccount;
  config: ClawdbotConfig;
  runtime: FeishuRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type FeishuMonitorResult = {
  stop: () => void;
};

// Feishu card markdown content limit (slightly lower than text to account for JSON overhead)
const FEISHU_CARD_CONTENT_LIMIT = 3800;
const DEFAULT_MEDIA_MAX_MB = 20;

/**
 * Build a Feishu interactive card with markdown content.
 * Card messages support rich markdown formatting in Feishu.
 */
function buildMarkdownCard(content: string): string {
  const card = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
  return JSON.stringify(card);
}

type FeishuCoreRuntime = ReturnType<typeof getFeishuRuntime>;

function logVerbose(core: FeishuCoreRuntime, runtime: FeishuRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[feishu] ${message}`);
  }
}

type FeishuReplyTarget = {
  id: string;
  type: FeishuReceiveIdType;
};

function resolveSenderTarget(event: FeishuMessageEvent): FeishuReplyTarget | null {
  const senderId = event.sender.sender_id;
  if (senderId.open_id) return { id: senderId.open_id, type: "open_id" };
  if (senderId.user_id) return { id: senderId.user_id, type: "user_id" };
  if (senderId.union_id) return { id: senderId.union_id, type: "union_id" };
  return null;
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(feishu|lark|fs):/i, "");
    return normalized === normalizedSenderId;
  });
}

/**
 * Process a message event from Feishu WebSocket.
 */
async function processMessageEvent(
  event: FeishuMessageEvent,
  account: ResolvedFeishuAccount,
  config: ClawdbotConfig,
  runtime: FeishuRuntimeEnv,
  core: FeishuCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const { sender, message } = event;

  // Parse message content
  let textContent = "";
  try {
    const content = JSON.parse(message.content);
    textContent = content.text ?? "";
  } catch {
    // Ignore parse errors
  }

  if (!textContent.trim()) return;

  const isGroup = message.chat_type === "group";
  const chatId = message.chat_id;
  const senderTarget = resolveSenderTarget(event);
  if (!senderTarget) {
    logVerbose(core, runtime, "unable to resolve sender id for feishu message");
    return;
  }
  const senderId = senderTarget.id;
  const senderName = sender.sender_type === "user" ? "User" : sender.sender_type;
  const messageId = message.message_id;
  const replyTarget: FeishuReplyTarget = isGroup
    ? { id: chatId, type: "chat_id" }
    : senderTarget;
  runtime.log?.(
    `[feishu] inbound message id=${messageId} chat=${message.chat_type} sender=${senderId}`,
  );

  // Check DM policy
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = account.config.allowFrom ?? [];
  const rawBody = textContent.trim();
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("feishu").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands }],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked feishu DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "feishu",
            id: senderId,
            meta: { name: senderName ?? undefined },
          });

          if (created) {
            logVerbose(core, runtime, `feishu pairing request sender=${senderId}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: "feishu",
                idLine: `Your Feishu user id: ${senderId}`,
                code,
              });
              await sendMessage(
                account.appId,
                account.appSecret,
                {
                  receive_id: senderId,
                  msg_type: "text",
                  content: JSON.stringify({ text: pairingReply }),
                },
                senderTarget.type,
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `feishu pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized feishu sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  // Check group policy
  if (isGroup) {
    const groupPolicy = account.config.groupPolicy ?? "allowlist";
    const groupAllowFrom = account.config.groupAllowFrom ?? [];
    const groupConfig = account.config.groups?.[chatId];

    if (groupPolicy === "allowlist") {
      const groupAllowed = groupAllowFrom.includes("*") || groupAllowFrom.includes(chatId);
      const groupEnabled = groupConfig?.enabled !== false;
      if (!groupAllowed && !groupEnabled) {
        logVerbose(core, runtime, `Blocked feishu group ${chatId} (not in allowlist)`);
        return;
      }
    }

    // Check if mention is required
    const requireMention = groupConfig?.requireMention !== false;
    if (requireMention) {
      const hasMention = message.mentions?.some(
        (m) => m.id.open_id === account.appId || m.name === "@_all",
      );
      if (!hasMention) {
        logVerbose(core, runtime, `Ignored feishu group message (no mention)`);
        return;
      }
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `feishu: drop control command from unauthorized sender ${senderId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: fromLabel,
    timestamp: message.create_time ? parseInt(message.create_time, 10) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `feishu:group:${chatId}` : `feishu:${senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: messageId,
    OriginatingChannel: "feishu",
    OriginatingTo: `feishu:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`feishu: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverFeishuReply({
          payload,
          account,
          receiveId: replyTarget.id,
          receiveIdType: replyTarget.type,
          runtime,
          core,
          config,
          statusSink,
          tableMode,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

async function deliverFeishuReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedFeishuAccount;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  runtime: FeishuRuntimeEnv;
  core: FeishuCoreRuntime;
  config: ClawdbotConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, account, receiveId, receiveIdType, runtime, core, config, statusSink } = params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "feishu", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      FEISHU_CARD_CONTENT_LIMIT,
      chunkMode,
    );
    for (const chunk of chunks) {
      try {
        // Send as interactive card message with markdown support
        await sendMessage(
          account.appId,
          account.appSecret,
          {
            receive_id: receiveId,
            msg_type: "interactive",
            content: buildMarkdownCard(chunk),
          },
          receiveIdType,
        );
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`[feishu] message send failed: ${String(err)}`);
      }
    }
  }
}

/**
 * Start monitoring Feishu events using WebSocket long connection.
 */
export async function monitorFeishuProvider(
  options: FeishuMonitorOptions,
): Promise<FeishuMonitorResult> {
  const { account, config, runtime, abortSignal, statusSink } = options;

  const core = getFeishuRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;

  let stopped = false;
  let wsClient: Lark.WSClient | null = null;

  const stop = () => {
    stopped = true;
    if (wsClient) {
      wsClient = null;
    }
  };

  // Create WebSocket client for receiving events
  wsClient = new Lark.WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  // Create event dispatcher with message handler
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      if (stopped) return;

      statusSink?.({ lastInboundAt: Date.now() });

      // Convert SDK event data to our internal type
      const event: FeishuMessageEvent = {
        sender: data.sender as FeishuMessageEvent["sender"],
        message: data.message as FeishuMessageEvent["message"],
      };

      try {
        await processMessageEvent(
          event,
          account,
          config,
          runtime,
          core,
          effectiveMediaMaxMb,
          statusSink,
        );
      } catch (err) {
        runtime.error?.(`[${account.accountId}] Feishu event handler failed: ${String(err)}`);
      }
    },
  });

  // Start WebSocket connection
  wsClient.start({
    eventDispatcher,
  });

  runtime.log?.(
    `[feishu] WebSocket connection started for account=${account.accountId}`,
  );

  abortSignal.addEventListener("abort", stop, { once: true });

  return { stop };
}
