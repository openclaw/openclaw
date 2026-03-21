import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatUncaughtError } from "openclaw/plugin-sdk/infra-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { apiThrottler, Bot, sequentialize, type ApiClientOptions } from "./bot.runtime.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramTransport, type TelegramTransport } from "./fetch.js";
import { tagTelegramNetworkError } from "./network-errors.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type TelegramBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: OpenClawConfig;
  /** Signal to abort in-flight Telegram API fetch requests (e.g. getUpdates) on shutdown. */
  fetchAbortSignal?: AbortSignal;
  updateOffset?: {
    lastUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
  testTimings?: {
    mediaGroupFlushMs?: number;
    textFragmentGapMs?: number;
  };
  /** Pre-resolved Telegram transport to reuse across bot instances. If not provided, creates a new one. */
  telegramTransport?: TelegramTransport;
  telegramDeps?: TelegramBotDeps;
  onRecoverableSendChatActionNetworkFailure?: (params: {
    error: unknown;
    consecutiveFailures: number;
  }) => void | Promise<void>;
};

export { getTelegramSequentialKey };

type TelegramBotRuntime = {
  Bot: typeof Bot;
  sequentialize: typeof sequentialize;
  apiThrottler: typeof apiThrottler;
};

const DEFAULT_TELEGRAM_BOT_RUNTIME: TelegramBotRuntime = {
  Bot,
  sequentialize,
  apiThrottler,
};

const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45_000;

let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}

type TelegramFetchInput = Parameters<NonNullable<ApiClientOptions["fetch"]>>[0];
type TelegramFetchInit = Parameters<NonNullable<ApiClientOptions["fetch"]>>[1];
type GlobalFetchInput = Parameters<typeof globalThis.fetch>[0];
type GlobalFetchInit = Parameters<typeof globalThis.fetch>[1];

function readRequestUrl(input: TelegramFetchInput): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = (input as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

function extractTelegramApiMethod(input: TelegramFetchInput): string | null {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const method = segments.length > 0 ? (segments.at(-1) ?? null) : null;
    return method?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function shouldMarkTelegramNetworkHealthy(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }

  const typed = response as {
    ok?: unknown;
    status?: unknown;
    headers?: unknown;
  };

  if (typed.ok === true) {
    return true;
  }

  if (typeof typed.status !== "number" || !Number.isFinite(typed.status)) {
    return false;
  }

  if (typed.status < 400 || typed.status === 407) {
    return false;
  }

  const headers =
    typed.headers &&
    typeof typed.headers === "object" &&
    "get" in typed.headers &&
    typeof (typed.headers as { get?: unknown }).get === "function"
      ? (typed.headers as { get: (name: string) => string | null })
      : undefined;

  if (!headers) {
    return false;
  }

  // Telegram Bot API rejections are JSON responses. Proxy-generated 4xx responses
  // such as 407 often come back as plaintext/HTML before the request ever reaches
  // Telegram, so they must not clear the outage streak.
  // JSON 5xx responses also imply round-trip connectivity to Telegram and should
  // reset the outage streak.
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
}

export function createTelegramBot(opts: TelegramBotOptions) {
  const botRuntime = telegramBotRuntimeForTest ?? DEFAULT_TELEGRAM_BOT_RUNTIME;
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const telegramDeps = opts.telegramDeps ?? defaultTelegramBotDeps;
  const cfg = opts.config ?? telegramDeps.loadConfig();
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
  const shouldProvideFetch = Boolean(telegramTransport.fetch);
  // grammY's ApiClientOptions types still track `node-fetch` types; Node 22+ global fetch
  // (undici) is structurally compatible at runtime but not assignable in TS.
  const fetchForClient = telegramTransport.fetch as unknown as NonNullable<
    ApiClientOptions["fetch"]
  >;
  let noteTelegramNetworkHealthy: (() => void) | undefined;

  // Wrap fetch so polling requests cannot hang indefinitely on a wedged network path,
  // and so shutdown still aborts in-flight Telegram API requests immediately.
  let finalFetch = shouldProvideFetch ? fetchForClient : undefined;
  if (finalFetch || opts.fetchAbortSignal) {
    const baseFetch =
      finalFetch ?? (globalThis.fetch as unknown as NonNullable<ApiClientOptions["fetch"]>);
    // Cast baseFetch to global fetch to avoid node-fetch ↔ global-fetch type divergence;
    // they are runtime-compatible (the codebase already casts at every fetch boundary).
    const callFetch = baseFetch as unknown as typeof globalThis.fetch;
    // Use manual event forwarding instead of AbortSignal.any() to avoid the cross-realm
    // AbortSignal issue in Node.js (grammY's signal may come from a different module context,
    // causing "signals[0] must be an instance of AbortSignal" errors).
    finalFetch = ((input: TelegramFetchInput, init?: TelegramFetchInit) => {
      const controller = new AbortController();
      const abortWith = (signal: AbortSignal) => controller.abort(signal.reason);
      const shutdownSignal = opts.fetchAbortSignal;
      const onShutdown = () => abortWith(shutdownSignal as AbortSignal);
      const method = extractTelegramApiMethod(input);
      const requestTimeoutMs =
        method === "getupdates" ? TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS : undefined;
      let requestTimeout: ReturnType<typeof setTimeout> | undefined;
      let onRequestAbort: (() => void) | undefined;
      if (shutdownSignal?.aborted) {
        abortWith(shutdownSignal);
      } else if (shutdownSignal) {
        shutdownSignal.addEventListener("abort", onShutdown, { once: true });
      }
      if (init?.signal) {
        if (init.signal.aborted) {
          abortWith(init.signal as unknown as AbortSignal);
        } else {
          onRequestAbort = () => abortWith(init.signal as AbortSignal);
          init.signal.addEventListener("abort", onRequestAbort);
        }
      }
      if (requestTimeoutMs) {
        requestTimeout = setTimeout(() => {
          controller.abort(new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        requestTimeout.unref?.();
      }
      return callFetch(input as GlobalFetchInput, {
        ...(init as GlobalFetchInit),
        signal: controller.signal,
      }).finally(() => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        shutdownSignal?.removeEventListener("abort", onShutdown);
        if (init?.signal && onRequestAbort) {
          init.signal.removeEventListener("abort", onRequestAbort);
        }
      });
    }) as unknown as NonNullable<ApiClientOptions["fetch"]>;
  }
  if (finalFetch) {
    const baseFetch = finalFetch;
    finalFetch = ((input: TelegramFetchInput, init?: TelegramFetchInit) => {
      return Promise.resolve(baseFetch(input, init))
        .then((response) => {
          if (shouldMarkTelegramNetworkHealthy(response)) {
            noteTelegramNetworkHealthy?.();
          }
          return response;
        })
        .catch((err: unknown) => {
          try {
            tagTelegramNetworkError(err, {
              method: extractTelegramApiMethod(input),
              url: readRequestUrl(input),
            });
          } catch {
            // Tagging is best-effort; preserve the original fetch failure if the
            // error object cannot accept extra metadata.
          }
          throw err;
        });
    }) as unknown as NonNullable<ApiClientOptions["fetch"]>;
  }

  const timeoutSeconds =
    typeof telegramCfg?.timeoutSeconds === "number" && Number.isFinite(telegramCfg.timeoutSeconds)
      ? Math.max(1, Math.floor(telegramCfg.timeoutSeconds))
      : undefined;
  const apiRoot = telegramCfg.apiRoot?.trim() || undefined;
  const client: ApiClientOptions | undefined =
    finalFetch || timeoutSeconds || apiRoot
      ? {
          ...(finalFetch ? { fetch: finalFetch } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(apiRoot ? { apiRoot } : {}),
        }
      : undefined;

  const bot = new botRuntime.Bot(opts.token, client ? { client } : undefined);
  bot.api.config.use(botRuntime.apiThrottler());
  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const recentUpdates = createTelegramUpdateDedupe();
  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;

  // Track update_ids that have entered the middleware pipeline but have not completed yet.
  // This includes updates that are "queued" behind sequentialize(...) for a chat/topic key.
  // We only persist a watermark that is strictly less than the smallest pending update_id,
  // so we never write an offset that would skip an update still waiting to run.
  const pendingUpdateIds = new Set<number>();
  let highestCompletedUpdateId: number | null = initialUpdateId;
  let highestPersistedUpdateId: number | null = initialUpdateId;
  const maybePersistSafeWatermark = () => {
    if (typeof opts.updateOffset?.onUpdateId !== "function") {
      return;
    }
    if (highestCompletedUpdateId === null) {
      return;
    }
    let safe = highestCompletedUpdateId;
    if (pendingUpdateIds.size > 0) {
      let minPending: number | null = null;
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

  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) => {
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

  bot.use(botRuntime.sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update: unknown) => {
    const seen = new WeakSet();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`,
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
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
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
        cfg: telegramDeps.loadConfig(),
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
    const groups = freshTelegramCfg.groups;
    const direct = freshTelegramCfg.direct;
    const chatIdStr = String(chatId);
    const isDm = !chatIdStr.startsWith("-");

    if (isDm) {
      const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
      if (directConfig) {
        const topicConfig =
          messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : undefined;
        return { groupConfig: directConfig, topicConfig };
      }
      // DMs without direct config: don't fall through to groups lookup
      return { groupConfig: undefined, topicConfig: undefined };
    }

    if (!groups) {
      return { groupConfig: undefined, topicConfig: undefined };
    }
    const groupConfig = groups[chatIdStr] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  // Global sendChatAction handler with 401 backoff / circuit breaker (issue #27092).
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(
        chatId,
        action,
        threadParams as Parameters<typeof bot.api.sendChatAction>[2],
      ),
    logger: (message) => logVerbose(`telegram: ${message}`),
    onRecoverableNetworkFailure: opts.onRecoverableSendChatActionNetworkFailure,
  });
  noteTelegramNetworkHealthy = () => {
    sendChatActionHandler.noteNetworkHealthy();
  };

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
    loadFreshConfig: () => telegramDeps.loadConfig(),
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    telegramDeps,
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
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
    telegramDeps,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
