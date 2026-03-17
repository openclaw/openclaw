import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Bot } from "grammy";
import { resolveDefaultAgentId } from "../../../src/agents/agent-scope.js";
import { resolveTextChunkLimit } from "../../../src/auto-reply/chunk.js";
import {
  DEFAULT_GROUP_HISTORY_LIMIT
} from "../../../src/auto-reply/reply/history.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy
} from "../../../src/channels/thread-bindings-policy.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled
} from "../../../src/config/commands.js";
import { loadConfig } from "../../../src/config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention
} from "../../../src/config/group-policy.js";
import { loadSessionStore, resolveStorePath } from "../../../src/config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../src/globals.js";
import { formatUncaughtError } from "../../../src/infra/errors.js";
import { getChildLogger } from "../../../src/logging.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { createNonExitingRuntime } from "../../../src/runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { registerTelegramHandlers } from "./bot-handlers.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId
} from "./bot-updates.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramTransport } from "./fetch.js";
import { tagTelegramNetworkError } from "./network-errors.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";
function readRequestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = input.url;
    return typeof url === "string" ? url : null;
  }
  return null;
}
function extractTelegramApiMethod(input) {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments.at(-1) ?? null : null;
  } catch {
    return null;
  }
}
function createTelegramBot(opts) {
  const runtime = opts.runtime ?? createNonExitingRuntime();
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId
  });
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent"
  });
  const threadBindingManager = threadBindingPolicy.enabled ? createTelegramThreadBindingManager({
    accountId: account.accountId,
    idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
      cfg,
      channel: "telegram",
      accountId: account.accountId
    }),
    maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
      cfg,
      channel: "telegram",
      accountId: account.accountId
    })
  }) : null;
  const telegramCfg = account.config;
  const telegramTransport = resolveTelegramTransport(opts.proxyFetch, {
    network: telegramCfg.network
  });
  const shouldProvideFetch = Boolean(telegramTransport.fetch);
  const fetchForClient = telegramTransport.fetch;
  let finalFetch = shouldProvideFetch ? fetchForClient : void 0;
  if (opts.fetchAbortSignal) {
    const baseFetch = finalFetch ?? globalThis.fetch;
    const shutdownSignal = opts.fetchAbortSignal;
    const callFetch = baseFetch;
    finalFetch = ((input, init) => {
      const controller = new AbortController();
      const abortWith = (signal) => controller.abort(signal.reason);
      const onShutdown = () => abortWith(shutdownSignal);
      let onRequestAbort;
      if (shutdownSignal.aborted) {
        abortWith(shutdownSignal);
      } else {
        shutdownSignal.addEventListener("abort", onShutdown, { once: true });
      }
      if (init?.signal) {
        if (init.signal.aborted) {
          abortWith(init.signal);
        } else {
          onRequestAbort = () => abortWith(init.signal);
          init.signal.addEventListener("abort", onRequestAbort);
        }
      }
      return callFetch(input, {
        ...init,
        signal: controller.signal
      }).finally(() => {
        shutdownSignal.removeEventListener("abort", onShutdown);
        if (init?.signal && onRequestAbort) {
          init.signal.removeEventListener("abort", onRequestAbort);
        }
      });
    });
  }
  if (finalFetch) {
    const baseFetch = finalFetch;
    finalFetch = ((input, init) => {
      return Promise.resolve(baseFetch(input, init)).catch((err) => {
        try {
          tagTelegramNetworkError(err, {
            method: extractTelegramApiMethod(input),
            url: readRequestUrl(input)
          });
        } catch {
        }
        throw err;
      });
    });
  }
  const timeoutSeconds = typeof telegramCfg?.timeoutSeconds === "number" && Number.isFinite(telegramCfg.timeoutSeconds) ? Math.max(1, Math.floor(telegramCfg.timeoutSeconds)) : void 0;
  const client = finalFetch || timeoutSeconds ? {
    ...finalFetch ? { fetch: finalFetch } : {},
    ...timeoutSeconds ? { timeoutSeconds } : {}
  } : void 0;
  const bot = new Bot(opts.token, client ? { client } : void 0);
  bot.api.config.use(apiThrottler());
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });
  const recentUpdates = createTelegramUpdateDedupe();
  const initialUpdateId = typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
  const pendingUpdateIds = /* @__PURE__ */ new Set();
  let highestCompletedUpdateId = initialUpdateId;
  let highestPersistedUpdateId = initialUpdateId;
  const maybePersistSafeWatermark = () => {
    if (typeof opts.updateOffset?.onUpdateId !== "function") {
      return;
    }
    if (highestCompletedUpdateId === null) {
      return;
    }
    let safe = highestCompletedUpdateId;
    if (pendingUpdateIds.size > 0) {
      let minPending = null;
      for (const id of pendingUpdateIds) {
        if (minPending === null || id < minPending) {
          minPending = id;
        }
      }
      if (minPending !== null) {
        safe = Math.min(safe, minPending - 1);
      }
    }
    if (highestPersistedUpdateId !== null && safe <= highestPersistedUpdateId) {
      return;
    }
    highestPersistedUpdateId = safe;
    void opts.updateOffset.onUpdateId(safe);
  };
  const shouldSkipUpdate = (ctx) => {
    const updateId = resolveTelegramUpdateId(ctx);
    const skipCutoff = highestPersistedUpdateId ?? initialUpdateId;
    if (typeof updateId === "number" && skipCutoff !== null && updateId <= skipCutoff) {
      return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    if (skipped && key && shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
    return skipped;
  };
  bot.use(async (ctx, next) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number") {
      pendingUpdateIds.add(updateId);
    }
    try {
      await next();
    } finally {
      if (typeof updateId === "number") {
        pendingUpdateIds.delete(updateId);
        if (highestCompletedUpdateId === null || updateId > highestCompletedUpdateId) {
          highestCompletedUpdateId = updateId;
        }
        maybePersistSafeWatermark();
      }
    }
  });
  bot.use(sequentialize(getTelegramSequentialKey));
  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8e3;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update) => {
    const seen = /* @__PURE__ */ new WeakSet();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`
        ];
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  };
  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyUpdate(ctx.update);
        const preview = raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });
  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT
  );
  const groupHistories = /* @__PURE__ */ new Map();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom = opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const resolveGroupPolicy = (chatId) => resolveChannelGroupPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    groupId: String(chatId)
  });
  const resolveGroupActivation = (params) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey = params.sessionKey ?? `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    try {
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
    return void 0;
  };
  const resolveGroupRequireMention = (chatId) => resolveChannelGroupRequireMention({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    groupId: String(chatId),
    requireMentionOverride: opts.requireMention,
    overrideOrder: "after-config"
  });
  const resolveTelegramGroupConfig = (chatId, messageThreadId) => {
    const groups = telegramCfg.groups;
    const direct = telegramCfg.direct;
    const chatIdStr = String(chatId);
    const isDm = !chatIdStr.startsWith("-");
    if (isDm) {
      const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
      if (directConfig) {
        const topicConfig2 = messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : void 0;
        return { groupConfig: directConfig, topicConfig: topicConfig2 };
      }
      return { groupConfig: void 0, topicConfig: void 0 };
    }
    if (!groups) {
      return { groupConfig: void 0, topicConfig: void 0 };
    }
    const groupConfig = groups[chatIdStr] ?? groups["*"];
    const topicConfig = messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : void 0;
    return { groupConfig, topicConfig };
  };
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) => bot.api.sendChatAction(
      chatId,
      action,
      threadParams
    ),
    logger: (message) => logVerbose(`telegram: ${message}`)
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
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts
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
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts
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
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger
  });
  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args) => {
    threadBindingManager?.stop();
    return originalStop(...args);
  });
  return bot;
}
export {
  createTelegramBot,
  getTelegramSequentialKey
};
