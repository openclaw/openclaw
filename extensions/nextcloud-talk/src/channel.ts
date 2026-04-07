import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "./channel-api.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { nextcloudTalkGatewayAdapter } from "./gateway.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
} from "./normalize.js";
import { resolveNextcloudTalkGroupToolPolicy } from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import { nextcloudTalkSetupAdapter } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const meta = {
  id: "nextcloud-talk",
  label: "Nextcloud Talk",
  selectionLabel: "Nextcloud Talk (self-hosted)",
  docsPath: "/channels/nextcloud-talk",
  docsLabel: "nextcloud-talk",
  blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
  aliases: ["nc-talk", "nc"],
  order: 65,
  quickstartAllowFrom: true,
};

const nextcloudTalkConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedNextcloudTalkAccount,
  ResolvedNextcloudTalkAccount,
  CoreConfig
>({
  sectionKey: "nextcloud-talk",
  listAccountIds: listNextcloudTalkAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
  defaultAccountId: resolveDefaultNextcloudTalkAccountId,
  clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
    }),
});

const resolveNextcloudTalkDmPolicy = createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
  channelKey: "nextcloud-talk",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
      .trim()
      .toLowerCase(),
});

const collectNextcloudTalkSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedNextcloudTalkAccount>({
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
    restrictSenders: {
      surface: "Nextcloud Talk rooms",
      openScope: "any member in allowed rooms",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Nextcloud Talk rooms",
      routeAllowlistPath: "channels.nextcloud-talk.rooms",
      routeScope: "room",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
  });

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> =
  createChatChannelPlugin({
    base: {
      id: "nextcloud-talk",
      meta,
      setupWizard: nextcloudTalkSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        reactions: true,
        threads: false,
        media: true,
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.nextcloud-talk"] },
      configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
      config: {
        ...nextcloudTalkConfigAdapter,
        isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
        describeAccount: (account) =>
          describeWebhookAccountSnapshot({
            account,
            configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
            extra: {
              secretSource: account.secretSource,
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
            },
          }),
      },
      auth: nextcloudTalkApprovalAuth,
      doctor: nextcloudTalkDoctor,
      groups: {
        resolveRequireMention: ({ cfg, accountId, groupId }) => {
          const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
          const rooms = account.config.rooms;
          if (!rooms || !groupId) {
            return true;
          }

          const roomConfig = rooms[groupId];
          if (roomConfig?.requireMention !== undefined) {
            return roomConfig.requireMention;
          }

          const wildcardConfig = rooms["*"];
          if (wildcardConfig?.requireMention !== undefined) {
            return wildcardConfig.requireMention;
          }

          return true;
        },
        resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
      },
      messaging: {
        normalizeTarget: normalizeNextcloudTalkMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveNextcloudTalkOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeNextcloudTalkTargetId,
          hint: "<roomToken>",
        },
      },
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      setup: nextcloudTalkSetupAdapter,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) =>
          buildWebhookChannelStatusSummary(snapshot, {
            secretSource: snapshot.secretSource ?? "none",
          }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
          extra: {
            secretSource: account.secretSource,
            baseUrl: account.baseUrl ? "[set]" : "[missing]",
            mode: "webhook",
          },
        }),
      }),
      gateway: nextcloudTalkGatewayAdapter,
    },
    pairing: {
      text: {
        idLabel: "nextcloudUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: createPairingPrefixStripper(
          /^(nextcloud-talk|nc-talk|nc):/i,
          (entry) => normalizeLowercaseStringOrEmpty(entry),
        ),
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      resolveDmPolicy: resolveNextcloudTalkDmPolicy,
      collectWarnings: collectNextcloudTalkSecurityWarnings,
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) =>
          getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        textChunkLimit: 4000,
      },
      attachedResults: {
        channel: "nextcloud-talk",
        sendText: async ({ cfg, to, text, accountId, replyToId }) =>
          await sendMessageNextcloudTalk(to, text, {
            accountId: accountId ?? undefined,
            replyTo: replyToId ?? undefined,
            cfg: cfg as CoreConfig,
          }),
        sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
          await sendMessageNextcloudTalk(
            to,
            mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text,
            {
              accountId: accountId ?? undefined,
              replyTo: replyToId ?? undefined,
              cfg: cfg as CoreConfig,
            },
          ),
      },
    },
  });
