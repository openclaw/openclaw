import {
  type ChannelPlugin,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import type { ResolvedQQBotAccount } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
  resolveDefaultQQBotAccountId,
} from "./config.js";
import { startGateway } from "./gateway.js";
import { qqbotOnboardingAdapter } from "./onboarding.js";
import { sendText, sendMedia } from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";

/**
 * 简单的文本分块函数
 * 用于预先分块长文本
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // 尝试在换行处分割
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 没找到合适的换行，尝试在空格处分割
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 还是没找到，强制在 limit 处分割
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
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
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  // CLI onboarding wizard
  onboarding: qqbotOnboardingAdapter,
  // 消息目标解析
  messaging: {
    normalizeTarget: (target) => {
      // 支持格式: qqbot:c2c:xxx, qqbot:group:xxx, c2c:xxx, group:xxx, openid
      const normalized = target.replace(/^qqbot:/i, "");
      return { ok: true, to: normalized };
    },
    targetResolver: {
      looksLikeId: (id) => {
        // 先去掉 qqbot: 前缀
        const normalized = id.replace(/^qqbot:/i, "");
        // 支持 c2c:xxx, group:xxx, channel:xxx 格式
        if (
          normalized.startsWith("c2c:") ||
          normalized.startsWith("group:") ||
          normalized.startsWith("channel:")
        ) {
          return true;
        }
        // 支持纯 openid（32位十六进制）
        if (/^[A-F0-9]{32}$/i.test(normalized)) {
          return true;
        }
        return false;
      },
      hint: "c2c:<openid> or group:<groupOpenid>",
    },
  },
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
    isConfigured: (account) => Boolean(account?.appId && account?.clientSecret),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
    }),
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
        const parts = input.token.split(":");
        if (parts.length === 2) {
          appId = parts[0];
          clientSecret = parts[1];
        }
      }

      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
        imageServerBaseUrl: input.imageServerBaseUrl,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "markdown",
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const result = await sendMedia({
        to,
        text: text ?? "",
        mediaUrl: mediaUrl ?? "",
        accountId,
        replyToId,
        account,
      });
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[qqbot:${account.accountId}] Starting gateway`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
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
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({
      account,
      runtime,
    }: {
      account?: ResolvedQQBotAccount;
      runtime?: Record<string, unknown>;
    }) => ({
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
