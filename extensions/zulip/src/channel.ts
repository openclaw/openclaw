import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { ZulipConfigSchema } from "./config-schema.js";
import { looksLikeZulipTargetId, normalizeZulipMessagingTarget } from "./normalize.js";
import { getZulipRuntime } from "./runtime.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { probeZulip } from "./zulip/probe.js";
import { sendMessageZulip } from "./zulip/send.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "threaded team chat; configure realm + email + API key.",
  order: 66,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  id: "zulip",
  meta,
  pairing: {
    idLabel: "zulipEmail",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id, accountId }) => {
      await sendMessageZulip(`pm:${id}`, PAIRING_APPROVED_MESSAGE, { accountId });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    threads: true,
    reactions: true,
    media: false,
  },
  reload: { configPrefixes: ["channels.zulip"] },
  configSchema: buildChannelConfigSchema(ZulipConfigSchema),
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveZulipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZulipAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        clearBaseFields: ["name", "realm", "site", "email", "apiKey"],
      }),
    isConfigured: (account) => Boolean(account.baseUrl && account.email && account.apiKey),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.email && account.apiKey),
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      Array.from(
        new Set(allowFrom.map((e) => normalizeAllowEntry(String(e))).filter((e) => Boolean(e))),
      ),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.zulip?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.zulip.accounts.${resolvedAccountId}.`
        : "channels.zulip.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

      if (groupPolicy === "open") {
        warnings.push(
          '- Zulip channels: groupPolicy="open" allows any stream message (subject to requireMention) to trigger. Prefer groupPolicy="allowlist" and configure channels.zulip.groupAllowFrom / channels.zulip.channels for tighter control.',
        );
      }

      return warnings;
    },
  },
  messaging: {
    normalizeTarget: normalizeZulipMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeZulipTargetId,
      hint: "stream:<stream>/<topic> | pm:<email> | <stream>#<topic>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveZulipAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const peers = (account.config.allowFrom ?? [])
        .map((e) => String(e).trim())
        .filter((e) => Boolean(e) && e !== "*")
        .map((e) => ({ kind: "user", id: `pm:${e.toLowerCase()}` as const, name: e }));
      const filtered = q ? peers.filter((p) => p.id.toLowerCase().includes(q)) : peers;
      return filtered.slice(0, limit && limit > 0 ? limit : undefined);
    },
    listGroups: async () => {
      // MVP: directory from config only; streams not enumerated.
      return [];
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 9000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            'Delivering to Zulip requires --to "stream:<stream>/<topic>" or "pm:<email>"',
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageZulip(to, text, { accountId: accountId ?? undefined });
      if (!result.ok) {
        throw result.error;
      }
      return { channel: "zulip", messageId: result.messageId };
    },
    sendMedia: async () => {
      throw new Error("Zulip plugin: media is not supported (send text-only messages)");
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) {
        return null;
      }
      if (!input.realm?.trim() && !input.site?.trim()) {
        return "Zulip requires --realm (or --site)";
      }
      if (!input.email?.trim()) {
        return "Zulip requires --email";
      }
      if (!input.apiKey?.trim()) {
        return "Zulip requires --api-key";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const named = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId: DEFAULT_ACCOUNT_ID,
        name: input.name,
      });
      type PartialCfg = Record<string, unknown> & {
        channels?: { zulip?: Record<string, unknown> };
      };
      const base = named as PartialCfg;
      if (input.useEnv) {
        return {
          ...base,
          channels: {
            ...base.channels,
            zulip: {
              ...base.channels?.zulip,
              enabled: true,
            },
          },
        };
      }
      const realm = input.realm?.trim();
      const site = input.site?.trim();
      const email = input.email?.trim();
      const apiKey = input.apiKey?.trim();
      return {
        ...base,
        channels: {
          ...base.channels,
          zulip: {
            ...base.channels?.zulip,
            enabled: true,
            ...(realm ? { realm } : {}),
            ...(site ? { site } : {}),
            ...(email ? { email } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
        },
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastDisconnect: snapshot.lastDisconnect ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl?.trim();
      const email = account.email?.trim();
      const apiKey = account.apiKey?.trim();
      if (!baseUrl || !email || !apiKey) {
        return { ok: false, error: "baseUrl/email/apiKey missing" };
      }
      return await probeZulip({ baseUrl, email, apiKey }, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.email && account.apiKey),
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      return monitorZulipProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
