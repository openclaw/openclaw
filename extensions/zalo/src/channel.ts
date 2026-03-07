import {
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
} from "openclaw/plugin-sdk";
import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/zalo";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  buildBaseAccountStatusSnapshot,
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  buildChannelSendResult,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  chunkTextForOutbound,
  formatAllowFromLowercase,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  listDirectoryUserEntriesFromAllowFrom,
  normalizeAccountId,
  isNumericTargetId,
  PAIRING_APPROVED_MESSAGE,
  resolveOutboundMediaUrls,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveChannelAccountConfigBasePath,
  sendPayloadWithChunkedTextAndMedia,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/zalo";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
  type ResolvedZaloAccount,
} from "./accounts.js";
import { zaloMessageActions } from "./actions.js";
import { ZaloConfigSchema } from "./config-schema.js";
import { zaloOnboardingAdapter } from "./onboarding.js";
import { probeZalo } from "./probe.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { sendMessageZalo } from "./send.js";
import { collectZaloStatusIssues } from "./status-issues.js";

const meta = {
  id: "zalo",
  label: "Zalo",
  selectionLabel: "Zalo (Bot API)",
  docsPath: "/channels/zalo",
  docsLabel: "zalo",
  blurb: "Vietnam-focused messaging platform with Bot API.",
  aliases: ["zl"],
  order: 80,
  quickstartAllowFrom: true,
};

function normalizeZaloMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(zalo|zl):/i, "");
}

export const zaloDock: ChannelDock = {
  id: "zalo",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 2000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZaloAccount({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount> = {
  id: "zalo",
  meta,
  onboarding: zaloOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.zalo"] },
  configSchema: buildChannelConfigSchema(ZaloConfigSchema),
  config: {
    listAccountIds: (cfg) => listZaloAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZaloAccount({ cfg: cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZaloAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "zalo",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "zalo",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZaloAccount({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: "zalo",
        accountId: resolvedAccountId,
      });
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zalo"),
        normalizeEntry: (raw) => raw.replace(/^(zalo|zl):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.zalo !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") {
        return [];
      }
      const explicitGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) =>
        String(entry),
      );
      const dmAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
      const effectiveAllowFrom =
        explicitGroupAllowFrom.length > 0 ? explicitGroupAllowFrom : dmAllowFrom;
      if (effectiveAllowFrom.length > 0) {
        return [
          buildOpenGroupPolicyRestrictSendersWarning({
            surface: "Zalo groups",
            openScope: "any member",
            groupPolicyPath: "channels.zalo.groupPolicy",
            groupAllowFromPath: "channels.zalo.groupAllowFrom",
          }),
        ];
      }
      return [
        buildOpenGroupPolicyWarning({
          surface: "Zalo groups",
          openBehavior:
            "with no groupAllowFrom/allowFrom allowlist; any member can trigger (mention-gated)",
          remediation: 'Set channels.zalo.groupPolicy="allowlist" + channels.zalo.groupAllowFrom',
        }),
      ];
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  actions: zaloMessageActions,
  messaging: {
    normalizeTarget: normalizeZaloMessagingTarget,
    targetResolver: {
      looksLikeId: isNumericTargetId,
      hint: "<chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveZaloAccount({ cfg: cfg, accountId });
      return listDirectoryUserEntriesFromAllowFrom({
        allowFrom: account.config.allowFrom,
        query,
        limit,
        normalizeId: (entry) => entry.replace(/^(zalo|zl):/i, ""),
      });
    },
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "zalo",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "ZALO_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Zalo requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "zalo",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zalo",
            })
          : namedConfig;
      const patch = input.useEnv
        ? {}
        : input.tokenFile
          ? { tokenFile: input.tokenFile }
          : input.token
            ? { botToken: input.token }
            : {};
      return applySetupAccountConfigPatch({
        cfg: next,
        channelKey: "zalo",
        accountId,
        patch,
      });
    },
  },
  pairing: {
    idLabel: "zaloUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalo|zl):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveZaloAccount({ cfg: cfg });
      if (!account.token) {
        throw new Error("Zalo token not configured");
      }
      await sendMessageZalo(id, PAIRING_APPROVED_MESSAGE, { token: account.token });
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 2000,
    sendPayload: async (ctx) =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: zaloPlugin.outbound!.textChunkLimit,
        chunker: zaloPlugin.outbound!.chunker,
        sendText: (nextCtx) => zaloPlugin.outbound!.sendText!(nextCtx),
        sendMedia: (nextCtx) => zaloPlugin.outbound!.sendMedia!(nextCtx),
        emptyResult: { channel: "zalo", messageId: "" },
      }),
    sendText: async ({ to, text, accountId, cfg }) => {
      const result = await sendMessageZalo(to, text, {
        accountId: accountId ?? undefined,
        cfg: cfg,
      });
      return buildChannelSendResult("zalo", result);
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const result = await sendMessageZalo(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
        cfg: cfg,
      });
      return buildChannelSendResult("zalo", result);
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
    collectStatusIssues: collectZaloStatusIssues,
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      probeZalo(account.token, timeoutMs, resolveZaloProxyFetch(account.config.proxy)),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.token?.trim());
      const base = buildBaseAccountStatusSnapshot({
        account: {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
        },
        runtime,
      });
      return {
        ...base,
        tokenSource: account.tokenSource,
        mode: account.config.webhookUrl ? "webhook" : "polling",
        dmPolicy: account.config.dmPolicy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let zaloBotLabel = "";
      const fetcher = resolveZaloProxyFetch(account.config.proxy);
      try {
        const probe = await probeZalo(token, 2500, fetcher);
        const name = probe.ok ? probe.bot?.name?.trim() : null;
        if (name) {
          zaloBotLabel = ` (${name})`;
        }
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
        });
      } catch {
        // ignore probe errors
      }
      ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel}`);
      const { monitorZaloProvider } = await import("./monitor.js");
      return monitorZaloProvider({
        token,
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
        webhookPath: account.config.webhookPath,
        fetcher,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
