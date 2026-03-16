import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  createScopedAccountConfigAccessors,
  createScopedDmSecurityResolver,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  buildTokenChannelStatusSummary,
  clearAccountEntryFields,
  collectTelegramStatusIssues,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  inspectTelegramAccount,
  listTelegramAccountIds,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  looksLikeTelegramTargetId,
  normalizeAccountId,
  normalizeTelegramMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
  sendTelegramPayloadMessages,
  TelegramConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedTelegramAccount,
  type TelegramProbe,
} from "openclaw/plugin-sdk/telegram";
import {
  type OutboundSendDeps,
  resolveOutboundSendDep,
} from "../../../src/infra/outbound/send-deps.js";
import { getTelegramRuntime } from "./runtime.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";

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

const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions?.listActions?.(ctx) ?? [],
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
  },
  messaging: {
    normalizeTarget: normalizeTelegramMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeTelegramTargetId,
      hint: "<chatId>",
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
