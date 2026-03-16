import { Separator, TextDisplay } from "@buape/carbon";
import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  buildAccountScopedDmSecurityPolicy,
  collectOpenProviderGroupPolicyWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  collectDiscordAuditChannelIds,
  collectDiscordStatusIssues,
  DEFAULT_ACCOUNT_ID,
  DiscordConfigSchema,
  getChatChannelMeta,
  inspectDiscordAccount,
  listDiscordAccountIds,
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  resolveDiscordAccount,
  resolveDefaultDiscordAccountId,
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedDiscordAccount,
} from "openclaw/plugin-sdk/discord";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { normalizeMessageChannel } from "../../../src/utils/message-channel.js";
import { isDiscordExecApprovalClientEnabled } from "./exec-approvals.js";
import { getDiscordRuntime } from "./runtime.js";
import { createDiscordSetupWizardProxy, discordSetupAdapter } from "./setup-core.js";
import { DiscordUiContainer } from "./ui.js";

type DiscordSendFn = ReturnType<
  typeof getDiscordRuntime
>["channel"]["discord"]["sendMessageDiscord"];

const meta = getChatChannelMeta("discord");

async function loadDiscordChannelRuntime() {
  return await import("./channel.runtime.js");
}

const discordMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) =>
    getDiscordRuntime().channel.discord.messageActions?.listActions?.(ctx) ?? [],
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

const discordConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedDiscordAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedDiscordAccount) => account.config.defaultTo,
});

const discordConfigBase = createScopedChannelConfigBase({
  sectionKey: "discord",
  listAccountIds: listDiscordAccountIds,
  resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectDiscordAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
});

const discordSetupWizard = createDiscordSetupWizardProxy(async () => ({
  discordSetupWizard: (await loadDiscordChannelRuntime()).discordSetupWizard,
}));

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  id: "discord",
  meta: {
    ...meta,
  },
  setupWizard: discordSetupWizard,
  pairing: {
    idLabel: "discordUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(discord|user):/i, ""),
    notifyApproval: async ({ id }) => {
      await getDiscordRuntime().channel.discord.sendMessageDiscord(
        `user:${id}`,
        PAIRING_APPROVED_MESSAGE,
      );
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.discord"] },
  configSchema: buildChannelConfigSchema(DiscordConfigSchema),
  config: {
    ...discordConfigBase,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    ...discordConfigAccessors,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "discord",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dm?.policy,
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPathSuffix: "dm.",
        normalizeEntry: (raw) => raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const guildEntries = account.config.guilds ?? {};
      const guildsConfigured = Object.keys(guildEntries).length > 0;
      const channelAllowlistConfigured = guildsConfigured;

      return collectOpenProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.discord !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyConfiguredRouteWarnings({
            groupPolicy,
            routeAllowlistConfigured: channelAllowlistConfigured,
            configureRouteAllowlist: {
              surface: "Discord guilds",
              openScope: "any channel not explicitly denied",
              groupPolicyPath: "channels.discord.groupPolicy",
              routeAllowlistPath: "channels.discord.guilds.<id>.channels",
            },
            missingRouteAllowlist: {
              surface: "Discord guilds",
              openBehavior:
                "with no guild/channel allowlist; any channel can trigger (mention-gated)",
              remediation:
                'Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels',
            },
          }),
      });
    },
  },
  groups: {
    resolveRequireMention: resolveDiscordGroupRequireMention,
    resolveToolPolicy: resolveDiscordGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off",
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.",
      "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages.",
    ],
  },
  messaging: {
    normalizeTarget: normalizeDiscordMessagingTarget,
    buildCrossContextComponents: buildDiscordCrossContextComponents,
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
    hasConfiguredDmRoute: ({ cfg }) => hasDiscordExecApprovalDmRoute(cfg),
    shouldSuppressForwardingFallback: ({ cfg, target }) =>
      (normalizeMessageChannel(target.channel) ?? target.channel) === "discord" &&
      isDiscordExecApprovalClientEnabled({ cfg, accountId: target.accountId }),
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listDiscordDirectoryPeersFromConfig(params),
    listGroups: async (params) => listDiscordDirectoryGroupsFromConfig(params),
    listPeersLive: async (params) =>
      getDiscordRuntime().channel.discord.listDirectoryPeersLive(params),
    listGroupsLive: async (params) =>
      getDiscordRuntime().channel.discord.listDirectoryGroupsLive(params),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const token = account.token?.trim();
      if (!token) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "missing Discord token",
        }));
      }
      if (kind === "group") {
        const resolved = await getDiscordRuntime().channel.discord.resolveChannelAllowlist({
          token,
          entries: inputs,
        });
        return resolved.map((entry) => ({
          input: entry.input,
          resolved: entry.resolved,
          id: entry.channelId ?? entry.guildId,
          name:
            entry.channelName ??
            entry.guildName ??
            (entry.guildId && !entry.channelId ? entry.guildId : undefined),
          note: entry.note,
        }));
      }
      const resolved = await getDiscordRuntime().channel.discord.resolveUserAllowlist({
        token,
        entries: inputs,
      });
      return resolved.map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id,
        name: entry.name,
        note: entry.note,
      }));
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
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent }) => {
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        getDiscordRuntime().channel.discord.sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        cfg,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
      });
      return { channel: "discord", ...result };
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
      const result = await send(to, text, {
        verbose: false,
        cfg,
        mediaUrl,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
      });
      return { channel: "discord", ...result };
    },
    sendPoll: async ({ cfg, to, poll, accountId, silent }) =>
      await getDiscordRuntime().channel.discord.sendPollDiscord(to, poll, {
        cfg,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
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
      getDiscordRuntime().channel.discord.probeDiscord(account.token, timeoutMs, {
        includeApplication: true,
      }),
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
      const audit = await getDiscordRuntime().channel.discord.auditChannelPermissions({
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
        const probe = await getDiscordRuntime().channel.discord.probeDiscord(token, 2500, {
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
      return getDiscordRuntime().channel.discord.monitorDiscordProvider({
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
