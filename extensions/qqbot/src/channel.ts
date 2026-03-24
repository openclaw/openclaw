import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { initApiConfig } from "./api.js";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
  resolveDefaultQQBotAccountId,
} from "./config.js";
import {
  saveCredentialBackup,
  loadCredentialBackup,
  clearCredentialBackup,
} from "./credential-backup.js";
import { startGateway } from "./gateway.js";
import { sendText, sendMedia } from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";
import { qqbotSetupWizard } from "./setup-surface.js";
import type { ResolvedQQBotAccount } from "./types.js";

/** QQ Bot 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

/**
 * Markdown 感知的文本分块函数
 * 委托给 SDK 内置的 channel.text.chunkMarkdownText
 * 支持代码块自动关闭/重开、括号感知等
 */
export function chunkText(text: string, limit: number): string[] {
  const runtime = getQQBotRuntime();
  return runtime.channel.text.chunkMarkdownText(text, limit);
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  setupWizard: qqbotSetupWizard,
  meta: {
    id: "qqbot",
    label: "QQ Bot",
    selectionLabel: "QQ Bot",
    docsPath: "/docs/channels/qqbot",
    blurb: "Connect to QQ via official QQ Bot API",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * blockStreaming: true 表示该 Channel 支持块流式
     * 框架会收集流式响应，然后通过 deliver 回调发送
     */
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },

  config: {
    listAccountIds: (cfg) => listQQBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQBotAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultQQBotAccountId(cfg),
    // 新增：设置账户启用状态
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    // 新增：删除账户
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) => {
      if (account?.appId && account?.clientSecret) return true;
      // 配置为空但有凭证备份时仍返回 true，让 startAccount 有机会恢复凭证
      const backup = loadCredentialBackup(account?.accountId);
      return backup !== null;
    },
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
    }),
    // 关键：解析 allowFrom 配置，用于命令授权
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const allowFrom = account.config?.allowFrom;
      return allowFrom;
    },
    // 格式化 allowFrom 条目（移除 qqbot: 前缀，统一大写）
    formatAllowFrom: ({ allowFrom }) =>
      (allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^qqbot:/i, ""))
        .map((entry) => entry.toUpperCase()), // QQ openid 是大写的
  },
  setup: {
    // 新增：规范化账户 ID
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    // 新增：应用账户名称
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qqbot",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "QQBot requires --token (format: appId:clientSecret) or --use-env";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let clientSecret = "";

      if (input.token) {
        const colonIdx = input.token.indexOf(":");
        if (colonIdx > 0) {
          appId = input.token.slice(0, colonIdx);
          clientSecret = input.token.slice(colonIdx + 1);
        }
      }

      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
      });
    },
  },
  // Messaging 配置：用于解析目标地址
  messaging: {
    /**
     * 规范化目标地址
     * 支持以下格式：
     * - qqbot:c2c:openid -> 私聊
     * - qqbot:group:groupid -> 群聊
     * - qqbot:channel:channelid -> 频道
     * - c2c:openid -> 私聊
     * - group:groupid -> 群聊
     * - channel:channelid -> 频道
     * - 纯 openid（32位十六进制）-> 私聊
     */
    normalizeTarget: (target: string): string | undefined => {
      // 去掉 qqbot: 前缀（如果有）
      const id = target.replace(/^qqbot:/i, "");

      // 检查是否是已知格式
      if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
        return `qqbot:${id}`;
      }

      // 检查是否是纯 openid（32位十六进制，不带连字符）
      // QQ Bot OpenID 格式类似: 207A5B8339D01F6582911C014668B77B
      const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
      if (openIdHexPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }

      // 检查是否是 UUID 格式的 openid（带连字符）
      const openIdUuidPattern =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (openIdUuidPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }

      // 不认识的格式，返回 undefined 让核心使用原始值
      return undefined;
    },
    /**
     * 目标解析器配置
     * 用于判断一个目标 ID 是否看起来像 QQ Bot 的格式
     */
    targetResolver: {
      /**
       * 判断目标 ID 是否可能是 QQ Bot 格式
       * 支持以下格式：
       * - qqbot:c2c:xxx
       * - qqbot:group:xxx
       * - qqbot:channel:xxx
       * - c2c:xxx
       * - group:xxx
       * - channel:xxx
       * - UUID 格式的 openid
       */
      looksLikeId: (id: string): boolean => {
        // 带 qqbot: 前缀的格式
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 不带前缀但有类型标识
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 32位十六进制 openid（不带连字符）
        if (/^[0-9a-fA-F]{32}$/.test(id)) {
          return true;
        }
        // UUID 格式的 openid（带连字符）
        const openIdPattern =
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
      hint: "QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendMedia({
        to,
        text: text ?? "",
        mediaUrl: mediaUrl ?? "",
        accountId,
        replyToId,
        account,
      });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      let { account } = ctx;
      const { abortSignal, log, cfg } = ctx;

      // 凭证恢复：如果 appId/secret 为空（热更新打断可能导致配置丢失），尝试从暂存文件恢复
      if (!account.appId || !account.clientSecret) {
        const backup = loadCredentialBackup(account.accountId);
        if (backup) {
          log?.info(
            `[qqbot:${account.accountId}] 配置中凭证为空，从暂存文件恢复 (appId=${backup.appId}, savedAt=${backup.savedAt})`,
          );
          try {
            const runtime = getQQBotRuntime();
            const restoredCfg = applyQQBotAccountConfig(cfg, account.accountId, {
              appId: backup.appId,
              clientSecret: backup.clientSecret,
            });
            const configApi = runtime.config as {
              writeConfigFile: (cfg: unknown) => Promise<void>;
            };
            await configApi.writeConfigFile(restoredCfg);
            // 重新解析 account 以获取恢复后的值
            account = resolveQQBotAccount(restoredCfg, account.accountId);
            log?.info(`[qqbot:${account.accountId}] 凭证已恢复`);
          } catch (e) {
            log?.error(`[qqbot:${account.accountId}] 凭证恢复失败: ${e}`);
          }
        }
      }

      log?.info(
        `[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`,
      );

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          // 启动成功，保存凭证快照供后续恢复使用
          saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    // 新增：登出账户（清除配置中的凭证）
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
          delete qqbot.clientSecret;
          cleared = true;
          changed = true;
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as {
          writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
        };
        await configApi.writeConfigFile(nextCfg);
      }

      // 登出时清除凭证备份，防止 startAccount 从备份中恢复已清除的凭证
      if (cleared) {
        clearCredentialBackup();
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    // 新增：构建通道摘要
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
