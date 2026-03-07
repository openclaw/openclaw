/**
 * Zulip Channel Plugin
 */

import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { ZulipConfigSchema } from "./config-schema.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { normalizeZulipBaseUrl, createZulipClient, fetchZulipMe } from "./zulip/client.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { sendMessageZulip, setZulipConfigGetter } from "./zulip/send.js";
import { getZulipRuntime } from "./runtime.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  detailLabel: "Zulip Bot",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "Open-source threaded team chat with powerful search and integrations.",
  systemImage: "bubble.left.and.bubble.right",
  order: 66,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(zulip|user):/i, "").toLowerCase();
}

function looksLikeZulipTargetId(target: string): boolean {
  const t = target.trim();
  // Stream targets: stream:name:topic
  if (t.startsWith("stream:")) return true;
  // DM targets: dm:user_id or direct:user_id
  if (t.startsWith("dm:") || t.startsWith("direct:")) return true;
  // User ID targets: @123 or just numbers
  if (/^@?\d+$/.test(t)) return true;
  // Stream name with topic: name:topic
  if (/^[a-z0-9_-]+:[a-z0-9_\s-]+$/i.test(t)) return true;
  return false;
}

function normalizeZulipMessagingTarget(target: string): string {
  const t = target.trim();
  // Already properly formatted
  if (t.startsWith("stream:") || t.startsWith("dm:") || t.startsWith("direct:")) {
    return t;
  }
  // User ID
  if (/^@?\d+$/.test(t)) {
    return `dm:${t.replace("@", "")}`;
  }
  // Assume stream name
  return t.includes(":") ? `stream:${t}` : `stream:${t}:general`;
}

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  id: "zulip",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "zulipUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[zulip] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    threads: true,
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.zulip"] },
  configSchema: buildChannelConfigSchema(ZulipConfigSchema),
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg),
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
        clearBaseFields: ["email", "apiKey", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.email && account.apiKey && account.baseUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.email && account.apiKey && account.baseUrl),
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
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
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Zulip streams: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.zulip.groupPolicy="allowlist" + channels.zulip.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveZulipAccount({ cfg, accountId });
      // Default to require mention in streams
      return account.config.requireMention !== false;
    },
  },
  messaging: {
    normalizeTarget: normalizeZulipMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeZulipTargetId,
      hint: "<stream:name:topic|dm:user_id>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 10000, // Zulip has high message limits
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Zulip requires --to <stream:name:topic|dm:user_id>",
          ),
        };
      }
      return { ok: true, to: normalizeZulipMessagingTarget(trimmed) };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageZulip(to, text, {
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      });
      return {
        channel: "zulip",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error,
        to: result.to,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const result = await sendMessageZulip(to, text ?? "", {
        accountId: accountId ?? undefined,
        mediaUrl,
        replyToId: replyToId ?? undefined,
      });
      return {
        channel: "zulip",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error,
        to: result.to,
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
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const email = account.email?.trim();
      const apiKey = account.apiKey?.trim();
      const baseUrl = account.baseUrl?.trim();
      if (!email || !apiKey || !baseUrl) {
        return { ok: false, error: "email, apiKey or baseUrl missing" };
      }
      try {
        const client = createZulipClient({ baseUrl, email, apiKey });
        const user = await fetchZulipMe(client);
        return { ok: true, botUserId: user.user_id, botName: user.full_name };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.email && account.apiKey && account.baseUrl),
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
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
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Zulip env vars can only be used for the default account.";
      }
      const email = (input as Record<string, unknown>).email as string | undefined;
      const apiKey = (input as Record<string, unknown>).apiKey as string | undefined;
      const baseUrl = (input.httpUrl || (input as Record<string, unknown>).baseUrl) as string | undefined;
      if (!input.useEnv && (!email || !apiKey || !baseUrl)) {
        return "Zulip requires --email, --api-key, and --http-url (or --use-env).";
      }
      if (baseUrl && !normalizeZulipBaseUrl(baseUrl)) {
        return "Zulip --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const email = (input as Record<string, unknown>).email as string | undefined;
      const apiKey = (input as Record<string, unknown>).apiKey as string | undefined;
      const baseUrl = (input.httpUrl?.trim() || (input as Record<string, unknown>).baseUrl as string | undefined)?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zulip",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...next.channels?.zulip,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(email ? { email } : {}),
                    ...(apiKey ? { apiKey } : {}),
                    ...(baseUrl ? { baseUrl } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zulip: {
            ...next.channels?.zulip,
            enabled: true,
            accounts: {
              ...next.channels?.zulip?.accounts,
              [accountId]: {
                ...next.channels?.zulip?.accounts?.[accountId],
                enabled: true,
                ...(email ? { email } : {}),
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      
      // Set up config getter for send.ts
      setZulipConfigGetter(() => ctx.cfg);
      
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      
      if (!account.email || !account.apiKey || !account.baseUrl) {
        throw new Error("Zulip account not configured: missing email, apiKey, or baseUrl");
      }
      
      return monitorZulipProvider({
        email: account.email,
        apiKey: account.apiKey,
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: getZulipRuntime(),
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
