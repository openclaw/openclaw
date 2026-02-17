import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listLinqAccountIds,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedLinqAccount,
  type LinqProbe,
  LinqConfigSchema,
} from "openclaw/plugin-sdk";
import { getLinqRuntime } from "./runtime.js";

const meta = getChatChannelMeta("linq");

export const linqPlugin: ChannelPlugin<ResolvedLinqAccount, LinqProbe> = {
  id: "linq",
  meta: {
    ...meta,
    aliases: ["linq-imessage"],
  },
  pairing: {
    idLabel: "phoneNumber",
    notifyApproval: async ({ id }) => {
      // Approval notification would need a chat_id, not just a phone number.
      // For now this is a no-op; pairing replies are sent in the monitor.
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.linq"] },
  configSchema: buildChannelConfigSchema(LinqConfigSchema),
  config: {
    listAccountIds: (cfg) => listLinqAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveLinqAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultLinqAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "linq",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "linq",
        accountId,
        clearBaseFields: ["apiToken", "tokenFile", "fromPhone", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      fromPhone: account.fromPhone,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveLinqAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      const useAccountPath = Boolean(
        (linqSection?.accounts as Record<string, unknown> | undefined)?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.linq.accounts.${resolvedAccountId}.`
        : "channels.linq.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("linq"),
      };
    },
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "open";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Linq groups: groupPolicy="open" allows any group member to trigger. Set channels.linq.groupPolicy="allowlist" + channels.linq.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: (params) => undefined,
    resolveToolPolicy: (params) => undefined,
  },
  messaging: {
    normalizeTarget: (raw) => raw ?? "",
    targetResolver: {
      looksLikeId: (id) => /^[A-Za-z0-9_-]+$/.test(id ?? ""),
      hint: "<chatId>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "linq",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "LINQ_API_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Linq requires an API token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "linq",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "linq" })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...((next.channels as Record<string, unknown> | undefined)?.linq as
                | Record<string, unknown>
                | undefined),
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { apiToken: input.token }
                    : {}),
            },
          },
        };
      }
      const linqSection = (next.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      return {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...linqSection,
            enabled: true,
            accounts: {
              ...(linqSection?.accounts as Record<string, unknown> | undefined),
              [accountId]: {
                ...((linqSection?.accounts as Record<string, unknown> | undefined)?.[accountId] as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { apiToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getLinqRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const send = getLinqRuntime().channel.linq.sendMessageLinq;
      const result = await send(to, text, { accountId: accountId ?? undefined });
      return { channel: "linq", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const send = getLinqRuntime().channel.linq.sendMessageLinq;
      const result = await send(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { channel: "linq", ...result };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "linq",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
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
      getLinqRuntime().channel.linq.probeLinq(account.token, timeoutMs, account.accountId),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      fromPhone: account.fromPhone,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let phoneLabel = "";
      try {
        const probe = await getLinqRuntime().channel.linq.probeLinq(token, 2500);
        if (probe.ok && probe.phoneNumbers?.length) {
          phoneLabel = ` (${probe.phoneNumbers.join(", ")})`;
        }
      } catch {
        // Probe failure is non-fatal for startup.
      }
      ctx.log?.info(`[${account.accountId}] starting Linq provider${phoneLabel}`);
      return getLinqRuntime().channel.linq.monitorLinqProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg };
      const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      let cleared = false;
      let changed = false;
      if (linqSection) {
        const nextLinq = { ...linqSection };
        if (accountId === DEFAULT_ACCOUNT_ID && nextLinq.apiToken) {
          delete nextLinq.apiToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextLinq.accounts && typeof nextLinq.accounts === "object"
            ? { ...(nextLinq.accounts as Record<string, unknown>) }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...(entry as Record<string, unknown>) };
            if ("apiToken" in nextEntry) {
              cleared = true;
              delete nextEntry.apiToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextLinq.accounts;
            changed = true;
          } else {
            nextLinq.accounts = accounts;
          }
        }
        if (changed) {
          if (Object.keys(nextLinq).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, linq: nextLinq } as typeof nextCfg.channels;
          } else {
            const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
            delete nextChannels.linq;
            nextCfg.channels = nextChannels as typeof nextCfg.channels;
          }
        }
      }
      if (changed) {
        await getLinqRuntime().config.writeConfigFile(nextCfg);
      }
      const resolved = resolveLinqAccount({ cfg: changed ? nextCfg : cfg, accountId });
      return { cleared, loggedOut: resolved.tokenSource === "none" };
    },
  },
};
