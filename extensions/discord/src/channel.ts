import { Separator, TextDisplay } from "@buape/carbon";
import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-pairing";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/channel-targets";
import { createTopLevelChannelReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createRuntimeOutboundDelegates,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/infra-runtime";
import {
  buildOutboundBaseSessionKey,
  normalizeMessageChannel,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } from "./audit.js";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt,
} from "./exec-approvals.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import { monitorDiscordProvider } from "./monitor.js";
import {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./normalize.js";
import { probeDiscord, type DiscordProbe } from "./probe.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  type OpenClawConfig,
} from "./runtime-api.js";
import { getDiscordRuntime } from "./runtime.js";
import { fetchChannelPermissionsDiscord } from "./send.js";
import { discordSetupAdapter } from "./setup-core.js";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";
import { collectDiscordStatusIssues } from "./status-issues.js";
import { parseDiscordTarget } from "./targets.js";
import { DiscordUiContainer } from "./ui.js";

type DiscordSendFn = ReturnType<
  typeof getDiscordRuntime
>["channel"]["discord"]["sendMessageDiscord"];

const meta = getChatChannelMeta("discord");
const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;

const resolveDiscordDmPolicy = createScopedDmSecurityResolver<ResolvedDiscordAccount>({
  channelKey: "discord",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(discord|user):/i, "")
      .trim()
      .replace(/^<@!?(\d+)>$/, "$1"),
});

function formatDiscordIntents(intents?: {
  messageContent?: string;
  guildMembers?: string;
  presence?: string;
}) {
  if (!intents) {
    return "unknown";
  }
  return [
    `messageContent=${intents.messageContent ?? "unknown"}`,
    `guildMembers=${intents.guildMembers ?? "unknown"}`,
    `presence=${intents.presence ?? "unknown"}`,
  ].join(" ");
}

const discordMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) =>
    getDiscordRuntime().channel.discord.messageActions?.describeMessageTool?.(ctx) ?? null,
  extractToolSend: (ctx) =>
    getDiscordRuntime().channel.discord.messageActions?.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    const ma = getDiscordRuntime().channel.discord.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Discord message actions not available");
    }
    return ma.handleAction(ctx);
  },
  requiresTrustedRequesterSender: ({ action, toolContext }) =>
    Boolean(toolContext && (action === "timeout" || action === "kick" || action === "ban")),
};

function buildDiscordCrossContextComponents(params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const trimmed = params.message.trim();
  const components: Array<TextDisplay | Separator> = [];
  if (trimmed) {
    components.push(new TextDisplay(params.message));
    components.push(new Separator({ divider: true, spacing: "small" }));
  }
  components.push(new TextDisplay(`*From ${params.originLabel}*`));
  return [new DiscordUiContainer({ cfg: params.cfg, accountId: params.accountId, components })];
}

function hasDiscordExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listDiscordAccountIds(cfg).some((accountId) => {
    const execApprovals = resolveDiscordAccount({ cfg, accountId }).config.execApprovals;
    if (!execApprovals?.enabled || (execApprovals.approvers?.length ?? 0) === 0) {
      return false;
    }
    const target = execApprovals.target ?? "dm";
    return target === "dm" || target === "both";
  });
}

const resolveDiscordAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedDiscordAccount) => account.config.guilds,
  outerLabel: (guildKey) => `guild ${guildKey}`,
  resolveOuterEntries: (guildCfg) => guildCfg?.users,
  resolveChildren: (guildCfg) => guildCfg?.channels,
  innerLabel: (guildKey, channelKey) => `guild ${guildKey} / channel ${channelKey}`,
  resolveInnerEntries: (channelCfg) => channelCfg?.users,
});

const resolveDiscordAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({ cfg, accountId }),
  resolveToken: (account: ResolvedDiscordAccount) => account.token,
  resolveNames: ({ token, entries }) => resolveDiscordUserAllowlist({ token, entries }),
});

const collectDiscordSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedDiscordAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.discord !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Object.keys(account.config.guilds ?? {}).length > 0,
    configureRouteAllowlist: {
      surface: "Discord guilds",
      openScope: "any channel not explicitly denied",
      groupPolicyPath: "channels.discord.groupPolicy",
      routeAllowlistPath: "channels.discord.guilds.<id>.channels",
    },
    missingRouteAllowlist: {
      surface: "Discord guilds",
      openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels',
    },
  });

function normalizeDiscordAcpConversationId(conversationId: string) {
  const normalized = conversationId.trim();
  return normalized ? { conversationId: normalized } : null;
}

function matchDiscordAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  if (params.bindingConversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    params.bindingConversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function parseDiscordExplicitTarget(raw: string) {
  try {
    const target = parseDiscordTarget(raw, { defaultKind: "channel" });
    if (!target) {
      return null;
    }
    return {
      to: target.id,
      chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
    };
  } catch {
    return null;
  }
}

function buildDiscordBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "discord" });
}

function resolveDiscordOutboundTargetKindHint(params: {
  target: string;
  resolvedTarget?: { kind: string };
}): "user" | "channel" | undefined {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "user";
  }
  if (resolvedKind === "group" || resolvedKind === "channel") {
    return "channel";
  }

  const target = params.target.trim();
  if (/^channel:/i.test(target)) {
    return "channel";
  }
  if (/^(user:|discord:|@|<@!?)/i.test(target)) {
    return "user";
  }
  return undefined;
}

function resolveDiscordOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const parsed = parseDiscordTarget(params.target, {
    defaultKind: resolveDiscordOutboundTargetKindHint(params),
  });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  const peer: RoutePeer = {
    kind: isDm ? "direct" : "channel",
    id: parsed.id,
  };
  const baseSessionKey = buildDiscordBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const explicitThreadId = normalizeOutboundThreadId(params.threadId);
  const threadCandidate = explicitThreadId ?? normalizeOutboundThreadId(params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadCandidate,
    useSuffix: false,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isDm ? ("direct" as const) : ("channel" as const),
    from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
    to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId: explicitThreadId ?? undefined,
  };
}

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    setup: discordSetupAdapter,
  }),
  pairing: createTextPairingAdapter({
    idLabel: "discordUserId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: createPairingPrefixStripper(/^(discord|user):/i),
    notify: async ({ id, message }) => {
      await getDiscordRuntime().channel.discord.sendMessageDiscord(`user:${id}`, message);
    },
  }),
  allowlist: {
    ...buildLegacyDmAccountAllowlistAdapter({
      channelId: "discord",
      resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({ cfg, accountId }),
      normalize: ({ cfg, accountId, values }) =>
        discordConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
      resolveGroupOverrides: resolveDiscordAllowlistGroupOverrides,
    }),
    resolveNames: resolveDiscordAllowlistNames,
  },
  security: {
    resolveDmPolicy: resolveDiscordDmPolicy,
    collectWarnings: collectDiscordSecurityWarnings,
  },
  groups: {
    resolveRequireMention: resolveDiscordGroupRequireMention,
    resolveToolPolicy: resolveDiscordGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  threading: {
    resolveReplyToMode: createTopLevelChannelReplyToModeResolver("discord"),
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.",
      "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages.",
    ],
  },
  messaging: {
    normalizeTarget: normalizeDiscordMessagingTarget,
    resolveSessionTarget: ({ id }) => normalizeDiscordMessagingTarget(`channel:${id}`),
    parseExplicitTarget: ({ raw }) => parseDiscordExplicitTarget(raw),
    inferTargetChatType: ({ to }) => parseDiscordExplicitTarget(to)?.chatType,
    buildCrossContextComponents: buildDiscordCrossContextComponents,
    resolveOutboundSessionRoute: (params) => resolveDiscordOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeDiscordTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  execApprovals: {
    getInitiatingSurfaceState: ({ cfg, accountId }) =>
      isDiscordExecApprovalClientEnabled({ cfg, accountId })
        ? { kind: "enabled" }
        : { kind: "disabled" },
    shouldSuppressLocalPrompt: ({ cfg, accountId, payload }) =>
      shouldSuppressLocalDiscordExecApprovalPrompt({
        cfg,
        accountId,
        payload,
      }),
    hasConfiguredDmRoute: ({ cfg }) => hasDiscordExecApprovalDmRoute(cfg),
    shouldSuppressForwardingFallback: ({ cfg, target }) =>
      (normalizeMessageChannel(target.channel) ?? target.channel) === "discord" &&
      isDiscordExecApprovalClientEnabled({ cfg, accountId: target.accountId }),
  },
  directory: createChannelDirectoryAdapter({
    listPeers: async (params) => listDiscordDirectoryPeersFromConfig(params),
    listGroups: async (params) => listDiscordDirectoryGroupsFromConfig(params),
    ...createRuntimeDirectoryLiveAdapter({
      getRuntime: () => getDiscordRuntime().channel.discord,
      listPeersLive: (runtime) => runtime.listDirectoryPeersLive,
      listGroupsLive: (runtime) => runtime.listDirectoryGroupsLive,
    }),
  }),
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      if (kind === "group") {
        return resolveTargetsWithOptionalToken({
          token: account.token,
          inputs,
          missingTokenNote: "missing Discord token",
          resolveWithToken: ({ token, inputs }) =>
            getDiscordRuntime().channel.discord.resolveChannelAllowlist({
              token,
              entries: inputs,
            }),
          mapResolved: (entry) => ({
            input: entry.input,
            resolved: entry.resolved,
            id: entry.channelId ?? entry.guildId,
            name:
              entry.channelName ??
              entry.guildName ??
              (entry.guildId && !entry.channelId ? entry.guildId : undefined),
            note: entry.note,
          }),
        });
      }
      return resolveTargetsWithOptionalToken({
        token: account.token,
        inputs,
        missingTokenNote: "missing Discord token",
        resolveWithToken: ({ token, inputs }) =>
          getDiscordRuntime().channel.discord.resolveUserAllowlist({
            token,
            entries: inputs,
          }),
        mapResolved: (entry) => ({
          input: entry.input,
          resolved: entry.resolved,
          id: entry.id,
          name: entry.name,
          note: entry.note,
        }),
      });
    },
  },
  actions: discordMessageActions,
  setup: discordSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    pollMaxOptions: 10,
    resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
    ...createAttachedChannelResultAdapter({
      channel: "discord",
      sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent }) => {
        const send =
          resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
          getDiscordRuntime().channel.discord.sendMessageDiscord;
        return await send(to, text, {
          verbose: false,
          cfg,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
        });
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        silent,
      }) => {
        const send =
          resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
          getDiscordRuntime().channel.discord.sendMessageDiscord;
        return await send(to, text, {
          verbose: false,
          cfg,
          mediaUrl,
          mediaLocalRoots,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
        });
      },
      sendPoll: async ({ cfg, to, poll, accountId, silent }) =>
        await getDiscordRuntime().channel.discord.sendPollDiscord(to, poll, {
          cfg,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
        }),
    }),
  },
  bindings: {
    compileConfiguredBinding: ({ conversationId }) =>
      normalizeDiscordAcpConversationId(conversationId),
    matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
      matchDiscordAcpConversation({
        bindingConversationId: compiledBinding.conversationId,
        conversationId,
        parentConversationId,
      }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastEventAt: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectDiscordStatusIssues,
    buildChannelSummary: ({ snapshot }) =>
      buildTokenChannelStatusSummary(snapshot, { includeMode: false }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeDiscord(account.token, timeoutMs, {
        includeApplication: true,
      }),
    formatCapabilitiesProbe: ({ probe }) => {
      const discordProbe = probe as DiscordProbe | undefined;
      const lines = [];
      if (discordProbe?.bot?.username) {
        const botId = discordProbe.bot.id ? ` (${discordProbe.bot.id})` : "";
        lines.push({ text: `Bot: @${discordProbe.bot.username}${botId}` });
      }
      if (discordProbe?.application?.intents) {
        lines.push({ text: `Intents: ${formatDiscordIntents(discordProbe.application.intents)}` });
      }
      return lines;
    },
    buildCapabilitiesDiagnostics: async ({ account, timeoutMs, target }) => {
      if (!target?.trim()) {
        return undefined;
      }
      const parsedTarget = parseDiscordTarget(target.trim(), { defaultKind: "channel" });
      const details: Record<string, unknown> = {
        target: {
          raw: target,
          normalized: parsedTarget?.normalized,
          kind: parsedTarget?.kind,
          channelId: parsedTarget?.kind === "channel" ? parsedTarget.id : undefined,
        },
      };
      if (!parsedTarget || parsedTarget.kind !== "channel") {
        return {
          details,
          lines: [
            {
              text: "Permissions: Target looks like a DM user; pass channel:<id> to audit channel permissions.",
              tone: "error",
            },
          ],
        };
      }
      const token = account.token?.trim();
      if (!token) {
        return {
          details,
          lines: [
            {
              text: "Permissions: Discord bot token missing for permission audit.",
              tone: "error",
            },
          ],
        };
      }
      try {
        const perms = await fetchChannelPermissionsDiscord(parsedTarget.id, {
          token,
          accountId: account.accountId ?? undefined,
        });
        const missingRequired = REQUIRED_DISCORD_PERMISSIONS.filter(
          (permission) => !perms.permissions.includes(permission),
        );
        details.permissions = {
          channelId: perms.channelId,
          guildId: perms.guildId,
          isDm: perms.isDm,
          channelType: perms.channelType,
          permissions: perms.permissions,
          missingRequired,
          raw: perms.raw,
        };
        return {
          details,
          lines: [
            {
              text: `Permissions (${perms.channelId}): ${perms.permissions.length ? perms.permissions.join(", ") : "none"}`,
            },
            missingRequired.length > 0
              ? { text: `Missing required: ${missingRequired.join(", ")}`, tone: "warn" }
              : { text: "Missing required: none", tone: "success" },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        details.permissions = { channelId: parsedTarget.id, error: message };
        return {
          details,
          lines: [{ text: `Permissions: ${message}`, tone: "error" }],
        };
      }
    },
    auditAccount: async ({ account, timeoutMs, cfg }) => {
      const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
        cfg,
        accountId: account.accountId,
      });
      if (!channelIds.length && unresolvedChannels === 0) {
        return undefined;
      }
      const botToken = account.token?.trim();
      if (!botToken) {
        return {
          ok: unresolvedChannels === 0,
          checkedChannels: 0,
          unresolvedChannels,
          channels: [],
          elapsedMs: 0,
        };
      }
      const audit = await auditDiscordChannelPermissions({
        token: botToken,
        accountId: account.accountId,
        channelIds,
        timeoutMs,
      });
      return { ...audit, unresolvedChannels };
    },
    buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
      const configured =
        resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim());
      const app = runtime?.application ?? (probe as { application?: unknown })?.application;
      const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        runtime,
        probe,
      });
      return {
        ...base,
        ...projectCredentialSnapshotFields(account),
        connected: runtime?.connected ?? false,
        reconnectAttempts: runtime?.reconnectAttempts,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastEventAt: runtime?.lastEventAt ?? null,
        application: app ?? undefined,
        bot: bot ?? undefined,
        audit,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let discordBotLabel = "";
      try {
        const probe = await probeDiscord(token, 2500, {
          includeApplication: true,
        });
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) {
          discordBotLabel = ` (@${username})`;
        }
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
          application: probe.application,
        });
        const messageContent = probe.application?.intents?.messageContent;
        if (messageContent === "disabled") {
          ctx.log?.warn(
            `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
          );
        } else if (messageContent === "limited") {
          ctx.log?.info(
            `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
          );
        }
      } catch (err) {
        if (getDiscordRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
      return monitorDiscordProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        historyLimit: account.config.historyLimit,
        setStatus: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
    },
  },
};
