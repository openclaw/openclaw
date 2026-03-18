import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  collectOpenProviderGroupPolicyWarnings,
} from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/zalo";
import {
  buildBaseAccountStatusSnapshot,
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  buildChannelSendResult,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  formatAllowFromLowercase,
  listDirectoryUserEntriesFromAllowFrom,
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "openclaw/plugin-sdk/zalo";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
  type ResolvedZaloAccount,
} from "./accounts.js";
import { zaloMessageActions } from "./actions.js";
import { ZaloConfigSchema } from "./config-schema.js";
import { zaloSetupAdapter } from "./setup-core.js";
import { zaloSetupWizard } from "./setup-surface.js";
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

const loadZaloChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const zaloConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveZaloAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedZaloAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
});

const zaloConfigBase = createScopedChannelConfigBase<ResolvedZaloAccount>({
  sectionKey: "zalo",
  listAccountIds: listZaloAccountIds,
  resolveAccount: (cfg, accountId) => resolveZaloAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultZaloAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
});

const resolveZaloDmPolicy = createScopedDmSecurityResolver<ResolvedZaloAccount>({
  channelKey: "zalo",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.replace(/^(zalo|zl):/i, ""),
});

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount> = {
  id: "zalo",
  meta,
  setup: zaloSetupAdapter,
  setupWizard: zaloSetupWizard,
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
    ...zaloConfigBase,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    ...zaloConfigAccessors,
  },
  security: {
    resolveDmPolicy: resolveZaloDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      return collectOpenProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.zalo !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) => {
          if (groupPolicy !== "open") {
            return [];
          }
          const explicitGroupAllowFrom = mapAllowFromEntries(account.config.groupAllowFrom);
          const dmAllowFrom = mapAllowFromEntries(account.config.allowFrom);
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
              remediation:
                'Set channels.zalo.groupPolicy="allowlist" + channels.zalo.groupAllowFrom',
            }),
          ];
        },
      });
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
  pairing: {
    idLabel: "zaloUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalo|zl):/i, ""),
    notifyApproval: async (params) =>
      await (await loadZaloChannelRuntime()).notifyZaloPairingApproval(params),
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
      const result = await (
        await loadZaloChannelRuntime()
      ).sendZaloText({
        to,
        text,
        accountId: accountId ?? undefined,
        cfg: cfg,
      });
      return buildChannelSendResult("zalo", result);
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const result = await (
        await loadZaloChannelRuntime()
      ).sendZaloText({
        to,
        text,
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
      await (await loadZaloChannelRuntime()).probeZaloAccount({ account, timeoutMs }),
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
    startAccount: async (ctx) =>
      await (await loadZaloChannelRuntime()).startZaloGatewayAccount(ctx),
  },
};
