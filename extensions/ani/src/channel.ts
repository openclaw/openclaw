import type { CoreConfig, ResolvedAniAccount } from "./types.js";
import { AniConfigSchema } from "./config-schema.js";
import { aniOutbound } from "./outbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  type ChannelPlugin,
} from "./sdk-compat.js";
import { normalizeAniServerUrl } from "./utils.js";

const meta = {
  id: "ani",
  label: "Agent-Native IM",
  selectionLabel: "Agent-Native IM (plugin)",
  docsPath: "/channels/ani",
  docsLabel: "ani",
  blurb: "Agent-Native IM — messaging platform built for AI Bots.",
  order: 80,
  quickstartAllowFrom: false,
};

export function resolveAniAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedAniAccount {
  const accountId = normalizeAccountId(params.accountId);
  const aniCfg = params.cfg.channels?.ani ?? {};
  const enabled = aniCfg.enabled !== false;
  const serverUrl = normalizeAniServerUrl(aniCfg.serverUrl);
  const apiKey = aniCfg.apiKey ?? "";
  const configured = Boolean(serverUrl && apiKey && !apiKey.startsWith("aimb_"));

  return {
    accountId,
    enabled,
    name: aniCfg.name?.trim(),
    configured,
    serverUrl: serverUrl || undefined,
    entityId: aniCfg.entityId,
    config: aniCfg,
  };
}

export const aniPlugin: ChannelPlugin<ResolvedAniAccount> = {
  id: "ani",
  meta,

  capabilities: {
    chatTypes: ["group", "direct"],
    polls: false,
    reactions: true,
    threads: false,
    media: true,
  },

  reload: { configPrefixes: ["channels.ani"] },
  configSchema: buildChannelConfigSchema(AniConfigSchema),

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveAniAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "ani",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "ani",
        accountId,
        clearBaseFields: ["name", "serverUrl", "apiKey", "entityId"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.serverUrl,
    }),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "open",
      allowFrom: [],
      policyPath: "channels.ani.dm.policy",
      allowFromPath: "channels.ani.dm.allowFrom",
    }),
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "ani",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) return null;
      if (!input.serverUrl?.trim()) return "ANI requires --server-url";
      if (!input.apiKey?.trim()) return "ANI requires --api-key (permanent aim_ key)";
      const key = input.apiKey?.trim() ?? "";
      if (key.startsWith("aimb_")) {
        return "ANI requires a permanent key (aim_ prefix). Legacy aimb_ keys are no longer supported.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const named = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "ani",
        accountId: DEFAULT_ACCOUNT_ID,
        name: input.name,
      });
      if (input.useEnv) {
        return {
          ...named,
          channels: {
            ...named.channels,
            ani: { ...named.channels?.ani, enabled: true },
          },
        } as CoreConfig;
      }
      const existing = (named as CoreConfig).channels?.ani ?? {};
      return {
        ...named,
        channels: {
          ...named.channels,
          ani: {
            ...existing,
            enabled: true,
            ...(input.serverUrl ? { serverUrl: input.serverUrl.trim().replace(/\/+$/, "") } : {}),
            ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
          },
        },
      } as CoreConfig;
    },
  },

  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },

  outbound: aniOutbound,

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "ani",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.serverUrl || !account.config.apiKey) {
        return { ok: false, error: "not configured", elapsedMs: 0 };
      }
      const start = Date.now();
      try {
        const { verifyAniConnection } = await import("./monitor/send.js");
        await verifyAniConnection({
          serverUrl: account.serverUrl,
          apiKey: account.config.apiKey,
        });
        return { ok: true, elapsedMs: Date.now() - start };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - start,
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.serverUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.serverUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting ANI provider (${account.serverUrl ?? "ani"})`);
      const { monitorAniProvider } = await import("./monitor/index.js");
      return monitorAniProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId,
      });
    },
  },
};
