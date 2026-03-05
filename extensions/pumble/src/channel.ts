import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { PumbleConfigSchema } from "./config-schema.js";
import { resolvePumbleGroupRequireMention } from "./group-mentions.js";
import { looksLikePumbleTargetId, normalizePumbleMessagingTarget } from "./normalize.js";
import { pumbleOnboardingAdapter } from "./onboarding.js";
import {
  listPumbleAccountIds,
  resolveDefaultPumbleAccountId,
  resolvePumbleAccount,
  type ResolvedPumbleAccount,
} from "./pumble/accounts.js";
import { createPumbleClient, fetchPumbleChannel } from "./pumble/client.js";
import { applyPumbleCredentials } from "./pumble/config-helpers.js";
import { pumbleMessageActions } from "./pumble/message-actions.js";
import { normalizePumbleAllowEntry } from "./pumble/monitor-auth.js";
import { monitorPumbleProvider } from "./pumble/monitor.js";
import { probePumble } from "./pumble/probe.js";
import { sendMessagePumble } from "./pumble/send.js";
import { resolveSubagentLabelSuffix } from "./pumble/thread-bindings.lifecycle.js";
import { getPumbleRuntime } from "./runtime.js";

function isAccountConfigured(account: ResolvedPumbleAccount): boolean {
  return Boolean(account.appId && account.appKey && account.botToken);
}

const meta = {
  id: "pumble",
  label: "Pumble",
  selectionLabel: "Pumble (plugin)",
  detailLabel: "Pumble Bot",
  docsPath: "/channels/pumble",
  docsLabel: "pumble",
  blurb: "Slack-style team messaging by CAKE.com; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 66,
} as const;

export const pumblePlugin: ChannelPlugin<ResolvedPumbleAccount> = {
  id: "pumble",
  meta,
  onboarding: pumbleOnboardingAdapter,
  pairing: {
    idLabel: "pumbleUserId",
    normalizeAllowEntry: normalizePumbleAllowEntry,
    notifyApproval: async (_ctx) => {
      // Core handles approval notification
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    reactions: true,
    threads: true,
    media: true,
  },
  actions: pumbleMessageActions,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.pumble"] },
  configSchema: buildChannelConfigSchema(PumbleConfigSchema),
  config: {
    listAccountIds: (cfg) => listPumbleAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolvePumbleAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultPumbleAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "pumble",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "pumble",
        accountId,
        clearBaseFields: ["appId", "appKey", "clientSecret", "signingSecret", "botToken", "name"],
      }),
    isConfigured: (account) => isAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      appIdSource: account.appIdSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolvePumbleAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizePumbleAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.pumble?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.pumble.accounts.${resolvedAccountId}.`
        : "channels.pumble.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("pumble"),
        normalizeEntry: (raw) => normalizePumbleAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.pumble !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Pumble channels: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.pumble.groupPolicy="allowlist" + channels.pumble.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolvePumbleGroupRequireMention,
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentChannelProvider: "pumble",
      currentThreadTs:
        (context.MessageThreadId != null ? String(context.MessageThreadId) : undefined) ??
        (context.ReplyToId != null ? String(context.ReplyToId) : undefined),
      hasRepliedRef,
    }),
  },
  messaging: {
    normalizeTarget: normalizePumbleMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikePumbleTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getPumbleRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 9000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Pumble requires --to <channelId|user:ID|channel:ID>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const suffix = resolveSubagentLabelSuffix({
        threadRootId: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      const result = await sendMessagePumble(to, text + suffix, {
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "pumble", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const suffix = resolveSubagentLabelSuffix({
        threadRootId: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      const result = await sendMessagePumble(to, text + suffix, {
        accountId: accountId ?? undefined,
        mediaUrl,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "pumble", ...result };
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
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      if (!token) {
        return { ok: false, error: "bot token missing (complete OAuth flow first)" };
      }
      return await probePumble(token, timeoutMs, account.appKey?.trim());
    },
    auditAccount: async ({ account, probe }) => {
      const probeResult = probe as { ok?: boolean; bot?: unknown } | undefined;
      if (!probeResult?.ok || !probeResult?.bot) {
        return { ok: false };
      }
      const token = account.botToken?.trim();
      if (!token) {
        return { ok: false, error: "no token" };
      }
      const client = createPumbleClient({ botToken: token, appKey: account.appKey?.trim() });
      const channels = account.channelAllowlist ?? [];
      const results: Array<{ id: string; name?: string; ok: boolean; error?: string }> = [];
      for (const ch of channels.slice(0, 10)) {
        try {
          const info = await fetchPumbleChannel(client, ch);
          results.push({ id: ch, name: info.name, ok: true });
        } catch (err) {
          results.push({ id: ch, ok: false, error: String(err) });
        }
      }
      return { ok: true, channels: results };
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      tokenSource: account.appIdSource,
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
        channelKey: "pumble",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Pumble env vars can only be used for the default account.";
      }
      // --token maps to appId, --bot-token maps to botToken
      const appId = input.token;
      const botToken = input.botToken;
      if (!input.useEnv && (!appId || !botToken)) {
        return "Pumble requires app credentials (--token for appId and --bot-token for botToken, or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      // --token → appId, --bot-token → botToken.
      // appKey, clientSecret, signingSecret are Pumble-specific extras not on
      // ChannelSetupInput; use the onboarding wizard or manual config for those.
      if (input.useEnv) {
        return applyPumbleCredentials({ cfg, accountId, creds: {}, name: input.name });
      }
      const extra = input as typeof input & {
        appKey?: string;
        clientSecret?: string;
        signingSecret?: string;
      };
      return applyPumbleCredentials({
        cfg,
        accountId,
        creds: {
          appId: input.token,
          botToken: input.botToken,
          appKey: extra.appKey,
          clientSecret: extra.clientSecret,
          signingSecret: extra.signingSecret,
        },
        name: input.name,
      });
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        tokenSource: account.appIdSource,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      return monitorPumbleProvider({
        botToken: account.botToken ?? undefined,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
