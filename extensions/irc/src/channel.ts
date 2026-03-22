import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createTextPairingAdapter } from "openclaw/plugin-sdk/channel-pairing";
import {
  composeWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/directory-runtime";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import {
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  resolveIrcAccount,
  type ResolvedIrcAccount,
} from "./accounts.js";
import { IrcConfigSchema } from "./config-schema.js";
import { monitorIrcProvider } from "./monitor.js";
import {
  normalizeIrcMessagingTarget,
  looksLikeIrcTargetId,
  isChannelTarget,
  normalizeIrcAllowEntry,
} from "./normalize.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { probeIrc } from "./probe.js";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  createAccountStatusSink,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./runtime-api.js";
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

const collectIrcSecurityWarnings = composeWarningCollectors<{
  account: ResolvedIrcAccount;
  cfg: CoreConfig;
}>(
  collectIrcGroupPolicyWarnings,
  createConditionalWarningCollector(
    ({ account }) =>
      !account.config.tls &&
      "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.",
    ({ account }) =>
      account.config.nickserv?.register &&
      '- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends "REGISTER" on every connect. Disable after first successful registration.',
    ({ account }) =>
      account.config.nickserv?.register &&
      !account.config.nickserv.password?.trim() &&
      "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.",
  ),
);

export const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe> = {
  id: "irc",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  setup: ircSetupAdapter,
  setupWizard: ircSetupWizard,
  pairing: createTextPairingAdapter({
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
  }),
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.irc"] },
  configSchema: buildChannelConfigSchema(IrcConfigSchema),
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
  security: {
    resolveDmPolicy: resolveIrcDmPolicy,
    collectWarnings: collectIrcSecurityWarnings,
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
    listPeers: async (params) =>
      listResolvedDirectoryEntriesFromSources<ResolvedIrcAccount>({
        ...params,
        kind: "user",
        resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
        resolveSources: (account) => [
          account.config.allowFrom ?? [],
          account.config.groupAllowFrom ?? [],
          ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
        ],
        normalizeId: (entry) => normalizePairingTarget(entry) || null,
      }),
    listGroups: async (params) => {
      const entries = listResolvedDirectoryEntriesFromSources<ResolvedIrcAccount>({
        ...params,
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
      return entries.map((entry) => ({ ...entry, name: entry.id }));
    },
  }),
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIrcRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 350,
    ...createAttachedChannelResultAdapter({
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
    buildAccountSnapshot: ({ account, runtime, probe }) =>
      buildBaseAccountStatusSnapshot(
        { account, runtime, probe },
        {
          host: account.host,
          port: account.port,
          tls: account.tls,
          nick: account.nick,
          passwordSource: account.passwordSource,
        },
      ),
  },
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
};
