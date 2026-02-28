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

function resolveConfiguredDefaultAccountId(cfg: any): string | undefined {
  const configuredDefault = cfg.channels?.["typex"]?.defaultAccount?.trim();
  if (configuredDefault) {
    return configuredDefault;
  }
  return undefined;
}

function resolveAccountSelectionId(cfg: any, accountId?: string | null): string {
  const explicit = accountId?.trim();
  if (explicit) {
    return explicit;
  }
  return resolveConfiguredDefaultAccountId(cfg) || DEFAULT_ACCOUNT_ID;
}

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
      const channelCfg = cfg.channels?.["typex"];
      const accs = channelCfg?.accounts || {};
      const ids = new Set<string>(Object.keys(accs));
      if (typeof channelCfg?.token === "string" && channelCfg.token.trim()) {
        ids.add(DEFAULT_ACCOUNT_ID);
      }
      const configuredDefault = resolveConfiguredDefaultAccountId(cfg);
      if (configuredDefault) {
        ids.add(configuredDefault);
      }
      return Array.from(ids);
    },
    resolveAccount: (cfg, accountId) => {
      const id = resolveAccountSelectionId(cfg, accountId);
      const globalCheck = cfg.channels?.["typex"];
      const account =
        cfg.channels?.["typex"]?.accounts?.[id] ||
        (id === DEFAULT_ACCOUNT_ID ? globalCheck : undefined);
      const channelEnabled = cfg.channels?.["typex"]?.enabled !== false;
      return {
        accountId: id,
        name: account?.name || "TypeX",
        enabled: channelEnabled && account?.enabled !== false,
        configured: Boolean(account?.token),
        tokenSource: "config",
        config: account || {},
      };
    },
    defaultAccountId: (cfg) => {
      const configuredDefault = resolveConfiguredDefaultAccountId(cfg);
      if (configuredDefault) {
        return configuredDefault;
      }
      const accs = cfg.channels?.["typex"]?.accounts || {};
      const first = Object.keys(accs)[0];
      return first || DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const id = resolveAccountSelectionId(cfg, accountId);
      const typexCfg = (cfg.channels?.["typex"] ?? {}) as Record<string, any>;
      const accounts = { ...(typexCfg.accounts ?? {}) };
      const hasAccountEntry = Object.prototype.hasOwnProperty.call(accounts, id);

      if (id === DEFAULT_ACCOUNT_ID && !hasAccountEntry) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            typex: {
              ...typexCfg,
              enabled,
            },
          },
        };
      }

      const existing = accounts[id] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          typex: {
            ...typexCfg,
            accounts: {
              ...accounts,
              [id]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const id = resolveAccountSelectionId(cfg, accountId);
      const typexCfg = cfg.channels?.["typex"];
      if (!typexCfg) {
        return cfg;
      }
      const accounts = { ...(typexCfg.accounts ?? {}) } as Record<string, any>;
      const hasAccountEntry = Object.prototype.hasOwnProperty.call(accounts, id);

      if (id === DEFAULT_ACCOUNT_ID && !hasAccountEntry) {
        const nextTypex = { ...typexCfg } as Record<string, any>;
        delete nextTypex.token;
        if (nextTypex.defaultAccount === DEFAULT_ACCOUNT_ID) {
          delete nextTypex.defaultAccount;
        }
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            typex: nextTypex,
          },
        };
      }

      delete accounts[id];
      const nextDefault =
        typexCfg.defaultAccount === id ? Object.keys(accounts)[0] : typexCfg.defaultAccount;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          typex: {
            ...typexCfg,
            defaultAccount: nextDefault,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
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
