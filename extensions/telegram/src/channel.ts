import {
  buildDmGroupAccountAllowlistAdapter,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/infra-runtime";
import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/infra-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  buildOutboundBaseSessionKey,
  normalizeMessageChannel,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { parseTelegramTopicConversation } from "../runtime-api.js";
import {
  buildTokenChannelStatusSummary,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  type ChannelMessageActionAdapter,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import { auditTelegramGroupMembership, collectTelegramUnmentionedGroupIds } from "./audit.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { monitorTelegramProvider } from "./monitor.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import { sendTelegramPayloadMessages } from "./outbound-adapter.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { probeTelegram, type TelegramProbe } from "./probe.js";
import { getTelegramRuntime } from "./runtime.js";
import { sendTypingTelegram } from "./send.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import {
  createTelegramPluginBase,
  findTelegramTokenOwnerAccountId,
  formatDuplicateTelegramTokenReason,
  telegramConfigAdapter,
} from "./shared.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramSendFn = ReturnType<
  typeof getTelegramRuntime
>["channel"]["telegram"]["sendMessageTelegram"];

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
  gatewayClientScopes?: readonly string[] | null;
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
    ...(Array.isArray(params.gatewayClientScopes)
      ? { gatewayClientScopes: [...params.gatewayClientScopes] }
      : {}),
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
  gatewayClientScopes?: readonly string[] | null;
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
      gatewayClientScopes: params.gatewayClientScopes,
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

function buildTelegramBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "telegram" });
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
  describeMessageTool: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions?.describeMessageTool?.(ctx) ?? null,
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

const resolveTelegramAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedTelegramAccount) => account.config.groups,
  outerLabel: (groupId) => groupId,
  resolveOuterEntries: (groupCfg) => groupCfg?.allowFrom,
  resolveChildren: (groupCfg) => groupCfg?.topics,
  innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
  resolveInnerEntries: (topicCfg) => topicCfg?.allowFrom,
});

const collectTelegramSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedTelegramAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.telegram !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
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
  });

export const telegramPlugin = createChatChannelPlugin({
  base: {
    ...createTelegramPluginBase({
      setupWizard: telegramSetupWizard,
      setup: telegramSetupAdapter,
    }),
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: "telegram",
      resolveAccount: resolveTelegramAccount,
      normalize: ({ cfg, accountId, values }) =>
        telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveDmAllowFrom: (account) => account.config.allowFrom,
      resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
      resolveDmPolicy: (account) => account.config.dmPolicy,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
      resolveGroupOverrides: resolveTelegramAllowlistGroupOverrides,
    }),
    bindings: {
      compileConfiguredBinding: ({ conversationId }) =>
        normalizeTelegramAcpConversationId(conversationId),
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
        matchTelegramAcpConversation({
          bindingConversationId: compiledBinding.conversationId,
          conversationId,
          parentConversationId,
        }),
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    messaging: {
      normalizeTarget: normalizeTelegramMessagingTarget,
      parseExplicitTarget: ({ raw }) => parseTelegramExplicitTarget(raw),
      inferTargetChatType: ({ to }) => parseTelegramExplicitTarget(to).chatType,
      formatTargetDisplay: ({ target, display, kind }) => {
        const formatted = display?.trim();
        if (formatted) {
          return formatted;
        }
        const trimmedTarget = target.trim();
        if (!trimmedTarget) {
          return trimmedTarget;
        }
        const withoutProvider = trimmedTarget.replace(/^(telegram|tg):/i, "");
        if (kind === "user" || /^user:/i.test(withoutProvider)) {
          return `@${withoutProvider.replace(/^user:/i, "")}`;
        }
        if (/^channel:/i.test(withoutProvider)) {
          return `#${withoutProvider.replace(/^channel:/i, "")}`;
        }
        return withoutProvider;
      },
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
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
      listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
    }),
    actions: telegramMessageActions,
    status: createComputedAccountStatusAdapter<ResolvedTelegramAccount, TelegramProbe, unknown>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: collectTelegramStatusIssues,
      buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        probeTelegram(account.token, timeoutMs, {
          accountId: account.accountId,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
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
          collectTelegramUnmentionedGroupIds(groups);
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
        const audit = await auditTelegramGroupMembership({
          token: account.token,
          botId,
          groupIds,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
          timeoutMs,
        });
        return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
      },
      resolveAccountSnapshot: ({ account, cfg, runtime, audit }) => {
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
          extra: {
            ...projectCredentialSnapshotFields(account),
            lastError: runtime?.lastError ?? duplicateTokenReason,
            mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
            audit,
            allowUnmentionedGroups,
          },
        };
      },
    }),
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
          const probe = await probeTelegram(token, 2500, {
            accountId: account.accountId,
            proxyUrl: account.config.proxy,
            network: account.config.network,
            apiRoot: account.config.apiRoot,
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
        return monitorTelegramProvider({
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
  },
  pairing: {
    text: {
      idLabel: "telegramUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: createPairingPrefixStripper(/^(telegram|tg):/i),
      notify: async ({ cfg, id, message }) => {
        const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
        if (!token) {
          throw new Error("telegram token not configured");
        }
        await getTelegramRuntime().channel.telegram.sendMessageTelegram(id, message, {
          token,
        });
      },
    },
  },
  security: {
    dm: {
      channelKey: "telegram",
      resolvePolicy: (account) => account.config.dmPolicy,
      resolveAllowFrom: (account) => account.config.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
    },
    collectWarnings: collectTelegramSecurityWarnings,
  },
  threading: {
    topLevelReplyToMode: "telegram",
    resolveAutoThreadId: ({ to, toolContext, replyToId }) =>
      replyToId ? undefined : resolveTelegramAutoThreadId({ to, toolContext }),
  },
  outbound: {
    base: {
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
        gatewayClientScopes,
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
            gatewayClientScopes,
          }),
        });
        return attachChannelToResult("telegram", result);
      },
    },
    attachedResults: {
      channel: "telegram",
      sendText: async ({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        gatewayClientScopes,
      }) =>
        await sendTelegramOutbound({
          cfg,
          to,
          text,
          accountId,
          deps,
          replyToId,
          threadId,
          silent,
          gatewayClientScopes,
        }),
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
        gatewayClientScopes,
      }) =>
        await sendTelegramOutbound({
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
          gatewayClientScopes,
        }),
      sendPoll: async ({
        cfg,
        to,
        poll,
        accountId,
        threadId,
        silent,
        isAnonymous,
        gatewayClientScopes,
      }) =>
        await getTelegramRuntime().channel.telegram.sendPollTelegram(to, poll, {
          cfg,
          accountId: accountId ?? undefined,
          messageThreadId: parseTelegramThreadId(threadId),
          silent: silent ?? undefined,
          isAnonymous: isAnonymous ?? undefined,
          gatewayClientScopes,
        }),
    },
  },
});
