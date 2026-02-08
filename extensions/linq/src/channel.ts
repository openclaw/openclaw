import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  collectLinqStatusIssues,
  linqOnboardingAdapter,
  linqOutbound,
  linqMessageActions,
  listLinqAccountIds,
  looksLikeLinqTargetId,
  normalizeLinqMessagingTarget,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
  resolveLinqGroupRequireMention,
  resolveLinqGroupToolPolicy,
  monitorLinqProvider,
  LinqClient,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedLinqAccount,
  type LinqAccountConfig,
} from "openclaw/plugin-sdk";
import { getLinqRuntime } from "./runtime.js";

export const linqPlugin: ChannelPlugin<ResolvedLinqAccount> = {
  id: "linq",
  meta: {
    id: "linq",
    label: "LINQ",
    selectionLabel: "LINQ (iMessage/RCS/SMS API)",
    detailLabel: "LINQ Partner API",
    docsPath: "/channels/linq",
    docsLabel: "linq",
    blurb: "send iMessage, RCS, and SMS via the LINQ Partner API.",
    systemImage: "message",
    showConfigured: false,
    order: 8,
  },
  onboarding: linqOnboardingAdapter,
  pairing: {
    idLabel: "linqSenderId",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    media: true,
    effects: true,
  },
  reload: { configPrefixes: ["channels.linq"] },
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
        clearBaseFields: ["apiToken", "tokenFile", "fromNumber", "preferredService", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      fromNumber: account.config.fromNumber ?? null,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveLinqAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^linq:/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const linq = cfg.channels?.linq as LinqAccountConfig & { accounts?: Record<string, LinqAccountConfig> } | undefined;
      const useAccountPath = Boolean(linq?.accounts?.[resolvedAccountId]);
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
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = (cfg.channels?.defaults as { groupPolicy?: string } | undefined)?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- LINQ groups: groupPolicy="open" allows any member to trigger the bot. Set channels.linq.groupPolicy="allowlist" + channels.linq.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveLinqGroupRequireMention,
    resolveToolPolicy: resolveLinqGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeLinqMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeLinqTargetId,
      hint: "<phone_e164|email>",
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
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "linq",
        accountId,
        name: input.name,
      });
      const linq = (namedConfig.channels?.linq ?? {}) as Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            linq: {
              ...linq,
              enabled: true,
              ...(input.apiToken ? { apiToken: input.apiToken } : {}),
              ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
              ...(input.preferredService ? { preferredService: input.preferredService } : {}),
            },
          },
        };
      }
      const accounts = (linq.accounts ?? {}) as Record<string, unknown>;
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          linq: {
            ...linq,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: {
                ...(accounts[accountId] as Record<string, unknown> | undefined),
                enabled: true,
                ...(input.apiToken ? { apiToken: input.apiToken } : {}),
                ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
                ...(input.preferredService ? { preferredService: input.preferredService } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: linqOutbound,
  actions: linqMessageActions,
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      const fromNumber = account.config.fromNumber;
      if (!fromNumber) return null;
      return { id: fromNumber, name: account.name ?? fromNumber };
    },
    listPeers: async ({ cfg, accountId }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      const token = account.config.apiToken;
      const fromNumber = account.config.fromNumber;
      if (!token || !fromNumber) return [];
      try {
        const client = new LinqClient(token);
        const result = await client.listChats({ from: fromNumber, limit: 100 });
        return result.chats
          .filter((chat) => !chat.is_group)
          .map((chat) => ({
            id: chat.id,
            name: chat.display_name || chat.handles.find((h) => !h.is_me)?.handle || chat.id,
            kind: "user" as const,
          }));
      } catch {
        return [];
      }
    },
    listGroups: async ({ cfg, accountId }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      const token = account.config.apiToken;
      const fromNumber = account.config.fromNumber;
      if (!token || !fromNumber) return [];
      try {
        const client = new LinqClient(token);
        const result = await client.listChats({ from: fromNumber, limit: 100 });
        return result.chats
          .filter((chat) => chat.is_group)
          .map((chat) => ({
            id: chat.id,
            name: chat.display_name || chat.id,
            kind: "group" as const,
          }));
      } catch {
        return [];
      }
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
    collectStatusIssues: collectLinqStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      const token = account.config.apiToken;
      if (!token) {
        return { ok: false, error: "API token not configured" };
      }
      try {
        const client = new LinqClient(token);
        const numbers = await client.listPhoneNumbers();
        return { ok: true, phoneNumbers: numbers.map((n) => n.phone_number) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      fromNumber: account.config.fromNumber ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled, configured }) => {
      if (!configured) return "not configured";
      return enabled ? "enabled" : "disabled";
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const fromNumber = account.config.fromNumber;
      ctx.setStatus({
        accountId: account.accountId,
      });
      ctx.log?.info(
        `[${account.accountId}] LINQ provider started (from=${fromNumber ?? "unset"})`,
      );
      // Poll LINQ API for inbound messages since webhooks require a public URL.
      return monitorLinqProvider({
        cfg: ctx.cfg,
        accountId: account.accountId,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        pollIntervalMs: 2000,
      });
    },
  },
};
