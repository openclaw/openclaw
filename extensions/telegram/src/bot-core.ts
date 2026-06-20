// Telegram plugin module implements bot core behavior.
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage, formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramDmAllow } from "./access-groups.js";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.runtime.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
  TelegramSpooledReplayProcessingError,
} from "./bot-processing-outcome.js";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import { resolveDefaultAgentId } from "./bot.agent.runtime.js";
import { apiThrottler, Bot, sequentialize, type ApiClientOptions } from "./bot.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import { setTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import {
  asTelegramClientFetch,
  createTelegramClientFetch,
  resolveTelegramClientTimeoutMinimumSeconds,
  resolveTelegramClientTimeoutSeconds,
  resolveTelegramOutboundClientTimeoutFloorSeconds,
} from "./client-fetch.js";
import { isTelegramDmAccessAllowed } from "./dm-access.js";
import { resolveTelegramTransport } from "./fetch.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { stringifyTelegramRawUpdateForLog } from "./raw-update-log.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { parseTelegramTarget } from "./targets.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey };
export { resolveTelegramScopedGroupConfig };

type TelegramBotRuntime = {
  Bot: typeof Bot;
  sequentialize: typeof sequentialize;
  apiThrottler: typeof apiThrottler;
};
type TelegramBotInstance = InstanceType<TelegramBotRuntime["Bot"]>;

const DEFAULT_TELEGRAM_BOT_RUNTIME: TelegramBotRuntime = {
  Bot,
  sequentialize,
  apiThrottler,
};
const TELEGRAM_TYPING_COALESCE_MS = 4_000;

let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}

export function createTelegramBotCore(
  opts: TelegramBotOptions & { telegramDeps: TelegramBotDeps },
): TelegramBotInstance {
  const botRuntime = telegramBotRuntimeForTest ?? DEFAULT_TELEGRAM_BOT_RUNTIME;
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const telegramDeps = opts.telegramDeps;
  const cfg = opts.config ?? telegramDeps.getRuntimeConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  const threadBindingManager = threadBindingPolicy.enabled
    ? createTelegramThreadBindingManager({
        cfg,
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
      })
    : null;
  const telegramCfg = account.config;

  const telegramTransport =
    opts.telegramTransport ??
    resolveTelegramTransport(opts.proxyFetch, {
      network: telegramCfg.network,
    });
  const finalFetch = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(telegramTransport.fetch),
    timeoutSeconds: telegramCfg?.timeoutSeconds,
    shutdownSignal: opts.fetchAbortSignal,
    transport: telegramTransport,
  });

  const timeoutSeconds = resolveTelegramClientTimeoutSeconds({
    value: telegramCfg?.timeoutSeconds,
    minimum: resolveTelegramClientTimeoutMinimumSeconds([
      opts.minimumClientTimeoutSeconds,
      resolveTelegramOutboundClientTimeoutFloorSeconds(telegramCfg?.timeoutSeconds),
    ]),
  });
  const apiRoot = normalizeOptionalString(telegramCfg.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;
  const client: ApiClientOptions | undefined =
    finalFetch || timeoutSeconds || normalizedApiRoot
      ? {
          ...(finalFetch ? { fetch: asTelegramClientFetch(finalFetch) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
        }
      : undefined;

  const botConfig =
    client || opts.botInfo
      ? { ...(client ? { client } : {}), ...(opts.botInfo ? { botInfo: opts.botInfo } : {}) }
      : undefined;
  const bot = new botRuntime.Bot(opts.token, botConfig);
  bot.api.config.use(getOrCreateAccountThrottler(opts.token, botRuntime.apiThrottler));
  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
  const logSkippedUpdate = (key: string) => {
    if (shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
  };
  const updateTracker = createTelegramUpdateTracker({
    initialUpdateId,
    persistenceFloorUpdateId:
      typeof opts.updateOffset?.persistenceFloorUpdateId === "number"
        ? opts.updateOffset.persistenceFloorUpdateId
        : initialUpdateId,
    ackPolicy: "after_agent_dispatch",
    ...(typeof opts.updateOffset?.onUpdateId === "function"
      ? { onAcceptedUpdateId: opts.updateOffset.onUpdateId }
      : {}),
    onPersistError: (err) => {
      runtime.error?.(`telegram: failed to persist update watermark: ${formatErrorMessage(err)}`);
    },
    onSkip: logSkippedUpdate,
  });
  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) =>
    updateTracker.shouldSkipHandlerDispatch(ctx);

  bot.use(async (ctx, next) => {
    const begin = updateTracker.beginUpdate(ctx);
    if (!begin.accepted) {
      return;
    }
    try {
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        await next();
      });
      const deferredWork = getTelegramSpooledReplayDeferredParticipant();
      if (deferredWork) {
        void deferredWork.task
          .then((deferredResult) => {
            updateTracker.finishUpdate(begin.update, {
              completed: deferredResult.kind !== "failed-retryable",
            });
          })
          .catch(() => {
            updateTracker.finishUpdate(begin.update, { completed: false });
          });
        return;
      }
      if (result?.kind === "failed-retryable") {
        if (isTelegramSpooledReplayUpdate(ctx.update)) {
          throw new TelegramSpooledReplayProcessingError(result.error);
        }
        updateTracker.finishUpdate(begin.update, { completed: true });
        return;
      }
      updateTracker.finishUpdate(begin.update, { completed: true });
    } catch (error) {
      updateTracker.finishUpdate(begin.update, { completed: false });
      throw error;
    }
  });

  // Answer callback queries immediately before sequentialize queues them behind
  // agent turns for the same chat/topic. Telegram has a ~15s server-side timeout
  // for answerCallbackQuery; if an agent turn is already processing, sequentialize
  // delays the answer beyond that window and the user sees a stuck loading spinner.
  bot.use(async (ctx, next) => {
    const callback = ctx.callbackQuery;
    if (callback) {
      const answerPromise = bot.api.answerCallbackQuery(callback.id);
      setTelegramCallbackQueryAnswerPromise(ctx, answerPromise);
      void answerPromise.catch(() => {});
    }
    await next();
  });

  bot.use(botRuntime.sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyTelegramRawUpdateForLog(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const telegramTextLimit =
    telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT;
  const textLimit = Math.min(
    resolveTextChunkLimit(cfg, "telegram", account.accountId, {
      fallbackLimit: telegramTextLimit,
    }),
    telegramTextLimit,
  );
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    try {
      const loadSessionStore = telegramDeps.loadSessionStore;
      if (!loadSessionStore) {
        return undefined;
      }
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") {
        return false;
      }
      if (entry?.groupActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const loadFreshTelegramAccountConfig = () => {
    try {
      return resolveTelegramAccount({
        cfg: telegramDeps.getRuntimeConfig(),
        accountId: account.accountId,
      }).config;
    } catch (error) {
      logVerbose(
        `telegram: failed to load fresh config for account ${account.accountId}; using startup snapshot: ${String(error)}`,
      );
      return telegramCfg;
    }
  };
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const freshTelegramCfg = loadFreshTelegramAccountConfig();
    return resolveTelegramScopedGroupConfig(freshTelegramCfg, chatId, messageThreadId);
  };

  // Global sendChatAction handler with 401 backoff and transient cooldown.
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(chatId, action, threadParams),
    logger: (message) => logVerbose(`telegram: ${message}`),
    minIntervalMs: TELEGRAM_TYPING_COALESCE_MS,
  });

  const processMessage = createTelegramMessageProcessor({
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig: () => telegramDeps.getRuntimeConfig(),
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    telegramDeps,
  });

  // Pin-from-here: re-home a mirrored turn onto THIS account through its own
  // dispatch (drafts/streaming/persistence per this account's config). Keyed by
  // accountId so a multi-account install mirrors through the target's own bot.
  // Host-issued, owner-bound registrar (bound to the authenticated "telegram" channel
  // id by the gateway). A plugin can only manage its OWN mirror/admission entries —
  // it cannot pick the owner itself, so it cannot spoof another channel. Absent only
  // in unit tests that construct the bot directly; registration is skipped then.
  const channelOutbound = opts.channelOutbound;
  channelOutbound?.registerMirrorDispatcher(account.accountId, ({ target, replyResolver }) =>
    processMessage.dispatchMirror({ target, replyResolver }),
  );

  // Pin-from-here revocation: the prompt / post-hoc echo path delivers through
  // the channel-agnostic raw send (no inbound admission gate), so gate it on this
  // account's live enablement. A disabled (revoked) destination then stops
  // receiving echoes too, matching the native mirror gate. Covers groups/topics
  // (`groups[id].enabled` / topic `enabled`), direct chats (resolveTelegram-
  // GroupConfig returns the direct config for a positive chat id, so its
  // `enabled: false` is caught here), and a DM policy later set to `disabled`.
  channelOutbound?.registerEchoAdmission(account.accountId, async (cfgForAdmission, target) => {
    // Parse with the canonical Telegram target parser so a topic/thread encoded in
    // the target string (e.g. "telegram:-100...:topic:42") is resolved BEFORE the
    // admission check — otherwise a topic-scoped echo target is gated against the
    // group config instead of its own topic's enablement. Falls back to the explicit
    // threadId when the string carries none.
    const parsedTarget = parseTelegramTarget(target.to);
    const chatId = /^-?\d+$/.test(parsedTarget.chatId)
      ? Number(parsedTarget.chatId)
      : parsedTarget.chatId;
    const threadNum =
      parsedTarget.messageThreadId ??
      (target.threadId == null ? undefined : Number(target.threadId));
    const { groupConfig, topicConfig } = resolveTelegramGroupConfig(
      chatId,
      threadNum != null && Number.isFinite(threadNum) ? threadNum : undefined,
    );
    if (groupConfig?.enabled === false) {
      return false;
    }
    if (topicConfig?.enabled === false) {
      return false;
    }
    // A pinned direct chat (positive id) must re-pass live DM authorization, so a
    // DM whose access is later revoked (policy disabled, pairing dropped, removed
    // from the allowlist) stops receiving echoes. The chat id IS the DM user's id,
    // so it doubles as the sender for the access decision.
    if (typeof chatId === "number" && chatId > 0) {
      const liveCfg = loadFreshTelegramAccountConfig();
      const liveDmPolicy = liveCfg.dmPolicy ?? dmPolicy;
      if (liveDmPolicy === "disabled") {
        return false;
      }
      const dmAllow = await resolveTelegramDmAllow({
        cfg: cfgForAdmission,
        allowFrom: liveCfg.allowFrom ?? allowFrom,
        dmPolicy: liveDmPolicy,
        accountId: account.accountId,
        senderId: String(chatId),
      });
      const allowed = await isTelegramDmAccessAllowed({
        dmPolicy: liveDmPolicy,
        msg: {
          from: { id: chatId, is_bot: false, first_name: "echo-target" },
          chat: { id: chatId, type: "private" },
        } as never,
        chatId,
        effectiveDmAllow: dmAllow.effectiveAllow,
        accountId: account.accountId,
      });
      if (!allowed) {
        return false;
      }
    }
    return true;
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    replyToMode,
    textLimit,
    mediaMaxBytes,
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts,
    telegramDeps,
  });

  registerTelegramHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    telegramTransport,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
    telegramDeps,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    // Drop this account's mirror dispatcher so a stopped account never keeps a
    // stale dispatcher (a reload re-registers a fresh one; a removal just clears it).
    // Same telegram owner, so it can unregister the entries it registered above.
    channelOutbound?.unregisterMirrorDispatcher(account.accountId);
    channelOutbound?.unregisterEchoAdmission(account.accountId);
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
