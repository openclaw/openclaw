import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
} from "openclaw/plugin-sdk/channel-policy";
import { runStoppablePassiveMonitor } from "../../shared/passive-monitor.js";
import {
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  buildRuntimeAccountStatusSnapshot,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
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

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> = {
  id: "nextcloud-talk",
  meta,
  setupWizard: nextcloudTalkSetupWizard,
  pairing: {
    idLabel: "nextcloudUserId",
    normalizeAllowEntry: (entry) =>
      entry.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      console.log(`[nextcloud-talk] User ${id} approved for pairing`);
    },
  },
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
    listAccountIds: (cfg) => listNextcloudTalkAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "nextcloud-talk",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "nextcloud-talk",
        accountId,
        clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
      secretSource: account.secretSource,
      baseUrl: account.baseUrl ? "[set]" : "[missing]",
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      mapAllowFromEntries(
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
      ).map((entry) => entry.toLowerCase()),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({
        allowFrom,
        stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
      }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "nextcloud-talk",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => raw.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase(),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const roomAllowlistConfigured =
        account.config.rooms && Object.keys(account.config.rooms).length > 0;
      return collectAllowlistProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent:
          (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyRouteAllowlistWarnings({
            groupPolicy,
            routeAllowlistConfigured: Boolean(roomAllowlistConfigured),
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
          }),
      });
    },
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
    targetResolver: {
      looksLikeId: looksLikeNextcloudTalkTargetId,
      hint: "<roomToken>",
    },
  },
  setup: nextcloudTalkSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const result = await sendMessageNextcloudTalk(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg: cfg as CoreConfig,
      });
      return { channel: "nextcloud-talk", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
      const messageWithMedia = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageNextcloudTalk(to, messageWithMedia, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg: cfg as CoreConfig,
      });
      return { channel: "nextcloud-talk", ...result };
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
    buildChannelSummary: ({ snapshot }) => {
      const base = buildBaseChannelStatusSummary(snapshot);
      return {
        configured: base.configured,
        secretSource: snapshot.secretSource ?? "none",
        running: base.running,
        mode: "webhook",
        lastStartAt: base.lastStartAt,
        lastStopAt: base.lastStopAt,
        lastError: base.lastError,
      };
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.secret?.trim() && account.baseUrl?.trim());
      const runtimeSnapshot = buildRuntimeAccountStatusSnapshot({ runtime });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        secretSource: account.secretSource,
        baseUrl: account.baseUrl ? "[set]" : "[missing]",
        running: runtimeSnapshot.running,
        lastStartAt: runtimeSnapshot.lastStartAt,
        lastStopAt: runtimeSnapshot.lastStopAt,
        lastError: runtimeSnapshot.lastError,
        mode: "webhook",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
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
};
