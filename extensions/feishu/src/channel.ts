import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  feishuOutbound,
  formatPairingApproveHint,
  listFeishuAccountIds,
  monitorFeishuProvider,
  normalizeFeishuTarget,
  PAIRING_APPROVED_MESSAGE,
  probeFeishu,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuConfig,
  resolveFeishuGroupRequireMention,
  setAccountEnabledInConfigSection,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type ResolvedFeishuAccount,
} from "openclaw/plugin-sdk";
import { FeishuConfigSchema } from "./config-schema.js";
import { feishuOnboardingAdapter } from "./onboarding.js";

const meta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu (Lark Open Platform)",
  detailLabel: "Feishu Bot",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "Feishu/Lark bot via WebSocket.",
  aliases: ["lark"],
  order: 35,
  quickstartAllowFrom: true,
};

const normalizeAllowEntry = (entry: string) => entry.replace(/^(feishu|lark):/i, "").trim();

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta,
  onboarding: feishuOnboardingAdapter,
  pairing: {
    idLabel: "feishuOpenId",
    normalizeAllowEntry: normalizeAllowEntry,
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveFeishuAccount({ cfg });
      if (!account.config.appId || !account.config.appSecret) {
        throw new Error("Feishu app credentials not configured");
      }
      await feishuOutbound.sendText({ cfg, to: id, text: PAIRING_APPROVED_MESSAGE });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.feishu"] },
  outbound: feishuOutbound,
  messaging: {
    normalizeTarget: normalizeFeishuTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = (normalized ?? raw).trim();
        if (!value) {
          return false;
        }
        return /^o[cun]_[a-zA-Z0-9]+$/.test(value) || /^(user|group|chat):/i.test(value);
      },
      hint: "<open_id|union_id|chat_id>",
    },
  },
  configSchema: buildChannelConfigSchema(FeishuConfigSchema),
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        clearBaseFields: ["appId", "appSecret", "appSecretFile", "name", "botName"],
      }),
    isConfigured: (account) => account.tokenSource !== "none",
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.tokenSource !== "none",
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveFeishuConfig({ cfg, accountId: accountId ?? undefined }).allowFrom.map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? entry : normalizeAllowEntry(entry)))
        .map((entry) => (entry === "*" ? entry : entry.toLowerCase())),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.feishu?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.feishu.accounts.${resolvedAccountId}.`
        : "channels.feishu.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("feishu"),
        normalizeEntry: normalizeAllowEntry,
      };
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      if (!groupId) {
        return true;
      }
      return resolveFeishuGroupRequireMention({
        cfg,
        accountId: accountId ?? undefined,
        chatId: groupId,
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const resolved = resolveFeishuConfig({ cfg, accountId: accountId ?? undefined });
      const normalizedQuery = query?.trim().toLowerCase() ?? "";
      const peers = resolved.allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry) => Boolean(entry) && entry !== "*")
        .map((entry) => normalizeAllowEntry(entry))
        .filter((entry) => (normalizedQuery ? entry.toLowerCase().includes(normalizedQuery) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const resolved = resolveFeishuConfig({ cfg, accountId: accountId ?? undefined });
      const normalizedQuery = query?.trim().toLowerCase() ?? "";
      const groups = Object.keys(resolved.groups ?? {})
        .filter((id) => (normalizedQuery ? id.toLowerCase().includes(normalizedQuery) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return groups;
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
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        if (!account.configured) {
          issues.push({
            channel: "feishu",
            accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
            kind: "config",
            message: "Feishu app ID/secret not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: async ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeFeishu(account.config.appId, account.config.appSecret, timeoutMs, account.config.domain),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = account.tokenSource !== "none";
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
    logSelfId: ({ account, runtime }) => {
      const appId = account.config.appId;
      if (appId) {
        runtime.log?.(`feishu:${appId}`);
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, log, setStatus, abortSignal, cfg, runtime } = ctx;
      const { appId, appSecret, domain } = account.config;
      if (!appId || !appSecret) {
        throw new Error("Feishu app ID/secret not configured");
      }

      let feishuBotLabel = "";
      try {
        const probe = await probeFeishu(appId, appSecret, 5000, domain);
        if (probe.ok && probe.bot?.appName) {
          feishuBotLabel = ` (${probe.bot.appName})`;
        }
        if (probe.ok && probe.bot) {
          setStatus({ accountId: account.accountId, bot: probe.bot });
        }
      } catch (err) {
        log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
      }

      log?.info(`[${account.accountId}] starting Feishu provider${feishuBotLabel}`);
      setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      try {
        await monitorFeishuProvider({
          appId,
          appSecret,
          accountId: account.accountId,
          config: cfg,
          runtime,
          abortSignal,
        });
      } catch (err) {
        setStatus({
          accountId: account.accountId,
          running: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  },
};
