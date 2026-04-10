import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import {
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  buildRuntimeAccountStatusSnapshot,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  listRoamAccountIds,
  resolveDefaultRoamAccountId,
  resolveRoamAccount,
  type ResolvedRoamAccount,
} from "./accounts.js";
import { RoamConfigSchema } from "./config-schema.js";
import { monitorRoamProvider } from "./monitor.js";
import { looksLikeRoamTargetId, normalizeRoamMessagingTarget } from "./normalize.js";
import { resolveRoamGroupToolPolicy } from "./policy.js";
import { getRoamRuntime } from "./runtime.js";
import { sendMessageRoam } from "./send.js";
import { resolveRoamOutboundSessionRoute } from "./session-route.js";
import { roamSetupAdapter } from "./setup-core.js";
import { roamSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const meta = {
  id: "roam",
  label: "Roam",
  selectionLabel: "Roam HQ (plugin)",
  docsPath: "/channels/roam",
  docsLabel: "roam",
  blurb: "Roam HQ team messaging; install the plugin to enable.",
  aliases: ["roam-hq"],
  order: 66,
  quickstartAllowFrom: true,
};

const roamConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedRoamAccount,
  ResolvedRoamAccount,
  CoreConfig
>({
  sectionKey: "roam",
  listAccountIds: listRoamAccountIds,
  resolveAccount: (cfg, accountId) => resolveRoamAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultRoamAccountId,
  clearBaseFields: ["apiKey", "apiKeyFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(roam|roam-hq):/i,
    }),
});

const resolveRoamDmPolicy = createScopedDmSecurityResolver<ResolvedRoamAccount>({
  channelKey: "roam",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.replace(/^(roam|roam-hq):/i, "").toLowerCase(),
});

const collectRoamSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedRoamAccount>({
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.roam !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
    restrictSenders: {
      surface: "Roam groups",
      openScope: "any member in allowed groups",
      groupPolicyPath: "channels.roam.groupPolicy",
      groupAllowFromPath: "channels.roam.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Roam groups",
      routeAllowlistPath: "channels.roam.groups",
      routeScope: "group",
      groupPolicyPath: "channels.roam.groupPolicy",
      groupAllowFromPath: "channels.roam.groupAllowFrom",
    },
  });

export const roamPlugin: ChannelPlugin<ResolvedRoamAccount> = {
  id: "roam",
  meta,
  setupWizard: roamSetupWizard,
  pairing: {
    idLabel: "roamUserId",
    normalizeAllowEntry: createPairingPrefixStripper(/^(roam|roam-hq):/i, (entry) =>
      entry.toLowerCase(),
    ),
    notifyApproval: createLoggedPairingApprovalNotifier(
      ({ id }) => `[roam] User ${id} approved for pairing`,
    ),
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: true,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.roam"] },
  configSchema: buildChannelConfigSchema(RoamConfigSchema),
  config: {
    ...roamConfigAdapter,
    isConfigured: (account) => Boolean(account.apiKey?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiKey?.trim()),
      apiKeySource: account.apiKeySource,
    }),
  },
  security: {
    resolveDmPolicy: resolveRoamDmPolicy,
    collectWarnings: collectRoamSecurityWarnings,
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveRoamAccount({ cfg: cfg as CoreConfig, accountId });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return true;
      }

      const groupConfig = groups[groupId];
      if (groupConfig?.requireMention !== undefined) {
        return groupConfig.requireMention;
      }

      const wildcardConfig = groups["*"];
      if (wildcardConfig?.requireMention !== undefined) {
        return wildcardConfig.requireMention;
      }

      return true;
    },
    resolveToolPolicy: resolveRoamGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeRoamMessagingTarget,
    resolveOutboundSessionRoute: (params) => resolveRoamOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeRoamTargetId,
      hint: "<UUID> (e.g. 01234567-abcd-4000-8000-000000000000)",
    },
  },
  setup: roamSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getRoamRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 8000,
    ...createAttachedChannelResultAdapter({
      channel: "roam",
      sendText: async ({ cfg, to, text, accountId }) => {
        const result = await sendMessageRoam(to, text, {
          accountId: accountId ?? undefined,
          cfg: cfg as CoreConfig,
        });
        return { messageId: result.chatId };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
        const result = await sendMessageRoam(
          to,
          mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text,
          {
            accountId: accountId ?? undefined,
            cfg: cfg as CoreConfig,
          },
        );
        return { messageId: result.chatId };
      },
    }),
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
        running: base.running,
        mode: "webhook",
        lastStartAt: base.lastStartAt,
        lastStopAt: base.lastStopAt,
        lastError: base.lastError,
      };
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.apiKey?.trim());
      const runtimeSnapshot = buildRuntimeAccountStatusSnapshot({ runtime });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        apiKeySource: account.apiKeySource,
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
      if (!account.apiKey) {
        throw new Error(`Roam not configured for account "${account.accountId}" (missing API key)`);
      }

      ctx.log?.info(`[${account.accountId}] starting Roam webhook monitor`);

      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });

      await runStoppablePassiveMonitor({
        abortSignal: ctx.abortSignal,
        start: async () =>
          await monitorRoamProvider({
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
      const nextSection = cfg.channels?.roam ? { ...cfg.channels.roam } : undefined;
      let cleared = false;
      let changed = false;

      if (nextSection) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextSection.apiKey) {
          delete nextSection.apiKey;
          cleared = true;
          changed = true;
        }
        const accountCleanup = clearAccountEntryFields({
          accounts: nextSection.accounts,
          accountId,
          fields: ["apiKey"],
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
          nextCfg.channels = { ...nextCfg.channels, roam: nextSection };
        } else {
          const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
          delete nextChannels.roam;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels as OpenClawConfig["channels"];
          } else {
            delete nextCfg.channels;
          }
        }
      }

      const resolved = resolveRoamAccount({
        cfg: changed ? (nextCfg as CoreConfig) : (cfg as CoreConfig),
        accountId,
      });
      const loggedOut = resolved.apiKeySource === "none";

      if (changed) {
        await getRoamRuntime().config.writeConfigFile(nextCfg);
      }

      return {
        cleared,
        envSecret: Boolean(process.env.ROAM_API_KEY?.trim()),
        loggedOut,
      };
    },
  },
};
