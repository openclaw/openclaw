import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  composeAccountWarningCollectors,
  composeWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  resolveIrcAccount,
  type ResolvedIrcAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  createAccountStatusSink,
  chunkTextForOutbound,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { IrcChannelConfigSchema } from "./config-schema.js";
import { collectIrcMutableAllowlistWarnings } from "./doctor.js";
import { monitorIrcProvider } from "./monitor.js";
import {
  normalizeIrcMessagingTarget,
  looksLikeIrcTargetId,
  isChannelTarget,
  normalizeIrcAllowEntry,
} from "./normalize.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { probeIrc } from "./probe.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
import { ircSetupAdapter } from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig, IrcProbe } from "./types.js";

const meta = getChatChannelMeta("irc");

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeIrcAllowEntry(raw);
  if (!normalized) {
    return "";
  }
  return normalized.split(/[!@]/, 1)[0]?.trim() ?? "";
}

const listIrcDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "user",
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.allowFrom ?? [],
    account.config.groupAllowFrom ?? [],
    ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
  ],
  normalizeId: (entry) => normalizePairingTarget(entry) || null,
});

const listIrcDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "group",
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.channels ?? [],
    Object.keys(account.config.groups ?? {}),
  ],
  normalizeId: (entry) => {
    const normalized = normalizeIrcMessagingTarget(entry);
    return normalized && isChannelTarget(normalized) ? normalized : null;
  },
});

const ircConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedIrcAccount,
  ResolvedIrcAccount,
  CoreConfig
>({
  sectionKey: "irc",
  listAccountIds: listIrcAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  defaultAccountId: resolveDefaultIrcAccountId,
  clearBaseFields: [
    "name",
    "host",
    "port",
    "tls",
    "nick",
    "username",
    "realname",
    "password",
    "passwordFile",
    "channels",
  ],
  resolveAllowFrom: (account: ResolvedIrcAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeIrcAllowEntry,
    }),
  resolveDefaultTo: (account: ResolvedIrcAccount) => account.config.defaultTo,
});

const resolveIrcDmPolicy = createScopedDmSecurityResolver<ResolvedIrcAccount>({
  channelKey: "irc",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeIrcAllowEntry(raw),
});

const collectIrcGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedIrcAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.irc !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "IRC channels",
      openBehavior: "allows all channels and senders (mention-gated)",
      remediation: 'Prefer channels.irc.groupPolicy="allowlist" with channels.irc.groups',
    },
  });

const collectIrcSecurityWarnings = composeAccountWarningCollectors<
  ResolvedIrcAccount,
  {
    account: ResolvedIrcAccount;
    cfg: CoreConfig;
  }
>(
  collectIrcGroupPolicyWarnings,
  (account) =>
    !account.config.tls &&
    "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.",
  (account) =>
    account.config.nickserv?.register &&
    '- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends "REGISTER" on every connect. Disable after first successful registration.',
  (account) =>
    account.config.nickserv?.register &&
    !account.config.nickserv.password?.trim() &&
    "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.",
);

export const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe> = createChatChannelPlugin({
  base: {
    id: "irc",
    meta: {
      ...meta,
      quickstartAllowFrom: true,
    },
    setup: ircSetupAdapter,
    setupWizard: ircSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.irc"] },
    configSchema: IrcChannelConfigSchema,
    config: {
      ...ircConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            host: account.host,
            port: account.port,
            tls: account.tls,
            nick: account.nick,
            passwordSource: account.passwordSource,
          },
        }),
    },
    doctor: {
      groupAllowFromFallbackToAllowFrom: false,
      collectMutableAllowlistWarnings: collectIrcMutableAllowlistWarnings,
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return true;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return resolveIrcRequireMention({
          groupConfig: match.groupConfig,
          wildcardConfig: match.wildcardConfig,
        });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return undefined;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
      },
    },
    messaging: {
      normalizeTarget: normalizeIrcMessagingTarget,
      targetResolver: {
        looksLikeId: looksLikeIrcTargetId,
        hint: "<#channel|nick>",
      },
    },
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        return inputs.map((input) => {
          const normalized = normalizeIrcMessagingTarget(input);
          if (!normalized) {
            return {
              input,
              resolved: false,
              note: "invalid IRC target",
            };
          }
          if (kind === "group") {
            const groupId = isChannelTarget(normalized) ? normalized : `#${normalized}`;
            return {
              input,
              resolved: true,
              id: groupId,
              name: groupId,
            };
          }
          if (isChannelTarget(normalized)) {
            return {
              input,
              resolved: false,
              note: "expected user target",
            };
          }
          return {
            input,
            resolved: true,
            id: normalized,
            name: normalized,
          };
        });
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listIrcDirectoryPeersFromConfig(params),
      listGroups: async (params) => {
        const entries = await listIrcDirectoryGroupsFromConfig(params);
        return entries.map((entry) => ({ ...entry, name: entry.id }));
      },
    }),
    status: createComputedAccountStatusAdapter<ResolvedIrcAccount, IrcProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        host: account.host,
        port: snapshot.port,
        tls: account.tls,
        nick: account.nick,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      probeAccount: async ({ cfg, account, timeoutMs }) =>
        probeIrc(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          host: account.host,
          port: account.port,
          tls: account.tls,
          nick: account.nick,
          passwordSource: account.passwordSource,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const statusSink = createAccountStatusSink({
          accountId: ctx.accountId,
          setStatus: ctx.setStatus,
        });
        if (!account.configured) {
          throw new Error(
            `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
          );
        }
        ctx.log?.info(
          `[${account.accountId}] starting IRC provider (${account.host}:${account.port}${account.tls ? " tls" : ""})`,
        );
        await runStoppablePassiveMonitor({
          abortSignal: ctx.abortSignal,
          start: async () =>
            await monitorIrcProvider({
              accountId: account.accountId,
              config: ctx.cfg as CoreConfig,
              runtime: ctx.runtime,
              abortSignal: ctx.abortSignal,
              statusSink,
            }),
        });
      },
    },
  },
  pairing: {
    text: {
      idLabel: "ircUser",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => normalizeIrcAllowEntry(entry),
      notify: async ({ id, message }) => {
        const target = normalizePairingTarget(id);
        if (!target) {
          throw new Error(`invalid IRC pairing id: ${id}`);
        }
        await sendMessageIrc(target, message);
      },
    },
  },
  security: {
    resolveDmPolicy: resolveIrcDmPolicy,
    collectWarnings: collectIrcSecurityWarnings,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 350,
      sanitizeText: ({ text }) => sanitizeForPlainText(text),
    },
    attachedResults: {
      channel: "irc",
      sendText: async ({ cfg, to, text, accountId, replyToId }) =>
        await sendMessageIrc(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        }),
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
        await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        }),
    },
  },
});
