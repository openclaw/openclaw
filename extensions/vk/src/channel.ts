import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { createRawChannelSendResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  buildTokenChannelStatusSummary,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/channel-status";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listVkAccountIds,
  resolveDefaultVkAccountId,
  resolveVkAccount,
  type ResolvedVkAccount,
} from "./accounts.js";
import {
  startVkGatewayAccount,
  notifyVkPairingApproval,
  sendVkTextFromRuntime,
} from "./channel.runtime.js";
import { VkConfigSchema } from "./config-schema.js";
import { probeVkAccount } from "./probe.js";
import { resolveVkOutboundSessionRoute } from "./session-route.js";
import { vkSetupAdapter } from "./setup-core.js";
import { vkSetupWizard } from "./setup-surface.js";
import type { VkProbeResult } from "./types.js";

function normalizeVkTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^vk:/i, "").trim();
}

const vkConfigAdapter = createScopedChannelConfigAdapter<ResolvedVkAccount>({
  sectionKey: "vk",
  listAccountIds: listVkAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveVkAccount),
  defaultAccountId: resolveDefaultVkAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => String(entry).trim().replace(/^vk:/i, "")).filter(Boolean),
});

const resolveVkDmPolicy = createScopedDmSecurityResolver<ResolvedVkAccount>({
  channelKey: "vk",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  normalizeEntry: (raw) => raw.trim().replace(/^vk:/i, ""),
});

const vkRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: "vk",
  sendText: async ({ to, text, accountId, cfg }) =>
    await sendVkTextFromRuntime({
      to,
      text,
      accountId: accountId ?? undefined,
      cfg,
    }),
});

export const vkPlugin: ChannelPlugin<ResolvedVkAccount, VkProbeResult> = createChatChannelPlugin({
  base: {
    id: "vk",
    meta: {
      id: "vk",
      label: "VK",
      selectionLabel: "VK (Long Poll API)",
      detailLabel: "VK Group Bot",
      docsPath: "/channels/vk",
      docsLabel: "vk",
      blurb: "VK group bot via Long Poll API for direct-message routing.",
      order: 85,
      quickstartAllowFrom: true,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      reactions: false,
      threads: false,
      polls: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.vk"] },
    configSchema: buildChannelConfigSchema(VkConfigSchema),
    setup: vkSetupAdapter,
    setupWizard: vkSetupWizard,
    config: {
      ...vkConfigAdapter,
      isConfigured: (account) => Boolean(account.token.trim()),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.token.trim()),
          extra: {
            tokenSource: account.tokenSource,
          },
        }),
    },
    messaging: {
      normalizeTarget: normalizeVkTarget,
      resolveOutboundSessionRoute: (params) => resolveVkOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: (raw) => {
          const trimmed = raw.trim().replace(/^vk:/i, "");
          if (!trimmed) {
            return false;
          }
          return /^(group:|chat:)?\d+$/i.test(trimmed);
        },
        hint: "<userId|group:peerId>",
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) =>
        await listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedVkAccount>({
          ...params,
          resolveAccount: adaptScopedAccountAccessor(resolveVkAccount),
          resolveAllowFrom: (account) => account.config.allowFrom,
          normalizeId: (entry) => entry.trim().replace(/^vk:/i, ""),
        }),
      listGroups: async () => [],
    }),
    status: createComputedAccountStatusAdapter<ResolvedVkAccount, VkProbeResult>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) => await probeVkAccount({ account, timeoutMs }),
      resolveAccountSnapshot: ({ account, runtime, probe }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token.trim()),
        extra: {
          tokenSource: account.tokenSource,
          connected: runtime?.connected ?? false,
          lastConnectedAt: runtime?.lastConnectedAt ?? null,
          lastDisconnect: runtime?.lastDisconnect ?? null,
          lastError: runtime?.lastError ?? null,
          profile: probe && probe.ok ? probe.group : runtime?.profile,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => await startVkGatewayAccount(ctx),
    },
  },
  security: {
    resolveDmPolicy: resolveVkDmPolicy,
  },
  pairing: {
    text: {
      idLabel: "vkUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => entry.trim().replace(/^vk:/i, ""),
      notify: async ({ cfg, id }) => await notifyVkPairingApproval({ cfg, id }),
    },
  },
  threading: {
    resolveReplyToMode: createStaticReplyToModeResolver("off"),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    ...vkRawSendResultAdapter,
  },
});
