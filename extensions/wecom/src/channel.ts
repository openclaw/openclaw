import type { ChannelAccountSnapshot, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import type { ResolvedAgentAccount, ResolvedBotAccount } from "./types/index.js";
import { resolveWecomAccounts } from "./config/index.js";
import { WecomConfigSchema } from "./config/index.js";
import { registerAgentWebhookTarget, registerWecomWebhookTarget } from "./monitor.js";
import { wecomOnboardingAdapter } from "./onboarding.js";
import { wecomOutbound } from "./outbound.js";

const meta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (plugin)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "Enterprise WeCom intelligent bot (API mode) via encrypted webhooks + passive replies.",
  aliases: ["wechatwork", "wework", "qywx", "企微", "企业微信"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeWecomMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "").trim() || undefined;
}

type ResolvedWecomAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  bot?: ResolvedBotAccount;
  agent?: ResolvedAgentAccount;
};

/**
 * **resolveWecomAccount (解析账号配置)**
 *
 * 从全局配置中解析出 WeCom 渠道的配置状态。
 * 兼容 Bot 和 Agent 两种模式的配置检查。
 */
function resolveWecomAccount(cfg: OpenClawConfig): ResolvedWecomAccount {
  const enabled = (cfg.channels?.wecom as { enabled?: boolean } | undefined)?.enabled !== false;
  const accounts = resolveWecomAccounts(cfg);
  const bot = accounts.bot;
  const agent = accounts.agent;
  const configured = Boolean(bot?.configured || agent?.configured);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled,
    configured,
    bot,
    agent,
  };
}

export const wecomPlugin: ChannelPlugin<ResolvedWecomAccount> = {
  id: "wecom",
  meta,
  onboarding: wecomOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: buildChannelConfigSchema(WecomConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveWecomAccount(cfg as OpenClawConfig),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: "wecom",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg }) => {
      const next = { ...(cfg as OpenClawConfig) };
      if (next.channels?.wecom) {
        const channels = { ...(next.channels ?? {}) } as Record<string, unknown>;
        delete (channels as Record<string, unknown>).wecom;
        return { ...next, channels } as OpenClawConfig;
      }
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.bot?.config
        ? "/wecom/bot"
        : account.agent?.config
          ? "/wecom/agent"
          : "/wecom",
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWecomAccount(cfg as OpenClawConfig);
      // 与其他渠道保持一致：直接返回 allowFrom，空则允许所有人
      const allowFrom =
        account.agent?.config.dm?.allowFrom ?? account.bot?.config.dm?.allowFrom ?? [];
      return allowFrom.map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  // security 配置在 WeCom 中不需要，框架会通过 resolveAllowFrom 自动判断
  groups: {
    // WeCom bots are usually mention-gated by the platform in groups already.
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeWecomMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw.trim()),
      hint: "<userid|chatid>",
    },
  },
  outbound: {
    ...wecomOutbound,
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
      webhookPath: snapshot.webhookPath ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async () => ({ ok: true }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.bot?.config
        ? "/wecom/bot"
        : account.agent?.config
          ? "/wecom/agent"
          : "/wecom",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.bot?.config.dm?.policy ?? "pairing",
    }),
  },
  gateway: {
    /**
     * **startAccount (启动账号)**
     *
     * 插件生命周期：启动
     * 职责：
     * 1. 检查配置是否有效。
     * 2. 注册 Bot Webhook (`/wecom`, `/wecom/bot`)。
     * 3. 注册 Agent Webhook (`/wecom/agent`)。
     * 4. 更新运行时状态 (Running)。
     * 5. 返回停止回调 (Cleanup)。
     */
    startAccount: async (ctx) => {
      const account = ctx.account;
      const bot = account.bot;
      const agent = account.agent;
      const botConfigured = Boolean(bot?.configured);
      const agentConfigured = Boolean(agent?.configured);

      if (!botConfigured && !agentConfigured) {
        ctx.log?.warn(`[${account.accountId}] wecom not configured; skipping webhook registration`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
        return { stop: () => {} };
      }

      const unregisters: Array<() => void> = [];
      if (bot && botConfigured) {
        for (const path of ["/wecom", "/wecom/bot"]) {
          unregisters.push(
            registerWecomWebhookTarget({
              account: bot,
              config: ctx.cfg as OpenClawConfig,
              runtime: ctx.runtime,
              // The HTTP handler resolves the active PluginRuntime via getWecomRuntime().
              // The stored target only needs to be decrypt/verify-capable.
              core: {} as unknown as any,
              path,
              statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
            }),
          );
        }
        ctx.log?.info(
          `[${account.accountId}] wecom bot webhook registered at /wecom and /wecom/bot`,
        );
      }
      if (agent && agentConfigured) {
        unregisters.push(
          registerAgentWebhookTarget({
            agent,
            config: ctx.cfg as OpenClawConfig,
            runtime: ctx.runtime,
          }),
        );
        ctx.log?.info(`[${account.accountId}] wecom agent webhook registered at /wecom/agent`);
      }

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        webhookPath: botConfigured ? "/wecom/bot" : "/wecom/agent",
        lastStartAt: Date.now(),
      });
      return {
        stop: () => {
          for (const unregister of unregisters) {
            unregister();
          }
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
        },
      };
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
