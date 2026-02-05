/**
 * DingTalk Channel Plugin for Clawdbot.
 */

import type {
  ChannelPlugin,
  ChannelCapabilities,
  ChannelMeta,
} from "openclaw/plugin-sdk";
import {
  type ResolvedDingTalkAccount,
  listDingTalkAccountIds,
  resolveDingTalkAccount,
  resolveDefaultDingTalkAccountId,
  isDingTalkAccountConfigured,
} from "./accounts.js";
import {
  DEFAULT_ACCOUNT_ID,
  DINGTALK_CHANNEL_ID,
  DINGTALK_LEGACY_CHANNEL_ID,
  DINGTALK_NPM_PACKAGE,
} from "./config-schema.js";
import { chunkMarkdownText } from "./send/chunker.js";
import { monitorDingTalkProvider } from "./monitor.js";
import { probeDingTalk } from "./probe.js";
import { sendProactiveMessage, sendImageMessage, sendActionCardMessage, sendMediaByPath } from "./api/send-message.js";
import { isLocalPath, isImageUrl } from "./api/media-upload.js";
import { getOrCreateTokenManager } from "./runtime.js";
import type { StreamLogger } from "./stream/types.js";
import type { DingTalkChannelData } from "./types/channel-data.js";

/**
 * Adapt clawdbot SubsystemLogger to StreamLogger interface.
 * Clawdbot uses (message, meta) order, our StreamLogger uses (obj, msg) order.
 */
function adaptLogger(log: { info?: (msg: string, meta?: unknown) => void; debug?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void; error?: (msg: string, meta?: unknown) => void } | undefined): StreamLogger | undefined {
  if (!log) {
    return undefined;
  }
  return {
    info: (obj, msg) => {
      const message = msg ?? (typeof obj === "string" ? obj : JSON.stringify(obj));
      log.info?.(message, typeof obj === "object" ? obj : undefined);
    },
    debug: (obj, msg) => {
      const message = msg ?? (typeof obj === "string" ? obj : JSON.stringify(obj));
      log.debug?.(message, typeof obj === "object" ? obj : undefined);
    },
    warn: (obj, msg) => {
      const message = msg ?? (typeof obj === "string" ? obj : JSON.stringify(obj));
      log.warn?.(message, typeof obj === "object" ? obj : undefined);
    },
    error: (obj, msg) => {
      const message = msg ?? (typeof obj === "string" ? obj : JSON.stringify(obj));
      log.error?.(message, typeof obj === "object" ? obj : undefined);
    },
  };
}

/**
 * Channel metadata.
 */
const meta: ChannelMeta = {
  id: DINGTALK_CHANNEL_ID,
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  blurb: "Enterprise messaging platform by Alibaba",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  order: 62,
  aliases: ["dingding", "钉钉", DINGTALK_NPM_PACKAGE, DINGTALK_LEGACY_CHANNEL_ID],
  systemImage: "message.fill",
};

/**
 * Channel capabilities.
 */
const capabilities: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  reactions: false,
  threads: false,
  media: true, // Supports image sending
  nativeCommands: false,
  blockStreaming: true, // Use block-based streaming for DingTalk
};

/**
 * DingTalk channel plugin.
 */
export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: DINGTALK_CHANNEL_ID,
  meta,
  capabilities,
  reload: { configPrefixes: [`channels.${DINGTALK_CHANNEL_ID}`] },

  // Config schema for Control UI
  configSchema: {
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        clientSecretFile: { type: "string" },
        replyMode: { type: "string", enum: ["text", "markdown"], default: "text" },
        maxChars: { type: "number", default: 1800 },
        tableMode: { type: "string", enum: ["off", "code"], default: "code" },
        responsePrefix: { type: "string" },
        requirePrefix: { type: "string" },
        requireMention: { type: "boolean", default: true },
        isolateContextPerUserInGroup: { type: "boolean", default: false },
        mentionBypassUsers: { type: "array", items: { type: "string" } },
        allowFrom: { type: "array", items: { type: "string" } },
        selfUserId: { type: "string" },
        apiBase: { type: "string" },
        openPath: { type: "string" },
        subscriptionsJson: { type: "string" },
      },
    },
    uiHints: {
      enabled: { label: "启用", help: "是否启用钉钉渠道" },
      clientId: { label: "Client ID", help: "钉钉机器人的 Client ID（AppKey）", placeholder: "dingo..." },
      clientSecret: { label: "Client Secret", help: "钉钉机器人的 Client Secret（AppSecret）", sensitive: true },
      clientSecretFile: { label: "Client Secret 文件", help: "包含 Client Secret 的文件路径（替代直接配置）", advanced: true },
      replyMode: { label: "回复模式", help: "消息格式：text（纯文本）或 markdown" },
      maxChars: { label: "最大字符数", help: "单条消息最大字符数（超出将分段发送）" },
      tableMode: { label: "表格模式", help: "Markdown 表格处理方式：off（保留）、code（转为代码块）", advanced: true },
      responsePrefix: { label: "回复前缀", help: "添加到回复开头的文本（支持 {model}/{provider}/{identity} 变量）", advanced: true },
      requirePrefix: { label: "触发前缀", help: "群聊中需要以此前缀开头才会响应", advanced: true },
      requireMention: { label: "需要@提及", help: "群聊中需要@机器人才会响应（默认启用）", advanced: true },
      isolateContextPerUserInGroup: {
        label: "群聊上下文隔离",
        help: "开启后，同一个群聊中不同用户与机器人对话将使用不同上下文（互不影响）",
        advanced: true,
      },
      mentionBypassUsers: { label: "@提及豁免用户", help: "无需@机器人即可触发的用户 ID 列表", advanced: true },
      allowFrom: { label: "允许发送者", help: "允许发送消息的用户 ID 列表（空表示允许所有）", advanced: true },
      selfUserId: { label: "机器人用户 ID", help: "机器人自身的用户 ID，用于过滤自己的消息", advanced: true },
      apiBase: { label: "API 基础 URL", help: "钉钉 API 基础地址（默认：https://api.dingtalk.com）", advanced: true },
      openPath: { label: "Open Path", help: "Stream 连接路径（默认：/v1.0/gateway/connections/open）", advanced: true },
      subscriptionsJson: { label: "订阅配置 JSON", help: "自定义订阅配置 JSON（高级用法）", advanced: true },
    },
  },

  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveDingTalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingTalkAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const dingtalk = (cfg.channels as Record<string, unknown>)?.[DINGTALK_CHANNEL_ID] as
        | Record<string, unknown>
        | undefined;
      if (!dingtalk) {
        return cfg;
      }

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [DINGTALK_CHANNEL_ID]: { ...dingtalk, enabled },
          },
        };
      }

      const accounts = (dingtalk.accounts ?? {}) as Record<string, unknown>;
      const account = (accounts[accountId] ?? {}) as Record<string, unknown>;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [DINGTALK_CHANNEL_ID]: {
            ...dingtalk,
            accounts: {
              ...accounts,
              [accountId]: { ...account, enabled },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const dingtalk = (cfg.channels as Record<string, unknown>)?.[DINGTALK_CHANNEL_ID] as
        | Record<string, unknown>
        | undefined;
      if (!dingtalk) {
        return cfg;
      }

      if (accountId === DEFAULT_ACCOUNT_ID) {
        // Clear base-level credentials
        const {
          clientId: _clientId,
          clientSecret: _clientSecret,
          clientSecretFile: _clientSecretFile,
          ...rest
        } = dingtalk;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [DINGTALK_CHANNEL_ID]: rest,
          },
        };
      }

      const accounts = { ...((dingtalk.accounts ?? {}) as Record<string, unknown>) };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [DINGTALK_CHANNEL_ID]: {
            ...dingtalk,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },

    isConfigured: (account) => isDingTalkAccountConfigured(account),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isDingTalkAccountConfigured(account),
      credentialSource: account.credentialSource,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      return account.allowFrom;
    },

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^dingtalk:/i, "")),
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1800,

    sendText: async ({ to, text, cfg, accountId }) => {
      // Resolve account configuration
      const account = resolveDingTalkAccount({ cfg, accountId });

      // Check if credentials are configured
      if (!isDingTalkAccountConfigured(account)) {
        return {
          channel: "dingtalk",
          ok: false,
          error: new Error(
            `DingTalk credentials not configured for account "${account.accountId}". ` +
            `Set channels.dingtalk.clientId and channels.dingtalk.clientSecret.`
          ),
          messageId: "",
        };
      }

      // Get or create token manager for this account
      const tokenManager = getOrCreateTokenManager(account);

      // Send proactive message using DingTalk API
      const result = await sendProactiveMessage({
        account,
        to,
        text,
        replyMode: account.replyMode,
        tokenManager,
      });

      return {
        channel: "dingtalk",
        ok: result.ok,
        messageId: result.processQueryKey || "",
        ...(result.error ? { error: result.error } : {}),
        ...(result.invalidUserIds?.length ? { meta: { invalidUserIds: result.invalidUserIds } } : {}),
      };
    },

    sendMedia: async ({ to, text, mediaUrl, cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });

      if (!isDingTalkAccountConfigured(account)) {
        return {
          channel: "dingtalk",
          ok: false,
          error: new Error(
            `DingTalk credentials not configured for account "${account.accountId}". ` +
            `Set channels.dingtalk.clientId and channels.dingtalk.clientSecret.`
          ),
          messageId: "",
        };
      }

      const tokenManager = getOrCreateTokenManager(account);

      // Check if mediaUrl is a local path or remote URL that needs special handling
      if (isLocalPath(mediaUrl)) {
        // Use sendMediaByPath for local files (handles upload automatically)
        const result = await sendMediaByPath({
          account,
          to,
          mediaUrl,
          text,
          tokenManager,
        });

        return {
          channel: "dingtalk",
          ok: result.ok,
          messageId: result.processQueryKey || "",
          ...(result.error ? { error: result.error } : {}),
        };
      }

      // Remote URL handling
      const isImage = isImageUrl(mediaUrl);

      if (isImage) {
        // Send as native image message
        const result = await sendImageMessage({
          account,
          to,
          picUrl: mediaUrl,
          text,
          tokenManager,
        });

        return {
          channel: "dingtalk",
          ok: result.ok,
          messageId: result.processQueryKey || "",
          ...(result.error ? { error: result.error } : {}),
        };
      }

      // For non-image remote files, use sendMediaByPath (handles download + upload)
      const result = await sendMediaByPath({
        account,
        to,
        mediaUrl,
        text,
        tokenManager,
      });

      return {
        channel: "dingtalk",
        ok: result.ok,
        messageId: result.processQueryKey || "",
        ...(result.error ? { error: result.error } : {}),
      };
    },

    sendPayload: async ({ to, payload, cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });

      if (!isDingTalkAccountConfigured(account)) {
        return {
          channel: "dingtalk",
          ok: false,
          error: new Error(
            `DingTalk credentials not configured for account "${account.accountId}". ` +
            `Set channels.dingtalk.clientId and channels.dingtalk.clientSecret.`
          ),
          messageId: "",
        };
      }

      const tokenManager = getOrCreateTokenManager(account);
      const channelData = payload.channelData?.dingtalk as DingTalkChannelData | undefined;

      // Handle ActionCard
      if (channelData?.actionCard) {
        const result = await sendActionCardMessage({
          account,
          to,
          actionCard: channelData.actionCard,
          tokenManager,
        });

        return {
          channel: "dingtalk",
          ok: result.ok,
          messageId: result.processQueryKey || "",
          ...(result.error ? { error: result.error } : {}),
        };
      }

      // Handle image
      if (channelData?.image?.picUrl) {
        const result = await sendImageMessage({
          account,
          to,
          picUrl: channelData.image.picUrl,
          text: payload.text,
          tokenManager,
        });

        return {
          channel: "dingtalk",
          ok: result.ok,
          messageId: result.processQueryKey || "",
          ...(result.error ? { error: result.error } : {}),
        };
      }

      // Fall back to text message
      if (payload.text) {
        const result = await sendProactiveMessage({
          account,
          to,
          text: payload.text,
          replyMode: account.replyMode,
          tokenManager,
        });

        return {
          channel: "dingtalk",
          ok: result.ok,
          messageId: result.processQueryKey || "",
          ...(result.error ? { error: result.error } : {}),
        };
      }

      return {
        channel: "dingtalk",
        ok: false,
        error: new Error("No content to send in payload"),
        messageId: "",
      };
    },
  },

  // Messaging adapter: target resolution for DingTalk user IDs
  messaging: {
    targetResolver: {
      hint: 'Use DingTalk senderStaffId (e.g., "manager9140") or full senderId.',
      // DingTalk user IDs: senderStaffId like "manager9140" or senderId like "$:LWCP_v1:$..."
      looksLikeId: (raw: string, _normalized: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        // Matches senderStaffId patterns: manager9140, user12345, etc.
        if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
          return true;
        }
        // Matches full senderId patterns: $:LWCP_v1:$...
        if (trimmed.startsWith("$:")) {
          return true;
        }
        return false;
      },
    },
  },

  // Groups adapter: @mention detection for group chats
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      // Only enforce mention requirement if:
      // 1. requireMention is enabled
      // 2. requirePrefix is not set (prefix takes precedence)
      return account.requireMention && !account.requirePrefix;
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    probeAccount: async ({ account, timeoutMs }) => {
      return probeDingTalk(account, timeoutMs);
    },

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isDingTalkAccountConfigured(account),
      credentialSource: account.credentialSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: "stream",
    }),

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? "stream",
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, abortSignal, log } = ctx;

      if (!isDingTalkAccountConfigured(account)) {
        throw new Error(
          `DingTalk credentials not configured for account "${account.accountId}". ` +
          `Set channels.dingtalk.clientId and channels.dingtalk.clientSecret.`
        );
      }

      log?.info?.(`[${account.accountId}] starting DingTalk stream provider`);

      return monitorDingTalkProvider({
        account,
        config: cfg,
        abortSignal,
        log: adaptLogger(log),
      });
    },
  },
};
