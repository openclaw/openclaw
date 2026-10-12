import {
  buildChannelGroupsScopeTree,
  resolveChannelGroupPolicy,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage, formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import {
  danger,
  logVerbose,
  shouldLogVerbose,
  getChildLogger,
  createSubsystemLogger,
  createNonExitingRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  registerSessionBindingAdapterV2,
  type SessionBindingAdapterV2,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { createTelegramHandlers } from "./bot-handlers.runtime.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { defaultTelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  ensureTelegramMessageProcessingResult,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  TelegramSpooledReplayProcessingError,
} from "./bot-processing-outcome.js";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import { Bot, type ApiClientOptions } from "./bot.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  setTelegramCallbackQueryAnswerPromise,
  startTelegramCallbackQueryAnswer,
  takeTelegramCallbackQueryAdmissionAnswer,
} from "./callback-query-answer-state.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import {
  prepareTelegramPollAnswerContextAsync,
  settleTelegramPollAnswerContext,
} from "./poll-answer-context.js";
import { formatTelegramRawUpdateForLog } from "./raw-update-log.js";
import type { TelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { createTelegramSequentializer } from "./sequentialize.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export async function createTelegramBotCore(
  opts: TelegramBotOptions & { telegramDeps: TelegramBotDeps },
): Promise<InstanceType<typeof Bot>> {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const telegramDeps = opts.telegramDeps;
  const cfg = opts.config ?? telegramDeps.getRuntimeConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const ownerAgentId =
    opts.ownerAgentId?.trim() ||
    resolveTelegramAccountOwnerAgentId({ cfg, accountId: account.accountId });
  const runtimeOpts = { ...opts, ownerAgentId };
  const threadBindingScope = {
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  };
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    ...threadBindingScope,
    kind: "subagent",
  });
  const telegramCfg = account.config;
  const apiRoot = normalizeOptionalString(telegramCfg.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;

  const telegramTransport =
    opts.telegramTransport ??
    resolveTelegramTransport(opts.proxyFetch, {
      network: telegramCfg.network,
    });
  const finalFetch = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(telegramTransport.fetch),
    shutdownSignal: opts.fetchAbortSignal,
    transport: telegramTransport,
  });

  const client: ApiClientOptions = {
    fetch: asTelegramClientFetch(finalFetch),
    ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
  };
  const bot = new Bot(opts.token, {
    client,
    ...(opts.botInfo ? { botInfo: opts.botInfo } : {}),
  });
  const accountThrottler = getOrCreateAccountThrottler(opts.token);
  bot.api.config.use(accountThrottler.transformer);
  const sendChatActionHandler: TelegramSendChatActionHandler = {
    sendChatAction: (chatId, action, threadParams) =>
      accountThrottler.chatActions.sendChatAction(chatId, action, threadParams, () =>
        bot.api.sendChatAction(chatId, action, threadParams),
      ),
    isSuspended: accountThrottler.chatActions.isSuspended,
    reset: accountThrottler.chatActions.reset,
  };
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
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
    onSkip: (key) => {
      if (shouldLogVerbose()) {
        logVerbose(`telegram dedupe: skipped ${key}`);
      }
    },
  });
  const shouldSkipUpdate = updateTracker.shouldSkipHandlerDispatch;

  bot.use(async (ctx, next) => {
    const begin = updateTracker.beginUpdate(ctx);
    if (!begin.accepted) {
      return;
    }
    try {
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        await next();
        if (!getTelegramSpooledReplayDeferredParticipant()) {
          // Accepted synchronous updates need one terminal fact at their middleware owner.
          ensureTelegramMessageProcessingResult({ kind: "completed" });
        }
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
      if (result?.kind === "failed-retryable" && isTelegramSpooledReplayUpdate(ctx.update)) {
        throw new TelegramSpooledReplayProcessingError(result.error);
      }
      updateTracker.finishUpdate(begin.update, { completed: true });
    } catch (error) {
      updateTracker.finishUpdate(begin.update, { completed: false });
      throw error;
    }
  });

  // Both transports start callback answers after spool commit. Reuse that
  // answer or start a missing one before same-lane sequentialization so
  // callback acknowledgements cannot wait for earlier handlers.
  bot.use(async (ctx, next) => {
    const callback = ctx.callbackQuery;
    if (callback) {
      const answerPromise =
        takeTelegramCallbackQueryAdmissionAnswer(bot, callback.id) ??
        startTelegramCallbackQueryAnswer(bot, callback.id, false);
      setTelegramCallbackQueryAnswerPromise(ctx, answerPromise);
      void answerPromise.catch(() => {});
    }
    await next();
  });

  // poll_answer omits its chat and topic. Resolve the send-time route before
  // sequentialize so the vote shares the same lane as ordinary session turns.
  bot.use(async (ctx, next) => {
    try {
      await prepareTelegramPollAnswerContextAsync({
        update: ctx.update,
        accountId: account.accountId,
      });
    } catch (error) {
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error });
        return;
      }
      throw error;
    }
    await next();
  });

  bot.use(createTelegramSequentializer());

  // A fast vote can know its route before outbound verification finishes. Hold
  // only that route's sequential lane until registration succeeds or declines it.
  bot.use(async (ctx, next) => {
    await settleTelegramPollAnswerContext({ update: ctx.update, accountId: account.accountId });
    await next();
  });

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        rawUpdateLogger.debug(`telegram update: ${formatTelegramRawUpdateForLog(ctx.update)}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

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
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const resolveGroupPolicy = (chatId: string | number, turnCfg: OpenClawConfig) =>
    resolveChannelGroupPolicy({
      cfg: turnCfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = async (params: {
    agentId?: string;
    sessionKey: string;
    cfg: OpenClawConfig;
  }) => {
    const agentId = params.agentId ?? ownerAgentId;
    const storePath = telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId });
    try {
      const storedActivation = (
        await telegramDeps.getSessionEntryAsync?.({
          storePath,
          sessionKey: params.sessionKey,
        })
      )?.groupActivation;
      if (storedActivation === "always") {
        return false;
      }
      if (storedActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number, turnCfg: OpenClawConfig) =>
    resolveScopeRequireMention({
      tree: buildChannelGroupsScopeTree(turnCfg, "telegram", account.accountId),
      path: [String(chatId)],
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveTelegramGroupConfig = (
    chatId: string | number,
    messageThreadId: number | undefined,
    turnCfg: OpenClawConfig,
  ) => {
    const turnTelegramCfg = resolveTelegramAccount({
      cfg: turnCfg,
      accountId: account.accountId,
    }).config;
    return resolveTelegramScopedGroupConfig(turnTelegramCfg, chatId, messageThreadId);
  };

  const botContext = {
    bot,
    runtime,
    opts: runtimeOpts,
    telegramDeps,
    resolveTelegramGroupConfig,
  };
  const { nativeCommandNames, nativeCommandCallbackDispatcher } =
    await registerTelegramNativeCommands({
      ...botContext,
      cfg,
      accountId: account.accountId,
      telegramCfg,
      mediaMaxBytes,
      nativeEnabled,
      nativeSkillsEnabled,
      resolveGroupPolicy,
      shouldSkipUpdate,
      telegramDeps: {
        ...telegramDeps,
        sendMessageTelegram: defaultTelegramNativeCommandDeps.sendMessageTelegram,
      },
    });
  const messageContext = {
    ...botContext,
    nativeCommandNames,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  };
  const processMessage = createTelegramMessageProcessor({
    ...messageContext,
    account,
    sendChatActionHandler,
    buildContext: opts.buildContext,
  });

  const handlers = createTelegramHandlers({
    ...messageContext,
    cfg,
    accountId: account.accountId,
    ownerAgentId,
    telegramTransport,
    mediaMaxBytes,
    telegramCfg,
    resolveGroupPolicy,
    shouldSkipUpdate,
    processMessage,
  });

  handlers.register(nativeCommandCallbackDispatcher);

  const originalStop = bot.stop.bind(bot);
  // Acquire the account owner only after bot setup has succeeded.
  const threadBindingManager = threadBindingPolicy.enabled
    ? await createTelegramThreadBindingManager({
        cfg,
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel(threadBindingScope),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel(threadBindingScope),
      })
    : null;
  let bindingOwnerStopped = false;
  const disabledBindingAdapter: SessionBindingAdapterV2 | undefined = threadBindingManager
    ? undefined
    : {
        version: 2,
        assertCurrent: () => {
          if (bindingOwnerStopped) {
            throw new Error("Telegram thread binding manager was retired");
          }
        },
        channel: "telegram",
        accountId: account.accountId,
        capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
        touchAsync: async () => {},
        listBySessionAsync: async () => [],
        resolveByConversationAsync: async () => null,
        inspectByConversationAsync: async () => null,
        inspectByConversationsAsync: async (refs) => ({
          bindings: refs.map(() => null),
          assertCurrent: () => {
            if (bindingOwnerStopped) {
              throw new Error("Telegram thread binding manager was retired");
            }
          },
        }),
        listBySession: () => [],
        resolveByConversation: () => null,
      };
  bot.stop = (async (...args: Parameters<typeof originalStop>) => {
    if (disabledBindingAdapter) {
      bindingOwnerStopped = true;
      unregisterSessionBindingAdapter({
        channel: "telegram",
        accountId: account.accountId,
        adapter: disabledBindingAdapter,
      });
    }
    try {
      return await originalStop(...args);
    } finally {
      await threadBindingManager?.stop();
    }
  }) as typeof bot.stop;
  if (disabledBindingAdapter) {
    registerSessionBindingAdapterV2(disabledBindingAdapter);
  }

  return bot;
}
