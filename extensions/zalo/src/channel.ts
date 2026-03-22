import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  createOpenProviderGroupPolicyWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { listResolvedDirectoryUserEntriesFromAllowFrom } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
  type ResolvedZaloAccount,
} from "./accounts.js";
import { zaloMessageActions } from "./actions.js";
import { ZaloConfigSchema } from "./config-schema.js";
import type { ZaloProbeResult } from "./probe.js";
import {
  buildBaseAccountStatusSnapshot,
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  formatAllowFromLowercase,
  listDirectoryUserEntriesFromAllowFrom,
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./runtime-api.js";
import { resolveZaloOutboundSessionRoute } from "./session-route.js";
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
  return trimmed.replace(/^(zalo|zl):/i, "").trim();
}

const loadZaloChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
const zaloTextChunkLimit = 2000;

const zaloRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: "zalo",
  sendText: async ({ to, text, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      to,
      text,
      accountId: accountId ?? undefined,
      cfg,
    }),
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      to,
      text,
      accountId: accountId ?? undefined,
      mediaUrl,
      cfg,
    }),
});

const zaloConfigAdapter = createScopedChannelConfigAdapter<ResolvedZaloAccount>({
  sectionKey: "zalo",
  listAccountIds: listZaloAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  defaultAccountId: resolveDefaultZaloAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account: ResolvedZaloAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
});

const resolveZaloDmPolicy = createScopedDmSecurityResolver<ResolvedZaloAccount>({
  channelKey: "zalo",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.trim().replace(/^(zalo|zl):/i, ""),
});

const collectZaloSecurityWarnings = createOpenProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
  account: ResolvedZaloAccount;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.zalo !== undefined,
  resolveGroupPolicy: ({ account }) => account.config.groupPolicy,
  collect: ({ account, groupPolicy }) => {
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
        remediation: 'Set channels.zalo.groupPolicy="allowlist" + channels.zalo.groupAllowFrom',
      }),
    ];
  },
});

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount, ZaloProbeResult> =
  createChatChannelPlugin({
    base: {
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
        ...zaloConfigAdapter,
        isConfigured: (account) => Boolean(account.token?.trim()),
        describeAccount: (account): ChannelAccountSnapshot =>
          describeAccountSnapshot({
            account,
            configured: Boolean(account.token?.trim()),
            extra: {
              tokenSource: account.tokenSource,
            },
          }),
      },
      groups: {
        resolveRequireMention: () => true,
      },
      actions: zaloMessageActions,
      messaging: {
        normalizeTarget: normalizeZaloMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveZaloOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: isNumericTargetId,
          hint: "<chatId>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) =>
          listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedZaloAccount>({
            ...params,
            resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
            resolveAllowFrom: (account) => account.config.allowFrom,
            normalizeId: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
          }),
        listGroups: async () => [],
      }),
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
          return buildBaseAccountStatusSnapshot(
            {
              account: {
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured,
              },
              runtime,
            },
            {
              tokenSource: account.tokenSource,
              mode: account.config.webhookUrl ? "webhook" : "polling",
              dmPolicy: account.config.dmPolicy ?? "pairing",
            },
          );
        },
      },
      gateway: {
        startAccount: async (ctx) =>
          await (await loadZaloChannelRuntime()).startZaloGatewayAccount(ctx),
      },
    },
    security: {
      resolveDmPolicy: resolveZaloDmPolicy,
      collectWarnings: collectZaloSecurityWarnings,
    },
    pairing: {
      idLabel: "zaloUserId",
      normalizeAllowEntry: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
      notifyApproval: async (params) =>
        await (await loadZaloChannelRuntime()).notifyZaloPairingApproval(params),
    },
    threading: {
      resolveReplyToMode: createStaticReplyToModeResolver("off"),
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "text",
      textChunkLimit: zaloTextChunkLimit,
      sendPayload: async (ctx) =>
        await sendPayloadWithChunkedTextAndMedia({
          ctx,
          textChunkLimit: zaloTextChunkLimit,
          chunker: chunkTextForOutbound,
          sendText: (nextCtx) => zaloRawSendResultAdapter.sendText!(nextCtx),
          sendMedia: (nextCtx) => zaloRawSendResultAdapter.sendMedia!(nextCtx),
          emptyResult: createEmptyChannelResult("zalo"),
        }),
      ...zaloRawSendResultAdapter,
    },
  });
