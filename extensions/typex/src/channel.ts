import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { monitorTypeXProvider } from "./client/monitor.js";
import { typexOutbound } from "./client/outbound.js";
import { TypeXConfigSchema } from "./config-schema.js";
import { typexOnboardingAdapter } from "./onboarding.js";

const meta = {
  id: "typex",
  label: "TypeX",
  selectionLabel: "TypeX (QR Code Login)",
  detailLabel: "TypeX Bot",
  docsPath: "/channels/typex",
  docsLabel: "typex",
  blurb: "TypeX bot via QR Code login.",
  order: 100,
};

export const typexPlugin = {
  id: "typex",
  meta,
  onboarding: typexOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.typex"] },
  outbound: typexOutbound as any,

  messaging: {
    normalizeTarget: (t) => t,
    targetResolver: {
      looksLikeId: () => true,
      hint: "chat_id",
    },
  },

  configSchema: buildChannelConfigSchema(TypeXConfigSchema as any),

  config: {
    listAccountIds: (cfg) => {
      const accs = cfg.channels?.["typex"]?.accounts || {};
      return Object.keys(accs);
    },
    resolveAccount: (cfg, accountId) => {
      const id = accountId || DEFAULT_ACCOUNT_ID;
      const globalCheck = cfg.channels?.["typex"];
      const account =
        cfg.channels?.["typex"]?.accounts?.[id] ||
        (id === DEFAULT_ACCOUNT_ID ? globalCheck : undefined);
      return {
        accountId: id,
        name: account?.name || "TypeX",
        enabled: account?.enabled !== false,
        configured: Boolean(account?.token),
        tokenSource: "config",
        config: account || {},
      };
    },
    defaultAccountId: (cfg) => {
      const configuredDefault = cfg.channels?.["typex"]?.defaultAccount?.trim();
      if (configuredDefault) {
        return configuredDefault;
      }
      const accs = cfg.channels?.["typex"]?.accounts || {};
      const first = Object.keys(accs)[0];
      return first || DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled: ({ cfg }) => cfg,
    deleteAccount: ({ cfg }) => cfg,
    isConfigured: (acc) => acc.configured,
    describeAccount: (acc) => ({
      accountId: acc.accountId!,
      name: acc.name,
      enabled: acc.enabled,
      configured: acc.configured,
      tokenSource: acc.tokenSource,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: () => [],
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, log, setStatus, abortSignal, runtime, cfg } = ctx;
      const typexCfg = (cfg.channels?.["typex"] ?? {}) as Record<string, any>;

      log?.info(`[${account.accountId}] TypeX Provider starting...`);

      setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      try {
        await monitorTypeXProvider({
          account,
          runtime,
          abortSignal,
          log,
          typexCfg,
          cfg,
        });
      } catch (err) {
        log?.error(`TypeX Provider crashed: ${err}`);
        setStatus({
          accountId: account.accountId,
          running: false,
          lastError: err instanceof Error ? err.message : String(err),
          lastStopAt: Date.now(),
        });
        throw err;
      }
    },
  },
  security: {
    // Simplified security policy
    resolveDmPolicy: () => ({
      policy: "open",
      allowFrom: [],
      policyPath: "",
      allowFromPath: "",
      approveHint: "",
      normalizeEntry: (s) => s,
    }),
  },

  groups: {
    resolveRequireMention: () => false,
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: async ({ snapshot }) => ({
      configured: snapshot.configured,
      tokenSource: snapshot.tokenSource,
      running: snapshot.running,
      lastStartAt: snapshot.lastStartAt,
      lastStopAt: snapshot.lastStopAt,
      lastError: snapshot.lastError,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt,
    }),
    probeAccount: async () => ({ ok: true, timestamp: Date.now() }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: null,
      lastOutboundAt: null,
    }),
    logSelfId: () => {},
  },
} satisfies ChannelPlugin<any>;
