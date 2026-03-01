import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
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
import { ircOnboardingAdapter } from "./onboarding.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { probeIrc } from "./probe.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig, IrcProbe } from "./types.js";

const meta = getChatChannelMeta("irc");

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeIrcAllowEntry(raw);
  if (!normalized) {
    return "";
  }
  return normalized.split(/[!@]/, 1)[0]?.trim() ?? "";
}

export const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe> = {
  id: "irc",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: ircOnboardingAdapter,
  pairing: {
    idLabel: "ircUser",
    normalizeAllowEntry: (entry) => normalizeIrcAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      const target = normalizePairingTarget(id);
      if (!target) {
        throw new Error(`invalid IRC pairing id: ${id}`);
      }
      await sendMessageIrc(target, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.irc"] },
  configSchema: buildChannelConfigSchema(IrcConfigSchema),
  config: {
    listAccountIds: (cfg) => listIrcAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultIrcAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "irc",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "irc",
        accountId,
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
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      host: account.host,
      port: account.port,
      tls: account.tls,
      nick: account.nick,
      passwordSource: account.passwordSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizeIrcAllowEntry(String(entry))).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo?.trim() ||
      undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.irc?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.irc.accounts.${resolvedAccountId}.`
        : "channels.irc.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("irc"),
        normalizeEntry: (raw) => normalizeIrcAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.irc !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy === "open") {
        warnings.push(
          '- IRC channels: groupPolicy="open" allows all channels and senders (mention-gated). Prefer channels.irc.groupPolicy="allowlist" with channels.irc.groups.',
        );
      }
      if (!account.config.tls) {
        warnings.push(
          "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.",
        );
      }
      if (account.config.nickserv?.register) {
        warnings.push(
          '- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends "REGISTER" on every connect. Disable after first successful registration.',
        );
        if (!account.config.nickserv.password?.trim()) {
          warnings.push(
            "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.",
          );
        }
      }
      return warnings;
    },
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
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();

      for (const entry of account.config.allowFrom ?? []) {
        const normalized = normalizePairingTarget(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      for (const entry of account.config.groupAllowFrom ?? []) {
        const normalized = normalizePairingTarget(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      for (const group of Object.values(account.config.groups ?? {})) {
        for (const entry of group.allowFrom ?? []) {
          const normalized = normalizePairingTarget(String(entry));
          if (normalized && normalized !== "*") {
            ids.add(normalized);
          }
        }
      }

      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }));
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const groupIds = new Set<string>();

      for (const channel of account.config.channels ?? []) {
        const normalized = normalizeIrcMessagingTarget(channel);
        if (normalized && isChannelTarget(normalized)) {
          groupIds.add(normalized);
        }
      }
      for (const group of Object.keys(account.config.groups ?? {})) {
        if (group === "*") {
          continue;
        }
        const normalized = normalizeIrcMessagingTarget(group);
        if (normalized && isChannelTarget(normalized)) {
          groupIds.add(normalized);
        }
      }

      return Array.from(groupIds)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id, name: id }));
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIrcRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 350,
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageIrc(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "irc", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageIrc(to, combined, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "irc", ...result };
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
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      host: account.host,
      port: account.port,
      tls: account.tls,
      nick: account.nick,
      passwordSource: account.passwordSource,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
        );
      }
      ctx.log?.info(
        `[${account.accountId}] starting IRC provider (${account.host}:${account.port}${account.tls ? " tls" : ""})`,
      );
      const { stop } = await monitorIrcProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      return { stop };
    },
  },
};
