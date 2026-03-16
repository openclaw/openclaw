import {
  buildAgentSessionKey,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk";
import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  buildAccountScopedAllowlistConfigEditor,
  buildAccountScopedDmSecurityPolicy,
  collectOpenProviderGroupPolicyWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  extractSlackToolSend,
  getChatChannelMeta,
  handleSlackMessageAction,
  inspectSlackAccount,
  listSlackMessageActions,
  listSlackAccountIds,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode,
  isSlackInteractiveRepliesEnabled,
  resolveSlackGroupRequireMention,
  resolveSlackGroupToolPolicy,
  buildSlackThreadingToolContext,
  SlackConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedSlackAccount,
} from "openclaw/plugin-sdk/slack";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { createSlackWebClient } from "./client.js";
import { normalizeAllowListLower } from "./monitor/allow-list.js";
import type { SlackProbe } from "./probe.js";
import { resolveSlackUserAllowlist } from "./resolve-users.js";
import { getSlackRuntime } from "./runtime.js";
import { fetchSlackScopes } from "./scopes.js";
import { createSlackSetupWizardProxy, slackSetupAdapter } from "./setup-core.js";
import { parseSlackTarget } from "./targets.js";

const meta = getChatChannelMeta("slack");
const SLACK_CHANNEL_TYPE_CACHE = new Map<string, "channel" | "group" | "dm" | "unknown">();

async function loadSlackChannelRuntime() {
  return await import("./channel.runtime.js");
}

// Select the appropriate Slack token for read/write operations.
function getTokenForOperation(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  const userToken = account.config.userToken?.trim() || undefined;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;
  if (operation === "read") {
    return userToken ?? botToken;
  }
  if (!allowUserWrites) {
    return botToken;
  }
  return botToken ?? userToken;
}

function isSlackAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

type SlackSendFn = ReturnType<typeof getSlackRuntime>["channel"]["slack"]["sendMessageSlack"];

function resolveSlackSendContext(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    getSlackRuntime().channel.slack.sendMessageSlack;
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = getTokenForOperation(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = params.replyToId ?? params.threadId;
  return { send, threadTsValue, tokenOverride };
}

function resolveSlackAutoThreadId(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string | null;
  to: string;
  toolContext?: {
    currentChannelId?: string;
    currentThreadTs?: string;
    replyToMode?: "off" | "first" | "all";
    hasRepliedRef?: { value: boolean };
  };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  if (context.replyToMode !== "all" && context.replyToMode !== "first") {
    return undefined;
  }
  const parsedTarget = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!parsedTarget || parsedTarget.kind !== "channel") {
    return undefined;
  }
  if (parsedTarget.id.toLowerCase() !== context.currentChannelId.toLowerCase()) {
    return undefined;
  }
  if (context.replyToMode === "first" && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}

function parseSlackExplicitTarget(raw: string) {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!target) {
    return null;
  }
  return {
    to: target.id,
    chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
  };
}

function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildSlackBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "slack",
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

async function resolveSlackChannelType(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown"> {
  const channelId = params.channelId.trim();
  if (!channelId) {
    return "unknown";
  }
  const cacheKey = `${params.accountId ?? "default"}:${channelId}`;
  const cached = SLACK_CHANNEL_TYPE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
  const channelIdLower = channelId.toLowerCase();
  if (
    groupChannels.includes(channelIdLower) ||
    groupChannels.includes(`slack:${channelIdLower}`) ||
    groupChannels.includes(`channel:${channelIdLower}`) ||
    groupChannels.includes(`group:${channelIdLower}`) ||
    groupChannels.includes(`mpim:${channelIdLower}`)
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "group");
    return "group";
  }

  const channelKeys = Object.keys(account.channels ?? {});
  if (
    channelKeys.some((key) => {
      const normalized = key.trim().toLowerCase();
      return (
        normalized === channelIdLower ||
        normalized === `channel:${channelIdLower}` ||
        normalized.replace(/^#/, "") === channelIdLower
      );
    })
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "channel");
    return "channel";
  }

  const token = account.botToken?.trim() || account.config.userToken?.trim() || "";
  if (!token) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
    return "unknown";
  }

  try {
    const client = createSlackWebClient(token);
    const info = await client.conversations.info({ channel: channelId });
    const channel = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
    const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, type);
    return type;
  } catch {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
    return "unknown";
  }
}

async function resolveSlackOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  if (!isDm && /^G/i.test(parsed.id)) {
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: parsed.id,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
  }
  const peer: RoutePeer = {
    kind: peerKind,
    id: parsed.id,
  };
  const baseSessionKey = buildSlackBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeOutboundThreadId(params.threadId ?? params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: peerKind === "direct" ? ("direct" as const) : ("channel" as const),
    from:
      peerKind === "direct"
        ? `slack:${parsed.id}`
        : peerKind === "group"
          ? `slack:group:${parsed.id}`
          : `slack:channel:${parsed.id}`,
    to: peerKind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId,
  };
}

function formatSlackScopeDiagnostic(params: {
  tokenType: "bot" | "user";
  result: Awaited<ReturnType<typeof fetchSlackScopes>>;
}) {
  const source = params.result.source ? ` (${params.result.source})` : "";
  const label = params.tokenType === "user" ? "User scopes" : "Bot scopes";
  if (params.result.ok && params.result.scopes?.length) {
    return { text: `${label}${source}: ${params.result.scopes.join(", ")}` } as const;
  }
  return {
    text: `${label}: ${params.result.error ?? "scope lookup failed"}`,
    tone: "error",
  } as const;
}

function readSlackAllowlistConfig(account: ResolvedSlackAccount) {
  return {
    dmAllowFrom: (account.config.allowFrom ?? account.config.dm?.allowFrom ?? []).map(String),
    groupPolicy: account.groupPolicy,
    groupOverrides: Object.entries(account.channels ?? {})
      .map(([key, value]) => {
        const entries = (value?.users ?? []).map(String).filter(Boolean);
        return entries.length > 0 ? { label: key, entries } : null;
      })
      .filter(Boolean) as Array<{ label: string; entries: string[] }>,
  };
}

async function resolveSlackAllowlistNames(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string | null;
  entries: string[];
}) {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = account.config.userToken?.trim() || account.botToken?.trim();
  if (!token) {
    return [];
  }
  return await resolveSlackUserAllowlist({ token, entries: params.entries });
}

const slackConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

const slackConfigBase = createScopedChannelConfigBase({
  sectionKey: "slack",
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
});

const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard,
}));

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  id: "slack",
  meta: {
    ...meta,
    preferSessionLookupForAnnounceTarget: true,
  },
  setupWizard: slackSetupWizard,
  pairing: {
    idLabel: "slackUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(slack|user):/i, ""),
    notifyApproval: async ({ id }) => {
      const cfg = getSlackRuntime().config.loadConfig();
      const account = resolveSlackAccount({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const token = getTokenForOperation(account, "write");
      const botToken = account.botToken?.trim();
      const tokenOverride = token && token !== botToken ? token : undefined;
      if (tokenOverride) {
        await getSlackRuntime().channel.slack.sendMessageSlack(
          `user:${id}`,
          PAIRING_APPROVED_MESSAGE,
          {
            token: tokenOverride,
          },
        );
      } else {
        await getSlackRuntime().channel.slack.sendMessageSlack(
          `user:${id}`,
          PAIRING_APPROVED_MESSAGE,
        );
      }
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId })
        ? [
            "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
            "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
          ]
        : [
            "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
          ],
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.slack"] },
  configSchema: buildChannelConfigSchema(SlackConfigSchema),
  config: {
    ...slackConfigBase,
    isConfigured: (account) => isSlackAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isSlackAccountConfigured(account),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    }),
    ...slackConfigAccessors,
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm",
    readConfig: ({ cfg, accountId }) =>
      readSlackAllowlistConfig(resolveSlackAccount({ cfg, accountId })),
    resolveNames: async ({ cfg, accountId, entries }) =>
      await resolveSlackAllowlistNames({ cfg, accountId, entries }),
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: "slack",
      normalize: ({ cfg, accountId, values }) =>
        slackConfigAccessors.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolvePaths: (scope) =>
        scope === "dm"
          ? {
              readPaths: [["allowFrom"], ["dm", "allowFrom"]],
              writePath: ["allowFrom"],
              cleanupPaths: [["dm", "allowFrom"]],
            }
          : null,
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "slack",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.dm?.policy,
        allowFrom: account.dm?.allowFrom ?? [],
        allowFromPathSuffix: "dm.",
        normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, ""),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const channelAllowlistConfigured =
        Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0;

      return collectOpenProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.slack !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyConfiguredRouteWarnings({
            groupPolicy,
            routeAllowlistConfigured: channelAllowlistConfigured,
            configureRouteAllowlist: {
              surface: "Slack channels",
              openScope: "any channel not explicitly denied",
              groupPolicyPath: "channels.slack.groupPolicy",
              routeAllowlistPath: "channels.slack.channels",
            },
            missingRouteAllowlist: {
              surface: "Slack channels",
              openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
              remediation:
                'Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels',
            },
          }),
      });
    },
  },
  groups: {
    resolveRequireMention: resolveSlackGroupRequireMention,
    resolveToolPolicy: resolveSlackGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId, chatType }) =>
      resolveSlackReplyToMode(resolveSlackAccount({ cfg, accountId }), chatType),
    allowExplicitReplyTagsWhenOff: false,
    buildToolContext: (params) => buildSlackThreadingToolContext(params),
    resolveAutoThreadId: ({ cfg, accountId, to, toolContext, replyToId }) =>
      replyToId
        ? undefined
        : resolveSlackAutoThreadId({
            cfg,
            accountId,
            to,
            toolContext,
          }),
    resolveReplyTransport: ({ threadId, replyToId }) => ({
      replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
      threadId: null,
    }),
  },
  messaging: {
    normalizeTarget: normalizeSlackMessagingTarget,
    parseExplicitTarget: ({ raw }) => parseSlackExplicitTarget(raw),
    inferTargetChatType: ({ to }) => parseSlackExplicitTarget(to)?.chatType,
    resolveOutboundSessionRoute: async (params) => await resolveSlackOutboundSessionRoute(params),
    enableInteractiveReplies: ({ cfg, accountId }) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId }),
    hasStructuredReplyPayload: ({ payload }) => {
      const slackData = payload.channelData?.slack;
      if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
        return false;
      }
      try {
        return Boolean(parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks)?.length);
      } catch {
        return false;
      }
    },
    targetResolver: {
      looksLikeId: looksLikeSlackTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listSlackDirectoryPeersFromConfig(params),
    listGroups: async (params) => listSlackDirectoryGroupsFromConfig(params),
    listPeersLive: async (params) => getSlackRuntime().channel.slack.listDirectoryPeersLive(params),
    listGroupsLive: async (params) =>
      getSlackRuntime().channel.slack.listDirectoryGroupsLive(params),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const toResolvedTarget = <
        T extends { input: string; resolved: boolean; id?: string; name?: string },
      >(
        entry: T,
        note?: string,
      ) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id,
        name: entry.name,
        note,
      });
      const account = resolveSlackAccount({ cfg, accountId });
      const token = account.config.userToken?.trim() || account.botToken?.trim();
      if (!token) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "missing Slack token",
        }));
      }
      if (kind === "group") {
        const resolved = await getSlackRuntime().channel.slack.resolveChannelAllowlist({
          token,
          entries: inputs,
        });
        return resolved.map((entry) =>
          toResolvedTarget(entry, entry.archived ? "archived" : undefined),
        );
      }
      const resolved = await getSlackRuntime().channel.slack.resolveUserAllowlist({
        token,
        entries: inputs,
      });
      return resolved.map((entry) => toResolvedTarget(entry, entry.note));
    },
  },
  actions: {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    getCapabilities: ({ cfg }) => {
      const capabilities = new Set<"interactive" | "blocks">();
      if (listSlackMessageActions(cfg).includes("send")) {
        capabilities.add("blocks");
      }
      if (isSlackInteractiveRepliesEnabled({ cfg })) {
        capabilities.add("interactive");
      }
      return Array.from(capabilities);
    },
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) =>
      await handleSlackMessageAction({
        providerId: meta.id,
        ctx,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await getSlackRuntime().channel.slack.handleSlackAction(action, cfg, toolContext),
      }),
  },
  setup: slackSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
      const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
        cfg,
        accountId: accountId ?? undefined,
        deps,
        replyToId,
        threadId,
      });
      const result = await send(to, text, {
        cfg,
        threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
    },
    sendMedia: async ({
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      cfg,
    }) => {
      const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
        cfg,
        accountId: accountId ?? undefined,
        deps,
        replyToId,
        threadId,
      });
      const result = await send(to, text, {
        cfg,
        mediaUrl,
        mediaLocalRoots,
        threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
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
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveProbedChannelStatusSummary(snapshot, {
        botTokenSource: snapshot.botTokenSource ?? "none",
        appTokenSource: snapshot.appTokenSource ?? "none",
      }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      if (!token) {
        return { ok: false, error: "missing token" };
      }
      return await getSlackRuntime().channel.slack.probeSlack(token, timeoutMs);
    },
    formatCapabilitiesProbe: ({ probe }) => {
      const slackProbe = probe as SlackProbe | undefined;
      const lines = [];
      if (slackProbe?.bot?.name) {
        lines.push({ text: `Bot: @${slackProbe.bot.name}` });
      }
      if (slackProbe?.team?.name || slackProbe?.team?.id) {
        const id = slackProbe.team?.id ? ` (${slackProbe.team.id})` : "";
        lines.push({ text: `Team: ${slackProbe.team?.name ?? "unknown"}${id}` });
      }
      return lines;
    },
    buildCapabilitiesDiagnostics: async ({ account, timeoutMs }) => {
      const lines = [];
      const details: Record<string, unknown> = {};
      const botToken = account.botToken?.trim();
      const userToken = account.config.userToken?.trim();
      const botScopes = botToken
        ? await fetchSlackScopes(botToken, timeoutMs)
        : { ok: false, error: "Slack bot token missing." };
      lines.push(formatSlackScopeDiagnostic({ tokenType: "bot", result: botScopes }));
      details.botScopes = botScopes;
      if (userToken) {
        const userScopes = await fetchSlackScopes(userToken, timeoutMs);
        lines.push(formatSlackScopeDiagnostic({ tokenType: "user", result: userScopes }));
        details.userScopes = userScopes;
      }
      return { lines, details };
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const mode = account.config.mode ?? "socket";
      const configured =
        (mode === "http"
          ? resolveConfiguredFromRequiredCredentialStatuses(account, [
              "botTokenStatus",
              "signingSecretStatus",
            ])
          : resolveConfiguredFromRequiredCredentialStatuses(account, [
              "botTokenStatus",
              "appTokenStatus",
            ])) ?? isSlackAccountConfigured(account);
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
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const botToken = account.botToken?.trim();
      const appToken = account.appToken?.trim();
      ctx.log?.info(`[${account.accountId}] starting provider`);
      return getSlackRuntime().channel.slack.monitorSlackProvider({
        botToken: botToken ?? "",
        appToken: appToken ?? "",
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        slashCommand: account.config.slashCommand,
        setStatus: ctx.setStatus as (next: Record<string, unknown>) => void,
        getStatus: ctx.getStatus as () => Record<string, unknown>,
      });
    },
  },
};
