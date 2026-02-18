import {
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  KeybaseConfigSchema,
  keybaseOnboardingAdapter,
  listKeybaseAccountIds,
  looksLikeKeybaseTargetId,
  normalizeAccountId,
  normalizeKeybaseMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDefaultKeybaseAccountId,
  resolveKeybaseAccount,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ResolvedKeybaseAccount,
} from "openclaw/plugin-sdk";
import { getKeybaseRuntime } from "./runtime.js";

const meta = getChatChannelMeta("keybase");

export const keybasePlugin: ChannelPlugin<ResolvedKeybaseAccount> = {
  id: "keybase",
  meta: {
    ...meta,
  },
  onboarding: keybaseOnboardingAdapter,
  pairing: {
    idLabel: "keybaseUsername",
    normalizeAllowEntry: (entry) => entry.replace(/^keybase:/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      await getKeybaseRuntime().channel.keybase.sendMessageKeybase(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.keybase"] },
  configSchema: buildChannelConfigSchema(KeybaseConfigSchema),
  config: {
    listAccountIds: (cfg) => listKeybaseAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveKeybaseAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultKeybaseAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "keybase",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "keybase",
        accountId,
        clearBaseFields: ["name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveKeybaseAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : entry.replace(/^keybase:/i, "").toLowerCase()))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
        | Record<string, unknown>
        | undefined;
      const accounts = keybaseConfig?.accounts as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.keybase.accounts.${resolvedAccountId}.`
        : "channels.keybase.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("keybase"),
        normalizeEntry: (raw) =>
          raw
            .replace(/^keybase:/i, "")
            .trim()
            .toLowerCase(),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Keybase teams: groupPolicy="open" allows any member to trigger the bot. Set channels.keybase.groupPolicy="allowlist" + channels.keybase.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeKeybaseMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeKeybaseTargetId,
      hint: "<username|team:name#channel|keybase:username>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getKeybaseRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const send = getKeybaseRuntime().channel.keybase.sendMessageKeybase;
      const result = await send(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "keybase", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const send = getKeybaseRuntime().channel.keybase.sendMessageKeybase;
      const result = await send(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { channel: "keybase", ...result };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("keybase", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ timeoutMs }) => {
      return await getKeybaseRuntime().channel.keybase.probeKeybase("", timeoutMs);
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
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({ accountId: account.accountId });
      ctx.log?.info(`[${account.accountId}] starting keybase provider`);
      return getKeybaseRuntime().channel.keybase.monitorKeybaseProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
