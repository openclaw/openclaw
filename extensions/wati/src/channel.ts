import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectWatiStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listWatiAccountIds,
  looksLikeWatiTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  normalizeWatiMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDefaultWatiAccountId,
  resolveWatiAccount,
  setAccountEnabledInConfigSection,
  watiOnboardingAdapter,
  WatiConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedWatiAccount,
  type WatiProbe,
} from "openclaw/plugin-sdk";
import { getWatiRuntime } from "./runtime.js";

export const watiPlugin: ChannelPlugin<ResolvedWatiAccount, WatiProbe> = {
  id: "wati",
  meta: {
    ...getChatChannelMeta("wati"),
    quickstartAllowFrom: true,
  },
  onboarding: watiOnboardingAdapter,
  pairing: {
    idLabel: "phone number",
    normalizeAllowEntry: (entry) => {
      const stripped = entry.replace(/^wati:/i, "").trim();
      return normalizeE164(stripped) ?? stripped;
    },
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWatiAccount({ cfg });
      if (!account.apiToken) {
        throw new Error("WATI API token not configured");
      }
      await getWatiRuntime().channel.wati.sendMessageWati(id, PAIRING_APPROVED_MESSAGE, {
        apiToken: account.apiToken,
        baseUrl: account.apiBaseUrl,
        accountId: account.accountId,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wati"] },
  configSchema: buildChannelConfigSchema(WatiConfigSchema),
  config: {
    listAccountIds: (cfg) => listWatiAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWatiAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWatiAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "wati",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "wati",
        accountId,
        clearBaseFields: ["apiToken", "name"],
      }),
    isConfigured: (account) => Boolean(account.apiToken?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiToken?.trim()),
      tokenSource: account.apiTokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveWatiAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^wati:/i, ""))
        .map((entry) => entry.toLowerCase()),
    resolveDefaultTo: ({ cfg, accountId }) => {
      const val = resolveWatiAccount({ cfg, accountId }).config.defaultTo;
      return val != null ? String(val) : undefined;
    },
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.wati?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.wati.accounts.${resolvedAccountId}.`
        : "channels.wati.";
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("wati"),
        normalizeEntry: (raw) => raw.replace(/^wati:/i, ""),
      };
    },
    collectWarnings: () => [],
  },
  groups: {
    resolveRequireMention: () => false,
    resolveToolPolicy: () => undefined,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeWatiMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWatiTargetId,
      hint: "phone number (e.g., +1234567890)",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  actions: undefined,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "wati",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "WATI_API_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "WATI requires an API token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "wati",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "wati",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            wati: {
              ...next.channels?.wati,
              enabled: true,
              ...(input.useEnv ? {} : input.token ? { apiToken: input.token } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          wati: {
            ...next.channels?.wati,
            enabled: true,
            accounts: {
              ...next.channels?.wati?.accounts,
              [accountId]: {
                ...next.channels?.wati?.accounts?.[accountId],
                enabled: true,
                ...(input.token ? { apiToken: input.token } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: undefined,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveWatiAccount({ cfg, accountId });
      const result = await getWatiRuntime().channel.wati.sendMessageWati(to, text, {
        apiToken: account.apiToken,
        baseUrl: account.apiBaseUrl,
        accountId: account.accountId,
      });
      return { channel: "wati", ...result };
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
    collectStatusIssues: collectWatiStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
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
      getWatiRuntime().channel.wati.probeWati(account.apiToken, account.apiBaseUrl, timeoutMs),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiToken?.trim()),
      tokenSource: account.apiTokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? undefined,
      lastStopAt: runtime?.lastStopAt ?? undefined,
      lastError: runtime?.lastError ?? undefined,
      webhookUrl: account.config.webhookUrl,
      port: account.config.webhookPort ?? undefined,
      lastInboundAt: runtime?.lastInboundAt ?? undefined,
      lastOutboundAt: runtime?.lastOutboundAt ?? undefined,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.apiToken?.trim()) {
        throw new Error(
          `WATI API token missing for account "${account.accountId}". Set channels.wati.apiToken or WATI_API_TOKEN env var.`,
        );
      }
      ctx.log?.info(`[${account.accountId}] starting WATI provider`);
      return getWatiRuntime().channel.wati.monitorWatiProvider({
        apiToken: account.apiToken,
        apiBaseUrl: account.apiBaseUrl,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPort: account.config.webhookPort,
        webhookPath: account.config.webhookPath,
        webhookHost: account.config.webhookHost,
        webhookSecret: account.config.webhookSecret,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextWati = cfg.channels?.wati ? { ...cfg.channels.wati } : undefined;
      let cleared = false;
      let changed = false;
      if (nextWati) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextWati.apiToken) {
          delete nextWati.apiToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextWati.accounts && typeof nextWati.accounts === "object"
            ? { ...nextWati.accounts }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("apiToken" in nextEntry) {
              const token = nextEntry.apiToken;
              if (typeof token === "string" ? token.trim() : token) {
                cleared = true;
              }
              delete nextEntry.apiToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry as typeof entry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextWati.accounts;
            changed = true;
          } else {
            nextWati.accounts = accounts;
          }
        }
      }
      if (changed) {
        if (nextWati && Object.keys(nextWati).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, wati: nextWati };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.wati;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      const resolved = resolveWatiAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.apiTokenSource === "none";
      if (changed) {
        await getWatiRuntime().config.writeConfigFile(nextCfg);
      }
      return { cleared, envToken: Boolean(process.env.WATI_API_TOKEN?.trim()), loggedOut };
    },
  },
};
