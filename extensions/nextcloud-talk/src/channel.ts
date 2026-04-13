import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  listEnabledNextcloudTalkAccounts,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "./channel-api.js";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
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
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
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

function describeNextcloudTalkMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = listEnabledNextcloudTalkAccounts(cfg as CoreConfig).filter((account) =>
    Boolean(account.secret?.trim() && account.baseUrl?.trim()),
  );

  const actions: ChannelMessageActionName[] = [];
  if (enabledAccounts.length > 0) {
    actions.push("send");
    actions.push("react");
    actions.push("edit");
  }

  return { actions, capabilities: [], schema: null };
}

// Nextcloud Talk's bot API has no in-place edit endpoint. The edit action is
// implemented as a re-post prefixed with this header and threaded as a reply
// to the original message id.
const NEXTCLOUD_TALK_EDIT_HEADER =
  "> Edited update — Nextcloud Talk does not support editing bot messages in place.";

function parseNextcloudTalkReactActionParams(params: Record<string, unknown>): {
  roomToken: string;
  messageId: string;
  emoji: string;
} {
  const roomToken = normalizeOptionalString(params.to) ?? normalizeOptionalString(params.target);
  if (!roomToken) {
    throw new Error("Nextcloud Talk react requires a target (to) room token.");
  }

  const messageId = normalizeOptionalString(params.messageId);
  if (!messageId) {
    throw new Error("Nextcloud Talk react requires messageId.");
  }

  const emoji = normalizeOptionalString(params.emoji)?.replace(/^:+|:+$/g, "");
  if (!emoji) {
    throw new Error("Nextcloud Talk react requires emoji.");
  }

  return { roomToken, messageId, emoji };
}

function parseNextcloudTalkEditActionParams(params: Record<string, unknown>): {
  roomToken: string;
  originalMessageId: string;
  message: string;
} {
  const roomToken = normalizeOptionalString(params.to) ?? normalizeOptionalString(params.target);
  if (!roomToken) {
    throw new Error("Nextcloud Talk edit requires a target (to) room token.");
  }

  const originalMessageId = normalizeOptionalString(params.messageId);
  if (!originalMessageId) {
    throw new Error("Nextcloud Talk edit requires messageId.");
  }

  const message = normalizeOptionalString(params.message);
  if (!message) {
    throw new Error("Nextcloud Talk edit requires message.");
  }

  return { roomToken, originalMessageId, message };
}

const nextcloudTalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeNextcloudTalkMessageTool,
  // Send stays on outbound.attachedResults; only react + edit need plugin dispatch here.
  // Delete is intentionally unsupported — callers should send a follow-up note instead.
  supportsAction: ({ action }) => action === "react" || action === "edit",
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "react") {
      const { roomToken, messageId, emoji } = parseNextcloudTalkReactActionParams(params);
      await sendReactionNextcloudTalk(roomToken, messageId, emoji, {
        accountId: accountId ?? undefined,
        cfg: cfg as CoreConfig,
      });
      return {
        content: [{ type: "text" as const, text: `Reacted ${emoji} on ${messageId}` }],
        details: {},
      };
    }

    if (action === "edit") {
      const { roomToken, originalMessageId, message } = parseNextcloudTalkEditActionParams(params);
      const prefixed = `${NEXTCLOUD_TALK_EDIT_HEADER}\n\n${message}`;
      const result = await sendMessageNextcloudTalk(roomToken, prefixed, {
        accountId: accountId ?? undefined,
        replyTo: originalMessageId,
        cfg: cfg as CoreConfig,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              channel: "nextcloud-talk",
              messageId: result.messageId,
              originalMessageId,
              replacedAsReply: true,
            }),
          },
        ],
        details: {},
      };
    }

    throw new Error(`Unsupported Nextcloud Talk action: ${action}`);
  },
};

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
        nativeCommands: true,
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
      approvalCapability: nextcloudTalkApprovalAuth,
      actions: nextcloudTalkMessageActions,
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
        ...nextcloudTalkPairingTextAdapter,
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      ...nextcloudTalkSecurityAdapter,
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
