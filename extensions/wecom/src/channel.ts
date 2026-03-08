import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { CHANNEL_ID, TEXT_CHUNK_LIMIT } from "./const.ts";
import { monitorWeComProvider } from "./monitor.ts";
import { wecomOnboardingAdapter } from "./onboarding.ts";
import { getWeComRuntime } from "./runtime.ts";
import { getWeComWebSocket } from "./state-manager.ts";
import type { WeComConfig, ResolvedWeComAccount } from "./utils.ts";
import { resolveWeComAccount } from "./utils.ts";

/**
 * 使用 SDK 的 sendMessage 主动发送企业微信消息
 * 无需依赖 reqId，直接向指定会话推送消息
 */
async function sendWeComMessage({
  to,
  content,
  accountId,
}: {
  to: string;
  content: string;
  accountId?: string;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;

  // 从 to 中提取 chatId（格式是 "${CHANNEL_ID}:chatId" 或直接是 chatId）
  const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
  const chatId = to.replace(channelPrefix, "");

  console.log(`[WeCom] sendWeComMessage: ${JSON.stringify({ to, content, accountId })}`);

  // 获取 WSClient 实例
  const wsClient = getWeComWebSocket(resolvedAccountId);
  if (!wsClient || !wsClient.isConnected) {
    throw new Error(`WSClient not connected for account ${resolvedAccountId}`);
  }

  // 使用 SDK 的 sendMessage 主动发送 markdown 消息
  const result = await wsClient.sendMessage(chatId, {
    msgtype: "markdown",
    markdown: { content },
  });

  const messageId = result?.headers?.req_id ?? `wecom-${Date.now()}`;
  console.log(`[WeCom] Sent message to ${chatId}, messageId=${messageId}`);

  return {
    channel: CHANNEL_ID,
    messageId,
    chatId,
  };
}

// 企业微信频道元数据
const meta = {
  id: CHANNEL_ID,
  label: "企业微信",
  selectionLabel: "企业微信 (WeCom)",
  detailLabel: "企业微信智能机器人",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb: "企业微信智能机器人接入插件",
  systemImage: "message.fill",
};
export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: CHANNEL_ID,
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) =>
      entry.replace(new RegExp(`^(${CHANNEL_ID}|user):`, "i"), "").trim(),
    notifyApproval: async ({ cfg, id }) => {
      // 企业微信机器人不支持主动发送消息，只能在用户下次发消息时通知
      // 这里暂时不实现，因为需要有 reqId 才能回复
      console.log(`[WeCom] Pairing approved for user: ${id}`);
    },
  },
  onboarding: wecomOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    // 列出所有账户 ID（最小实现只支持默认账户）
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],

    // 解析账户配置
    resolveAccount: (cfg) => resolveWeComAccount(cfg),

    // 获取默认账户 ID
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    // 设置账户启用状态
    setAccountEnabled: ({ cfg, enabled }) => {
      const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...wecomConfig,
            enabled,
          },
        },
      };
    },

    // 删除账户
    deleteAccount: ({ cfg }) => {
      const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
      const { botId, secret, ...rest } = wecomConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: rest,
        },
      };
    },

    // 检查是否已配置
    isConfigured: (account) => Boolean(account.botId?.trim() && account.secret?.trim()),

    // 描述账户信息
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botId?.trim() && account.secret?.trim()),
      botId: account.botId,
      websocketUrl: account.websocketUrl,
    }),

    // 解析允许来源列表
    resolveAllowFrom: ({ cfg }) => {
      const account = resolveWeComAccount(cfg);
      return (account.config.allowFrom ?? []).map((entry) => String(entry));
    },

    // 格式化允许来源列表
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      const basePath = `channels.${CHANNEL_ID}.`;
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: (raw) => raw.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim(),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];

      // DM 策略警告
      const dmPolicy = account.config.dmPolicy ?? "pairing";
      if (dmPolicy === "open") {
        const hasWildcard = (account.config.allowFrom ?? []).some(
          (entry) => String(entry).trim() === "*",
        );
        if (!hasWildcard) {
          warnings.push(
            `- 企业微信私信：dmPolicy="open" 但 allowFrom 未包含 "*"。任何人都可以发消息，但允许列表为空可能导致意外行为。建议设置 channels.${CHANNEL_ID}.allowFrom=["*"] 或使用 dmPolicy="pairing"。`,
          );
        }
      }

      // 群组策略警告
      const defaultGroupPolicy = resolveDefaultGroupPolicy({} as OpenClawConfig);
      const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
        providerConfigPresent: true,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy === "open") {
        warnings.push(
          `- 企业微信群组：groupPolicy="open" 允许所有群组中的成员触发。设置 channels.${CHANNEL_ID}.groupPolicy="allowlist" + channels.${CHANNEL_ID}.groupAllowFrom 来限制群组。`,
        );
      }

      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) return undefined;
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        return Boolean(trimmed);
      },
      hint: "<userId|groupId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getWeComRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId, ...rest }) => {
      console.log(`[WeCom] sendText: ${JSON.stringify({ to, text, accountId, ...rest })}`);
      return sendWeComMessage({ to, content: text, accountId: accountId ?? undefined });
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, ...rest }) => {
      console.log(
        `[WeCom] sendMedia: ${JSON.stringify({ to, text, mediaUrl, accountId, ...rest })}`,
      );
      const content = `Sending attachments is not supported yet\n${text ? `${text}\n${mediaUrl}` : (mediaUrl ?? "")}`;
      return sendWeComMessage({ to, content, accountId: accountId ?? undefined });
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
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId,
            kind: "config",
            message: "企业微信机器人 ID 或 Secret 未配置",
            fix: "Run: openclaw channels add wecom --bot-id <id> --secret <secret>",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async () => {
      return { ok: true, status: 200 };
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.botId?.trim() && account.secret?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      // 启动 WebSocket 监听
      return monitorWeComProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
      const nextWecom = { ...wecomConfig };
      let cleared = false;
      let changed = false;

      if (nextWecom.botId || nextWecom.secret) {
        delete nextWecom.botId;
        delete nextWecom.secret;
        cleared = true;
        changed = true;
      }

      if (changed) {
        if (Object.keys(nextWecom).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, [CHANNEL_ID]: nextWecom };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getWeComRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveWeComAccount(changed ? nextCfg : cfg);
      const loggedOut = !resolved.botId && !resolved.secret;

      return { cleared, envToken: false, loggedOut };
    },
  },
};
