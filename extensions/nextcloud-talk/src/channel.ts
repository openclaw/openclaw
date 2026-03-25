import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { monitorNextcloudTalkProvider } from "./monitor.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
} from "./normalize.js";
import { resolveNextcloudTalkGroupToolPolicy } from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
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
          describeAccountSnapshot({
            account,
            configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
            extra: {
              secretSource: account.secretSource,
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
            },
          }),
      },
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
      setup: nextcloudTalkSetupAdapter,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            secretSource: snapshot.secretSource ?? "none",
            mode: "webhook",
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
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          if (!account.secret || !account.baseUrl) {
            throw new Error(
              `Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`,
            );
          }

          ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk webhook server`);

          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });

          await runStoppablePassiveMonitor({
            abortSignal: ctx.abortSignal,
            start: async () =>
              await monitorNextcloudTalkProvider({
                accountId: account.accountId,
                config: ctx.cfg as CoreConfig,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
                statusSink,
              }),
          });
        },
        logoutAccount: async ({ accountId, cfg }) => {
          const nextCfg = { ...cfg } as OpenClawConfig;
          const nextSection = cfg.channels?.["nextcloud-talk"]
            ? { ...cfg.channels["nextcloud-talk"] }
            : undefined;
          let cleared = false;
          let changed = false;

          if (nextSection) {
            if (accountId === DEFAULT_ACCOUNT_ID && nextSection.botSecret) {
              delete nextSection.botSecret;
              cleared = true;
              changed = true;
            }
            const accountCleanup = clearAccountEntryFields({
              accounts: nextSection.accounts,
              accountId,
              fields: ["botSecret"],
            });
            if (accountCleanup.changed) {
              changed = true;
              if (accountCleanup.cleared) {
                cleared = true;
              }
              if (accountCleanup.nextAccounts) {
                nextSection.accounts = accountCleanup.nextAccounts;
              } else {
                delete nextSection.accounts;
              }
            }
          }

          if (changed) {
            if (nextSection && Object.keys(nextSection).length > 0) {
              nextCfg.channels = { ...nextCfg.channels, "nextcloud-talk": nextSection };
            } else {
              const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
              delete nextChannels["nextcloud-talk"];
              if (Object.keys(nextChannels).length > 0) {
                nextCfg.channels = nextChannels as OpenClawConfig["channels"];
              } else {
                delete nextCfg.channels;
              }
            }
          }

          const resolved = resolveNextcloudTalkAccount({
            cfg: changed ? (nextCfg as CoreConfig) : (cfg as CoreConfig),
            accountId,
          });
          const loggedOut = resolved.secretSource === "none";

          if (changed) {
            await getNextcloudTalkRuntime().config.writeConfigFile(nextCfg);
          }

          return {
            cleared,
            envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
            loggedOut,
          };
        },
      },
    },
    pairing: {
      text: {
        idLabel: "nextcloudUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: createPairingPrefixStripper(
          /^(nextcloud-talk|nc-talk|nc):/i,
          (entry) => entry.toLowerCase(),
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
