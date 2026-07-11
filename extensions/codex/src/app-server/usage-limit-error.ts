/**
 * Enriches Codex usage-limit failures with current rate-limit information and
 * marks blocked auth profiles when Codex exposes a reset time.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  markAuthProfileBlockedUntil,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveCodexAppServerAuthProfileStore } from "./auth-bridge.js";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";
import {
  formatCodexUsageLimitErrorMessage,
  isCodexUsageLimitError,
  resolveCodexUsageLimitResetAtMs,
  shouldRefreshCodexRateLimitsForUsageLimitMessage,
} from "./rate-limits.js";

const CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS = 5_000;

type CodexUsageLimitErrorSource = {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  rateLimitsTrustedForProfile?: boolean;
};

type CodexUsageLimitErrorResult = {
  message: string;
  rateLimitsForProfile?: JsonValue;
};

/** Marks a Codex auth profile blocked until the reset time advertised by rate limits. */
export async function markCodexAuthProfileBlockedFromRateLimits(params: {
  params: EmbeddedRunAttemptParams;
  authProfileId?: string;
  rateLimits?: JsonValue;
}): Promise<void> {
  await markCodexAuthProfileBlockedUntilReset({
    authProfileId: params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    runId: params.params.runId,
    modelId: params.params.modelId,
    rateLimits: params.rateLimits,
  });
}

async function markCodexAuthProfileBlockedUntilReset(params: {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  runId?: string;
  modelId?: string;
  rateLimits?: JsonValue;
}): Promise<void> {
  const authProfileId = params.authProfileId?.trim();
  if (!authProfileId || !params.authProfileStore) {
    return;
  }
  const blockedUntil = resolveCodexUsageLimitResetAtMs(params.rateLimits);
  if (!blockedUntil) {
    return;
  }
  try {
    await markAuthProfileBlockedUntil({
      store: params.authProfileStore,
      profileId: authProfileId,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: params.agentDir,
      runId: params.runId,
      modelId: params.modelId,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to mark Codex auth profile blocked from app-server limits", {
      authProfileId,
      error: formatErrorMessage(error),
    });
  }
}

/** Error thrown when a bounded Codex turn fails on a subscription usage limit. */
export class CodexBoundedTurnUsageLimitError extends Error {
  readonly authProfileId?: string;

  constructor(message: string, options?: { authProfileId?: string }) {
    super(message);
    this.name = "CodexBoundedTurnUsageLimitError";
    if (options?.authProfileId) {
      this.authProfileId = options.authProfileId;
    }
  }
}

/**
 * Converts a bounded-turn failure into a reset-aware usage-limit error while
 * the app-server client is still open, marking the auth profile blocked when
 * Codex reports a reset time. Returns undefined for non-usage-limit failures.
 */
export async function resolveCodexBoundedTurnUsageLimitError(params: {
  client: CodexAppServerClient;
  error: unknown;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileStore>[0]["config"];
  modelId?: string;
  rateLimitsRevisionBeforeTurnStart?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexBoundedTurnUsageLimitError | undefined> {
  const source = readCodexTurnStartUsageLimitErrorSource(
    params.client,
    params.error,
    undefined,
    params.rateLimitsRevisionBeforeTurnStart,
  );
  if (!isCodexUsageLimitError(source.codexErrorInfo, source.message ?? undefined)) {
    return undefined;
  }
  const refreshed = await refreshCodexUsageLimitError({
    client: params.client,
    source,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  const authProfileId = params.authProfileId?.trim();
  await markCodexAuthProfileBlockedUntilReset({
    authProfileId,
    // Callers without a supplied store (for example hosted web search) still
    // persist the block through the agent-dir store.
    authProfileStore:
      params.authProfileStore ??
      resolveCodexAppServerAuthProfileStore({
        agentDir: params.agentDir,
        authProfileId,
        config: params.config,
      }),
    agentDir: params.agentDir,
    modelId: params.modelId,
    rateLimits: refreshed?.rateLimitsForProfile,
  });
  return new CodexBoundedTurnUsageLimitError(
    refreshed?.message ?? source.message ?? formatErrorMessage(params.error),
    authProfileId ? { authProfileId } : undefined,
  );
}

/** Formats a turn-start usage-limit error, refreshing rate limits when needed. */
export async function formatCodexTurnStartUsageLimitError(params: {
  client: CodexAppServerClient;
  error: unknown;
  errorNotification?: CodexServerNotification;
  rateLimitsRevisionBeforeTurnStart?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  return refreshCodexUsageLimitError({
    client: params.client,
    source: readCodexTurnStartUsageLimitErrorSource(
      params.client,
      params.error,
      params.errorNotification,
      params.rateLimitsRevisionBeforeTurnStart,
    ),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

/** Refreshes a generic prompt usage-limit message into a reset-aware message. */
export async function refreshCodexUsageLimitPromptError(params: {
  client: CodexAppServerClient;
  message: string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(params.message)) {
    return undefined;
  }
  return (
    await refreshCodexUsageLimitError({
      client: params.client,
      source: {
        message: params.message,
        codexErrorInfo: "usageLimitExceeded",
        rateLimits: readRecentCodexRateLimits(params.client),
      },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    })
  )?.message;
}

async function refreshCodexUsageLimitError(params: {
  client: CodexAppServerClient;
  source: CodexUsageLimitErrorSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  const initialMessage = formatCodexUsageLimitErrorMessage(params.source);
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(initialMessage)) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const rateLimits = await readCodexRateLimitsFromAppServerForUsageLimitError({
    client: params.client,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  if (!rateLimits) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const refreshedMessage = formatCodexUsageLimitErrorMessage({
    message: params.source.message,
    codexErrorInfo: params.source.codexErrorInfo,
    rateLimits,
  });
  const message = refreshedMessage ?? initialMessage;
  return message ? { message, rateLimitsForProfile: rateLimits } : undefined;
}

async function readCodexRateLimitsFromAppServerForUsageLimitError(params: {
  client: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  if (params.signal?.aborted) {
    return undefined;
  }
  try {
    const rateLimits = await params.client.request(CODEX_CONTROL_METHODS.rateLimits, undefined, {
      timeoutMs: resolveCodexUsageLimitRateLimitRefreshTimeoutMs(params.timeoutMs),
      signal: params.signal,
    });
    rememberCodexRateLimitsRead(params.client, rateLimits);
    return rateLimits;
  } catch (error) {
    embeddedAgentLog.debug("codex app-server rate-limit refresh failed after usage-limit error", {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

function resolveCodexUsageLimitRateLimitRefreshTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(timeoutMs, CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS));
}

function readCodexTurnStartUsageLimitErrorSource(
  client: CodexAppServerClient,
  error: unknown,
  errorNotification: CodexServerNotification | undefined,
  rateLimitsRevisionBeforeTurnStart: number | undefined,
): CodexUsageLimitErrorSource {
  const notificationError = readCodexErrorNotification(errorNotification);
  const errorPayload = readCodexErrorPayload(error);
  const rateLimits = errorPayload.rateLimits ?? readRecentCodexRateLimits(client);
  // The cached snapshot may predate this attempt or belong to another turn on
  // the same process. Trust it for the auth profile only when this client saw
  // a primary update after this turn's startup began.
  const cacheUpdatedDuringTurnStart =
    rateLimitsRevisionBeforeTurnStart !== undefined &&
    readCodexRateLimitsRevision(client) > rateLimitsRevisionBeforeTurnStart;
  return {
    message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
    codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
    rateLimits,
    rateLimitsTrustedForProfile:
      errorPayload.rateLimits !== undefined || cacheUpdatedDuringTurnStart,
  };
}

function readCodexErrorNotification(
  notification: CodexServerNotification | undefined,
): { message?: string; codexErrorInfo?: JsonValue | null } | undefined {
  if (notification?.method !== "error" || !isJsonObject(notification.params)) {
    return undefined;
  }
  const error = notification.params.error;
  return isJsonObject(error)
    ? {
        message: readString(error, "message"),
        codexErrorInfo: error.codexErrorInfo,
      }
    : undefined;
}

function readCodexErrorPayload(error: unknown): {
  message?: string;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
} {
  const message = error instanceof Error ? error.message : undefined;
  if (!error || typeof error !== "object" || !("data" in error)) {
    return { message };
  }
  const data = (error as { data?: unknown }).data as JsonValue | undefined;
  if (!isJsonObject(data)) {
    return { message };
  }
  const nestedError = isJsonObject(data.error) ? data.error : data;
  const rateLimits = nestedError.rateLimits ?? data.rateLimits;
  return {
    message: readString(nestedError, "message") ?? message,
    codexErrorInfo: nestedError.codexErrorInfo,
    rateLimits,
  };
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
