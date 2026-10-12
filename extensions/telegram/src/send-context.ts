import { type ApiClientOptions, Bot, HttpError } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";
import {
  formatUncaughtError,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { createChannelApiRetryRunner, type RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { getOrCreateAccountThrottler, runAuthorizedTelegramRequest } from "./account-throttler.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport, type TelegramTransport } from "./fetch.js";
import { rethrowTelegramSendError, isSafeToRetrySendError } from "./network-errors.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import { getTelegramNativeQuoteReplyMessageId } from "./reply-parameters.js";
import {
  bindTelegramRequestAuthority,
  findTelegramRequestAuthorityError,
} from "./request-authority.js";
import type { TelegramRichMessageContextParams } from "./rich-message.js";
import { maybePersistResolvedTelegramTarget } from "./target-writeback.js";
import {
  hasRejectedTelegramTopic,
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  TELEGRAM_INVALID_TOPIC_ID_MESSAGE,
} from "./targets.js";

export type TelegramApi = Bot["api"];
export type TelegramApiOverride = Partial<TelegramApi>;
export type TelegramThreadScopedParams = {
  message_thread_id?: number;
  reply_parameters?: { message_id?: number };
  reply_to_message_id?: number;
};
export function resolveTelegramMessageIdOrThrow(
  result: TelegramMessageLike | null | undefined,
  context: string,
): number {
  if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) {
    return Math.trunc(result.message_id);
  }
  throw new Error(`Telegram ${context} returned no message_id`);
}

type TelegramOutboundSuccessLogParams = {
  accountId: string;
  chatId: string;
  messageId: string;
  operation: string;
  deliveryKind?: string;
  messageThreadId?: number;
  replyToMessageId?: number;
  silent?: boolean;
  chunkCount?: number;
};

export function logTelegramOutboundSendOk(params: TelegramOutboundSuccessLogParams): void {
  const parts = [
    "telegram outbound send ok",
    `accountId=${params.accountId}`,
    `chatId=${params.chatId}`,
    `messageId=${params.messageId}`,
    `operation=${params.operation}`,
    params.deliveryKind && `deliveryKind=${params.deliveryKind}`,
    typeof params.messageThreadId === "number" && `threadId=${params.messageThreadId}`,
    typeof params.replyToMessageId === "number" && `replyToMessageId=${params.replyToMessageId}`,
    params.silent === true && "silent=true",
    typeof params.chunkCount === "number" && `chunkCount=${params.chunkCount}`,
  ];
  sendLogger.info(parts.filter(Boolean).join(" "));
}

export function resolveAcceptedReplyToMessageId(
  params: TelegramThreadScopedParams | TelegramRichMessageContextParams | undefined,
): number | undefined {
  return params && "reply_to_message_id" in params
    ? params.reply_to_message_id
    : params?.reply_parameters?.message_id;
}

export function toAcceptedThreadScopedParams(
  params: Record<string, unknown> | undefined,
): TelegramThreadScopedParams | undefined {
  if (!params) {
    return undefined;
  }
  const scoped: TelegramThreadScopedParams = {};
  for (const key of ["message_thread_id", "reply_to_message_id"] as const) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      scoped[key] = value;
    }
  }
  const messageId = getTelegramNativeQuoteReplyMessageId(params);
  if (messageId !== undefined) {
    scoped.reply_parameters = { message_id: messageId };
  }
  return Object.keys(scoped).length > 0 ? scoped : undefined;
}

const MESSAGE_DELETE_NOOP_RE =
  /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
export const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
type CachedTelegramClientOptions = {
  clientOptions: ApiClientOptions & { fetch: NonNullable<ApiClientOptions["fetch"]> };
  transport: TelegramTransport;
};
const telegramClientOptionsCache = new Map<string, CachedTelegramClientOptions>();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;

export function resetTelegramClientOptionsCacheForTests(): void {
  for (const entry of telegramClientOptionsCache.values()) {
    closeCachedTelegramClientOptions(entry);
  }
  telegramClientOptionsCache.clear();
}

function createTelegramHttpLogger(cfg: OpenClawConfig) {
  if (!isDiagnosticFlagEnabled("telegram.http", cfg)) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) {
      return;
    }
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`telegram http error (${label}): ${detail}`);
  };
}

function closeCachedTelegramClientOptions(entry: CachedTelegramClientOptions): void {
  // Cache churn beyond 64 account/network configurations may interrupt a send.
  void entry.transport.close().catch((err: unknown) => {
    diagLogger.warn(
      `telegram client options cache transport close failed: ${redactSensitiveText(
        formatUncaughtError(err),
      )}`,
    );
  });
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): CachedTelegramClientOptions {
  const proxyKey = account.config.proxy?.trim() ?? "";
  const autoSelectFamily = account.config.network?.autoSelectFamily;
  const autoSelectFamilyKey =
    typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
  const dnsResultOrderKey = account.config.network?.dnsResultOrder ?? "default";
  const apiRootKey = account.config.apiRoot?.trim() ?? "";
  const cacheKey = `${account.accountId}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}`;
  const cached = telegramClientOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const normalizedApiRoot = apiRootKey ? normalizeTelegramApiRoot(apiRootKey) : undefined;
  const proxyFetch = proxyKey ? makeProxyFetch(proxyKey) : undefined;
  const transport = resolveTelegramTransport(proxyFetch, { network: account.config.network });
  const fetchImpl = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(transport.fetch),
    transport,
  });
  const entry: CachedTelegramClientOptions = {
    clientOptions: {
      fetch: asTelegramClientFetch(fetchImpl),
      ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
    },
    transport,
  };
  telegramClientOptionsCache.set(cacheKey, entry);
  if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
    for (const [oldestKey, evictedEntry] of telegramClientOptionsCache) {
      telegramClientOptionsCache.delete(oldestKey);
      closeCachedTelegramClientOptions(evictedEntry);
      break;
    }
  }
  return entry;
}

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.token) {
    throw new Error(
      `Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

async function resolveChatId(
  to: string,
  params: { api: TelegramApiOverride; verbose?: boolean },
): Promise<string> {
  const numericChatId = normalizeTelegramChatId(to);
  if (numericChatId) {
    return numericChatId;
  }
  const lookupTarget = normalizeTelegramLookupTarget(to);
  const getChat = params.api.getChat;
  if (!lookupTarget || typeof getChat !== "function") {
    throw new Error(
      hasRejectedTelegramTopic(to)
        ? TELEGRAM_INVALID_TOPIC_ID_MESSAGE
        : "Telegram recipient must be a numeric chat ID",
    );
  }
  try {
    const chat = await getChat.call(params.api, lookupTarget);
    const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
    if (!resolved) {
      throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
    }
    if (params.verbose) {
      sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
    }
    return resolved;
  } catch (err) {
    const detail = formatErrorMessage(err);
    throw new Error(
      `Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`,
      { cause: err },
    );
  }
}

export async function resolveAndPersistChatId(
  context: Pick<TelegramApiContext, "cfg" | "api">,
  params: {
    lookupTarget: string;
    persistTarget: string;
    verbose?: boolean;
    gatewayClientScopes?: readonly string[];
  },
): Promise<string> {
  const chatId = await resolveChatId(params.lookupTarget, {
    api: context.api,
    verbose: params.verbose,
  });
  await maybePersistResolvedTelegramTarget({
    cfg: context.cfg,
    rawTarget: params.persistTarget,
    resolvedChatId: chatId,
    verbose: params.verbose,
    gatewayClientScopes: params.gatewayClientScopes,
    ...(params.gatewayClientScopes === undefined ? { trustedInternalWriteback: true } : {}),
  });
  return chatId;
}

export function normalizeMessageId(raw: string | number): number {
  const parsed = typeof raw === "string" ? parseStrictInteger(raw) : raw;
  if (typeof parsed === "number" && Number.isFinite(parsed)) {
    return Math.trunc(parsed);
  }
  throw new Error("Message id is required for Telegram actions");
}

export function isTelegramMessageDeleteNoopError(err: unknown): boolean {
  return MESSAGE_DELETE_NOOP_RE.test(formatErrorMessage(err));
}

export type TelegramApiContext = {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  ownerAgentId: string;
  api: TelegramApi;
};

export async function withTelegramApiContext<T>(
  opts: {
    token?: string;
    accountId?: string;
    api?: TelegramApiOverride;
    cfg: OpenClawConfig;
    signal?: AbortSignal;
    assertPlatformSendAuthorized?: () => void;
  },
  operation: (context: TelegramApiContext) => Promise<T>,
): Promise<T> {
  const cfg = requireRuntimeConfig(opts.cfg, "Telegram API context");
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  let ownerAgentId: string;
  try {
    ownerAgentId = resolveTelegramAccountOwnerAgentId({ cfg, accountId: account.accountId });
  } catch (error) {
    // Ownership is local preflight, before a Bot API operation.
    throw new PlatformMessageNotDispatchedError(formatErrorMessage(error), {
      cause: error,
      retryable: false,
    });
  }
  let api: TelegramApi;
  if (opts.api) {
    api = opts.api as TelegramApi;
  } else {
    const client = resolveTelegramClientOptions(account);
    const fetch = client.clientOptions.fetch;
    const clientOptions = opts.assertPlatformSendAuthorized
      ? {
          ...client.clientOptions,
          fetch: bindTelegramRequestAuthority(fetch, opts.assertPlatformSendAuthorized),
        }
      : client.clientOptions;
    const bot = new Bot(token, { client: clientOptions });
    if (opts.signal || opts.assertPlatformSendAuthorized) {
      // grammY wraps later transformers around earlier ones. Check authority
      // after the account queue drains, immediately before its HTTP client runs.
      bot.api.config.use((prev, method, payload, signal) => {
        opts.signal?.throwIfAborted();
        opts.assertPlatformSendAuthorized?.();
        return prev(method, payload, signal).catch((error: unknown) => {
          const rejection =
            error instanceof HttpError ? findTelegramRequestAuthorityError(error.error) : undefined;
          if (rejection) {
            throw rejection.originalError;
          }
          throw error;
        });
      });
    }
    bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
    api = bot.api;
  }
  const context = {
    cfg,
    account,
    ownerAgentId,
    api,
  };
  const assertCurrent = opts.assertPlatformSendAuthorized
    ? () => {
        opts.signal?.throwIfAborted();
        opts.assertPlatformSendAuthorized?.();
      }
    : undefined;
  // A caller-supplied API has no authority transformer; flood waits re-check here.
  return await runAuthorizedTelegramRequest(assertCurrent, () => operation(context));
}

type TelegramRequestWithDiag = <T>(
  fn: () => Promise<T>,
  label: string,
  options?: { shouldLog?: (err: unknown) => boolean },
) => Promise<T>;

export function createTelegramRequestWithDiag(params: {
  cfg: OpenClawConfig;
  retry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  /** When true, the shouldRetry predicate is used exclusively without the TELEGRAM_RETRY_RE fallback. */
  strictShouldRetry?: boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  const request = createChannelApiRetryRunner({
    retry: params.retry,
    verbose: params.verbose,
    ...(params.shouldRetry ? { shouldRetry: params.shouldRetry } : {}),
    ...(params.strictShouldRetry ? { strictShouldRetry: true } : {}),
  });
  const logHttpError = createTelegramHttpLogger(params.cfg);
  return (fn, label, options) => {
    const runRequest = () => request(fn, label);
    const call =
      params.useApiErrorLogging === false
        ? runRequest()
        : withTelegramApiErrorLogging({
            operation: label,
            fn: runRequest,
            ...(options?.shouldLog ? { shouldLog: options.shouldLog } : {}),
          });
    return call.catch((err: unknown) => {
      logHttpError(label, err);
      throw err;
    });
  };
}

function wrapTelegramChatNotFoundError(err: unknown, params: { chatId: string; input: string }) {
  const errorMsg = formatErrorMessage(err);

  if (/403.*(bot.*not.*member|bot.*blocked|bot.*kicked)/i.test(errorMsg)) {
    return new Error(
      [
        `Telegram send failed: bot is not a member of the chat, was blocked, or was kicked (chat_id=${params.chatId}).`,
        `Telegram API said: ${errorMsg}.`,
        "Fix: Add the bot to the channel/group, or ensure it has not been removed/blocked/kicked by the user.",
        `Input was: ${JSON.stringify(params.input)}.`,
      ].join(" "),
    );
  }

  if (!CHAT_NOT_FOUND_RE.test(errorMsg)) {
    return err;
  }
  return new Error(
    [
      `Telegram send failed: chat not found (chat_id=${params.chatId}).`,
      "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
      `Input was: ${JSON.stringify(params.input)}.`,
    ].join(" "),
  );
}

export function createRequestWithChatNotFound(params: {
  requestWithDiag: TelegramRequestWithDiag;
  chatId: string;
  input: string;
}): TelegramRequestWithDiag {
  return async (fn, label, options) =>
    params.requestWithDiag(fn, label, options).catch((err: unknown) => {
      throw wrapTelegramChatNotFoundError(err, params);
    });
}

export function createTelegramNonIdempotentRequestWithDiag(params: {
  cfg: OpenClawConfig;
  retry?: RetryConfig;
  verbose?: boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  const request = createTelegramRequestWithDiag({
    ...params,
    shouldRetry: isSafeToRetrySendError,
    strictShouldRetry: true,
  });
  return (fn, label, options) => request(fn, label, options).catch(rethrowTelegramSendError);
}
