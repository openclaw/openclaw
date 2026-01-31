import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
} from "../../../src/plugin-sdk/index.js";

// Import feishu functions directly from source
import {
  getStartupChatIds,
  listFeishuAccountIds,
  resolveFeishuAccount,
  resolveDefaultFeishuAccountId,
  type ResolvedFeishuAccount,
} from "../../../src/feishu/accounts.js";
import {
  sendMediaFeishu,
  sendMessageFeishu,
  type SendFeishuMessageParams,
} from "../../../src/feishu/send.js";
import { loadWebMedia } from "../../../src/web/media.js";
import { monitorFeishuProvider, type FeishuMessageContext } from "../../../src/feishu/monitor.js";
import { createFeishuClient } from "../../../src/feishu/client.js";
import { dispatchFeishuMessage } from "../../../src/feishu/message-dispatch.js";

const meta = getChatChannelMeta("feishu");

/**
 * Detect the appropriate receiveIdType from Feishu target ID prefix
 * - ou_xxx → open_id (user)
 * - oc_xxx → chat_id (group chat)
 * - on_xxx → union_id (cross-app user id)
 */
function detectFeishuReceiveIdType(
  target: string,
): SendFeishuMessageParams["receiveIdType"] {
  const trimmed = target.trim().toLowerCase();
  if (trimmed.startsWith("ou_")) return "open_id";
  if (trimmed.startsWith("on_")) return "union_id";
  // Default to chat_id for oc_ prefix or unknown formats
  return "chat_id";
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta: {
    ...meta,
    aliases: ["lark"],
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    reactions: true,
    media: true,
  },
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    isConfigured: (account) => account.credentials.source !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentials.source !== "none",
    }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentials.source !== "none",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      // Accept explicit channel prefixes like "feishu:oc_xxx" / "lark:ou_xxx"
      // and normalize them to the raw Feishu id.
      let value = String(raw ?? "").trim();
      value = value.replace(/^(feishu|lark):/i, "").trim();
      return value;
    },
    targetResolver: {
      hint: "Use ou_xxx (open_id), oc_xxx (chat_id), or on_xxx (union_id)",
      // Recognize Feishu ID patterns: ou_ (open_id), oc_ (chat_id), on_ (union_id)
      looksLikeId: (raw: string, normalized?: string) => {
        const trimmed = raw.trim();
        const normalizedTrimmed = normalized?.trim() ?? "";
        const re = /^(ou_|oc_|on_)[a-z0-9]+$/i;
        return re.test(trimmed) || re.test(normalizedTrimmed);
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg }) => {
      // Detect receiveIdType from target prefix
      const receiveIdType = detectFeishuReceiveIdType(to);
      const result = await sendMessageFeishu({
        to,
        text,
        accountId: accountId ?? undefined,
        config: cfg,
        receiveIdType,
        autoRichText: true, // Enable markdown rendering via interactive card
      });
      if (!result.success || !result.messageId) {
        throw new Error(result.error ?? "Failed to send Feishu message");
      }
      return { channel: "feishu" as const, messageId: result.messageId };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const receiveIdType = detectFeishuReceiveIdType(to);
      let lastMessageId: string | undefined;

      // Send text first if present
      if (text?.trim()) {
        const textResult = await sendMessageFeishu({
          to,
          text,
          accountId: accountId ?? undefined,
          config: cfg,
          receiveIdType,
          autoRichText: true,
        });
        if (!textResult.success) {
          throw new Error(textResult.error ?? "Failed to send Feishu text message");
        }
        lastMessageId = textResult.messageId;
      }

      // Send media if mediaUrl is provided
      if (mediaUrl) {
        const resolved = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
        const maxMb = resolved.config.mediaMaxMb ?? cfg.channels?.feishu?.mediaMaxMb ?? 20;
        const maxBytes = Math.max(1, maxMb) * 1024 * 1024;
        const media = await loadWebMedia(mediaUrl, maxBytes);
        if (media.buffer) {
          const kind =
            media.kind === "image"
              ? ("image" as const)
              : media.kind === "audio"
                ? ("audio" as const)
                : media.kind === "video"
                  ? ("video" as const)
                  : ("file" as const);

          const mediaResult = await sendMediaFeishu({
            to,
            buffer: media.buffer,
            contentType: media.contentType,
            fileName: media.fileName,
            kind,
            accountId: accountId ?? undefined,
            config: cfg,
            receiveIdType,
          });
          if (!mediaResult.success) {
            throw new Error(mediaResult.error ?? "Failed to send Feishu media");
          }
          lastMessageId = mediaResult.messageId;
        }
      }

      if (!lastMessageId) {
        throw new Error("No content to send");
      }
      return { channel: "feishu" as const, messageId: lastMessageId };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Feishu provider`);

      // Create client for startup message
      const client = createFeishuClient(account.credentials, {
        timeoutMs: (account.config.timeoutSeconds ?? 30) * 1000,
      });

      // Message handler that dispatches to the agent system
      const onMessage = async (msgCtx: FeishuMessageContext) => {
        await dispatchFeishuMessage({
          ctx: msgCtx,
          cfg: ctx.cfg,
          runtime: ctx.runtime,
          account,
        });
      };

      // Start the monitor with message handler
      const monitorPromise = monitorFeishuProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        onMessage,
      });

      // Send startup message to all configured startup chat IDs
      const startupChatIds = getStartupChatIds(account.config);
      const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      for (const chatId of startupChatIds) {
        try {
          await client.sendTextMessage(
            chatId,
            `🚀 Clawdbot 飞书网关已启动 (${timestamp})`,
            "chat_id",
          );
          ctx.log?.info(`[${account.accountId}] sent startup message to ${chatId}`);
        } catch (err) {
          ctx.log?.warn(`[${account.accountId}] failed to send startup message to ${chatId}: ${err}`);
        }
      }

      return monitorPromise;
    },
  },
};
