import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  buildAccountScopedAllowlistConfigEditor,
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  createScopedAccountConfigAccessors,
  createScopedDmSecurityResolver,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildAgentSessionKey,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk/core";
import {
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
  TelegramConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/telegram";
import { parseTelegramTopicConversation } from "../../../src/acp/conversation-id.js";
import { resolveExecApprovalCommandDisplay } from "../../../src/infra/exec-approval-command-display.js";
import { buildExecApprovalPendingReplyPayload } from "../../../src/infra/exec-approval-reply.js";
import {
  type OutboundSendDeps,
  resolveOutboundSendDep,
} from "../../../src/infra/outbound/send-deps.js";
import { normalizeMessageChannel } from "../../../src/utils/message-channel.js";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import {
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import { sendTelegramPayloadMessages } from "./outbound-adapter.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import type { TelegramProbe } from "./probe.js";
import { getTelegramRuntime } from "./runtime.js";
import { sendTypingTelegram } from "./send.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramSendFn = ReturnType<
  typeof getTelegramRuntime
>["channel"]["telegram"]["sendMessageTelegram"];

const meta = getChatChannelMeta("telegram");

function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ cfg: params.cfg, accountId: id });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

type TelegramSendOptions = NonNullable<Parameters<TelegramSendFn>[2]>;

function buildTelegramSendOptions(params: {
  cfg: OpenClawConfig;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
  forceDocument?: boolean | null;
}): TelegramSendOptions {
  return {
    verbose: false,
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    messageThreadId: parseTelegramThreadId(params.threadId),
    replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
    accountId: params.accountId ?? undefined,
    silent: params.silent ?? undefined,
    forceDocument: params.forceDocument ?? undefined,
  };
}

async function sendTelegramOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
}) {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ??
    getTelegramRuntime().channel.telegram.sendMessageTelegram;
  return await send(
    params.to,
    params.text,
    buildTelegramSendOptions({
      cfg: params.cfg,
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
      accountId: params.accountId,
      replyToId: params.replyToId,
      threadId: params.threadId,
      silent: params.silent,
    }),
  );
}

function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: { currentThreadTs?: string; currentChannelId?: string };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  const parsedTo = parseTelegramTarget(params.to);
  const parsedChannel = parseTelegramTarget(context.currentChannelId);
  if (parsedTo.chatId.toLowerCase() !== parsedChannel.chatId.toLowerCase()) {
    return undefined;
  }
  return context.currentThreadTs;
}

function normalizeTelegramAcpConversationId(conversationId: string) {
  const parsed = parseTelegramTopicConversation({ conversationId });
  if (!parsed || !parsed.chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: parsed.chatId,
  };
}

function matchTelegramAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeTelegramAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!incoming || !incoming.chatId.startsWith("-")) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    parentConversationId: incoming.chatId,
    matchPriority: 2,
  };
}

function parseTelegramExplicitTarget(raw: string) {
  const target = parseTelegramTarget(raw);
  return {
    to: target.chatId,
    threadId: target.messageThreadId,
    chatType: target.chatType === "unknown" ? undefined : target.chatType,
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

function buildTelegramBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

function resolveTelegramOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  threadId?: string | number | null;
}) {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const fallbackThreadId = normalizeOutboundThreadId(params.threadId);
  const resolvedThreadId = parsed.messageThreadId ?? parseTelegramThreadId(fallbackThreadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildTelegramBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const threadKeys =
    resolvedThreadId && !isGroup
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(resolvedThreadId) })
      : null;
  return {
    sessionKey: threadKeys?.sessionKey ?? baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? ("group" as const) : ("direct" as const),
    from: isGroup
      ? `telegram:group:${peerId}`
      : resolvedThreadId
        ? `telegram:${chatId}:topic:${resolvedThreadId}`
        : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}

function hasTelegramExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listTelegramAccountIds(cfg).some((accountId) => {
    if (!isTelegramExecApprovalClientEnabled({ cfg, accountId })) {
      return false;
    }
    const target = resolveTelegramExecApprovalTarget({ cfg, accountId });
    return target === "dm" || target === "both";
  });
}

const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions?.listActions?.(ctx) ?? [],
  getCapabilities: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions?.getCapabilities?.(ctx) ?? [],
  extractToolSend: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions?.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    const ma = getTelegramRuntime().channel.telegram.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Telegram message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

const telegramConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account: ResolvedTelegramAccount) => account.config.defaultTo,
});

const telegramConfigBase = createScopedChannelConfigBase<ResolvedTelegramAccount>({
  sectionKey: "telegram",
  listAccountIds: listTelegramAccountIds,
  resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
});

const resolveTelegramDmPolicy = createScopedDmSecurityResolver<ResolvedTelegramAccount>({
  channelKey: "telegram",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
});

function readTelegramAllowlistConfig(account: ResolvedTelegramAccount) {
  const groupOverrides: Array<{ label: string; entries: string[] }> = [];
  for (const [groupId, groupCfg] of Object.entries(account.config.groups ?? {})) {
    const entries = (groupCfg?.allowFrom ?? []).map(String).filter(Boolean);
    if (entries.length > 0) {
      groupOverrides.push({ label: groupId, entries });
    }
    for (const [topicId, topicCfg] of Object.entries(groupCfg?.topics ?? {})) {
      const topicEntries = (topicCfg?.allowFrom ?? []).map(String).filter(Boolean);
      if (topicEntries.length > 0) {
        groupOverrides.push({ label: `${groupId} topic ${topicId}`, entries: topicEntries });
      }
    }
  }
  return {
    dmAllowFrom: (account.config.allowFrom ?? []).map(String),
    groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
    dmPolicy: account.config.dmPolicy,
    groupPolicy: account.config.groupPolicy,
    groupOverrides,
  };
}

export const telegramPlugin: ChannelPlugin<ResolvedTelegramAccount, TelegramProbe> = {
  id: "telegram",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  setupWizard: telegramSetupWizard,
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
      if (!token) {
        throw new Error("telegram token not configured");
      }
      await getTelegramRuntime().channel.telegram.sendMessageTelegram(
        id,
        PAIRING_APPROVED_MESSAGE,
        {
          token,
        },
      );
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    polls: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.telegram"] },
  configSchema: buildChannelConfigSchema(TelegramConfigSchema),
  config: {
    ...telegramConfigBase,
    isConfigured: (account, cfg) => {
      if (!account.token?.trim()) {
        return false;
      }
      return !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
    },
    unconfiguredReason: (account, cfg) => {
      if (!account.token?.trim()) {
        return "not configured";
      }
      const ownerAccountId = findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
      if (!ownerAccountId) {
        return "not configured";
      }
      return formatDuplicateTelegramTokenReason({
        accountId: account.accountId,
        ownerAccountId,
      });
    },
    describeAccount: (account, cfg) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured:
        Boolean(account.token?.trim()) &&
        !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId }),
      tokenSource: account.tokenSource,
    }),
    ...telegramConfigAccessors,
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) =>
      readTelegramAllowlistConfig(resolveTelegramAccount({ cfg, accountId })),
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: "telegram",
      normalize: ({ cfg, accountId, values }) =>
        telegramConfigAccessors.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolvePaths: (scope) => ({
        readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
        writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"],
      }),
    }),
  },
  acpBindings: {
    normalizeConfiguredBindingTarget: ({ conversationId }) =>
      normalizeTelegramAcpConversationId(conversationId),
    matchConfiguredBinding: ({ bindingConversationId, conversationId, parentConversationId }) =>
      matchTelegramAcpConversation({ bindingConversationId, conversationId, parentConversationId }),
  },
  security: {
    resolveDmPolicy: resolveTelegramDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      const groupAllowlistConfigured =
        account.config.groups && Object.keys(account.config.groups).length > 0;
      return collectAllowlistProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.telegram !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyRouteAllowlistWarnings({
            groupPolicy,
            routeAllowlistConfigured: Boolean(groupAllowlistConfigured),
            restrictSenders: {
              surface: "Telegram groups",
              openScope: "any member in allowed groups",
              groupPolicyPath: "channels.telegram.groupPolicy",
              groupAllowFromPath: "channels.telegram.groupAllowFrom",
            },
            noRouteAllowlist: {
              surface: "Telegram groups",
              routeAllowlistPath: "channels.telegram.groups",
              routeScope: "group",
              groupPolicyPath: "channels.telegram.groupPolicy",
              groupAllowFromPath: "channels.telegram.groupAllowFrom",
            },
          }),
      });
    },
  },
  groups: {
    resolveRequireMention: resolveTelegramGroupRequireMention,
    resolveToolPolicy: resolveTelegramGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "off",
    resolveAutoThreadId: ({ to, toolContext, replyToId }) =>
      replyToId ? undefined : resolveTelegramAutoThreadId({ to, toolContext }),
  },
  messaging: {
    normalizeTarget: normalizeTelegramMessagingTarget,
    parseExplicitTarget: ({ raw }) => parseTelegramExplicitTarget(raw),
    inferTargetChatType: ({ to }) => parseTelegramExplicitTarget(to).chatType,
    resolveOutboundSessionRoute: (params) => resolveTelegramOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeTelegramTargetId,
      hint: "<chatId>",
    },
  },
  lifecycle: {
    onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
      const previousToken = resolveTelegramAccount({ cfg: prevCfg, accountId }).token.trim();
      const nextToken = resolveTelegramAccount({ cfg: nextCfg, accountId }).token.trim();
      if (previousToken !== nextToken) {
        const { deleteTelegramUpdateOffset } = await import("./update-offset-store.js");
        await deleteTelegramUpdateOffset({ accountId });
      }
    },
    onAccountRemoved: async ({ accountId }) => {
      const { deleteTelegramUpdateOffset } = await import("./update-offset-store.js");
      await deleteTelegramUpdateOffset({ accountId });
    },
  },
  execApprovals: {
    getInitiatingSurfaceState: ({ cfg, accountId }) =>
      isTelegramExecApprovalClientEnabled({ cfg, accountId })
        ? { kind: "enabled" }
        : { kind: "disabled" },
    hasConfiguredDmRoute: ({ cfg }) => hasTelegramExecApprovalDmRoute(cfg),
    shouldSuppressForwardingFallback: ({ cfg, target, request }) => {
      const channel = normalizeMessageChannel(target.channel) ?? target.channel;
      if (channel !== "telegram") {
        return false;
      }
      const requestChannel = normalizeMessageChannel(request.request.turnSourceChannel ?? "");
      if (requestChannel !== "telegram") {
        return false;
      }
      const accountId = target.accountId?.trim() || request.request.turnSourceAccountId?.trim();
      return isTelegramExecApprovalClientEnabled({ cfg, accountId });
    },
    buildPendingPayload: ({ request, nowMs }) => {
      const payload = buildExecApprovalPendingReplyPayload({
        approvalId: request.id,
        approvalSlug: request.id.slice(0, 8),
        approvalCommandId: request.id,
        command: resolveExecApprovalCommandDisplay(request.request).commandText,
        cwd: request.request.cwd ?? undefined,
        host: request.request.host === "node" ? "node" : "gateway",
        nodeId: request.request.nodeId ?? undefined,
        expiresAtMs: request.expiresAtMs,
        nowMs,
      });
      const buttons = buildTelegramExecApprovalButtons(request.id);
      if (!buttons) {
        return payload;
      }
      return {
        ...payload,
        channelData: {
          ...payload.channelData,
          telegram: {
            buttons,
          },
        },
      };
    },
    beforeDeliverPending: async ({ cfg, target, payload }) => {
      const hasExecApprovalData =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData) &&
        payload.channelData.execApproval;
      if (!hasExecApprovalData) {
        return;
      }
      const threadId =
        typeof target.threadId === "number"
          ? target.threadId
          : typeof target.threadId === "string"
            ? Number.parseInt(target.threadId, 10)
            : undefined;
      await sendTypingTelegram(target.to, {
        cfg,
        accountId: target.accountId ?? undefined,
        ...(Number.isFinite(threadId) ? { messageThreadId: threadId } : {}),
      }).catch(() => {});
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
    listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
  },
  actions: telegramMessageActions,
  setup: telegramSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getTelegramRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    pollMaxOptions: 10,
    shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
      typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
    sendPayload: async ({
      cfg,
      to,
      payload,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
      forceDocument,
    }) => {
      const send =
        resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
        getTelegramRuntime().channel.telegram.sendMessageTelegram;
      const result = await sendTelegramPayloadMessages({
        send,
        to,
        payload,
        baseOpts: buildTelegramSendOptions({
          cfg,
          mediaLocalRoots,
          accountId,
          replyToId,
          threadId,
          silent,
          forceDocument,
        }),
      });
      return { channel: "telegram", ...result };
    },
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, silent }) => {
      const result = await sendTelegramOutbound({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
      });
      return { channel: "telegram", ...result };
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
      threadId,
      silent,
    }) => {
      const result = await sendTelegramOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
      });
      return { channel: "telegram", ...result };
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent, isAnonymous }) =>
      await getTelegramRuntime().channel.telegram.sendPollTelegram(to, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
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
    collectStatusIssues: collectTelegramStatusIssues,
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      getTelegramRuntime().channel.telegram.probeTelegram(account.token, timeoutMs, {
        accountId: account.accountId,
        proxyUrl: account.config.proxy,
        network: account.config.network,
      }),
    formatCapabilitiesProbe: ({ probe }) => {
      const lines = [];
      if (probe?.bot?.username) {
        const botId = probe.bot.id ? ` (${probe.bot.id})` : "";
        lines.push({ text: `Bot: @${probe.bot.username}${botId}` });
      }
      const flags: string[] = [];
      if (typeof probe?.bot?.canJoinGroups === "boolean") {
        flags.push(`joinGroups=${probe.bot.canJoinGroups}`);
      }
      if (typeof probe?.bot?.canReadAllGroupMessages === "boolean") {
        flags.push(`readAllGroupMessages=${probe.bot.canReadAllGroupMessages}`);
      }
      if (typeof probe?.bot?.supportsInlineQueries === "boolean") {
        flags.push(`inlineQueries=${probe.bot.supportsInlineQueries}`);
      }
      if (flags.length > 0) {
        lines.push({ text: `Flags: ${flags.join(" ")}` });
      }
      if (probe?.webhook?.url !== undefined) {
        lines.push({ text: `Webhook: ${probe.webhook.url || "none"}` });
      }
      return lines;
    },
    auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
      const groups =
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;
      const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
        getTelegramRuntime().channel.telegram.collectUnmentionedGroupIds(groups);
      if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
        return undefined;
      }
      const botId = probe?.ok && probe.bot?.id != null ? probe.bot.id : null;
      if (!botId) {
        return {
          ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
          checkedGroups: 0,
          unresolvedGroups,
          hasWildcardUnmentionedGroups,
          groups: [],
          elapsedMs: 0,
        };
      }
      const audit = await getTelegramRuntime().channel.telegram.auditGroupMembership({
        token: account.token,
        botId,
        groupIds,
        proxyUrl: account.config.proxy,
        network: account.config.network,
        timeoutMs,
      });
      return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
    },
    buildAccountSnapshot: ({ account, cfg, runtime, probe, audit }) => {
      const configuredFromStatus = resolveConfiguredFromCredentialStatuses(account);
      const ownerAccountId = findTelegramTokenOwnerAccountId({
        cfg,
        accountId: account.accountId,
      });
      const duplicateTokenReason = ownerAccountId
        ? formatDuplicateTelegramTokenReason({
            accountId: account.accountId,
            ownerAccountId,
          })
        : null;
      const configured =
        (configuredFromStatus ?? Boolean(account.token?.trim())) && !ownerAccountId;
      const groups =
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;
      const allowUnmentionedGroups =
        groups?.["*"]?.requireMention === false ||
        Object.entries(groups ?? {}).some(
          ([key, value]) => key !== "*" && value?.requireMention === false,
        );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        ...projectCredentialSnapshotFields(account),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? duplicateTokenReason,
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        probe,
        audit,
        allowUnmentionedGroups,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const ownerAccountId = findTelegramTokenOwnerAccountId({
        cfg: ctx.cfg,
        accountId: account.accountId,
      });
      if (ownerAccountId) {
        const reason = formatDuplicateTelegramTokenReason({
          accountId: account.accountId,
          ownerAccountId,
        });
        ctx.log?.error?.(`[${account.accountId}] ${reason}`);
        throw new Error(reason);
      }
      const token = (account.token ?? "").trim();
      let telegramBotLabel = "";
      try {
        const probe = await getTelegramRuntime().channel.telegram.probeTelegram(token, 2500, {
          accountId: account.accountId,
          proxyUrl: account.config.proxy,
          network: account.config.network,
        });
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) {
          telegramBotLabel = ` (@${username})`;
        }
      } catch (err) {
        if (getTelegramRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);
      return getTelegramRuntime().channel.telegram.monitorTelegramProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
        webhookHost: account.config.webhookHost,
        webhookPort: account.config.webhookPort,
        webhookCertPath: account.config.webhookCertPath,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : undefined;
      let cleared = false;
      let changed = false;
      if (nextTelegram) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextTelegram.botToken) {
          delete nextTelegram.botToken;
          cleared = true;
          changed = true;
        }
        const accountCleanup = clearAccountEntryFields({
          accounts: nextTelegram.accounts,
          accountId,
          fields: ["botToken"],
        });
        if (accountCleanup.changed) {
          changed = true;
          if (accountCleanup.cleared) {
            cleared = true;
          }
          if (accountCleanup.nextAccounts) {
            nextTelegram.accounts = accountCleanup.nextAccounts;
          } else {
            delete nextTelegram.accounts;
          }
        }
      }
      if (changed) {
        if (nextTelegram && Object.keys(nextTelegram).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, telegram: nextTelegram };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.telegram;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      const resolved = resolveTelegramAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";
      if (changed) {
        await getTelegramRuntime().config.writeConfigFile(nextCfg);
      }
      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};
