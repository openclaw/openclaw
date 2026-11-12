import {
  AgentHarnessModelRequestPolicyError,
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { markAuthProfileBlockedUntil } from "openclaw/plugin-sdk/agent-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type CodexServerNotification, type JsonValue } from "./protocol.js";
import {
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";
import {
  formatCodexUsageLimitErrorMessage,
  resolveCodexUsageLimitResetAtMs,
  shouldRefreshCodexRateLimitsForUsageLimitMessage,
} from "./rate-limits.js";
import { CodexAppServerRpcError } from "./rpc-error.js";

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

// HTTP 429 alone is not subscription exhaustion and must not inherit its reset cooldown.
export class CodexUsageLimitPromptError extends Error {
  readonly status = 429;
}

export function resolveCodexPromptError(
  source: Pick<CodexUsageLimitErrorSource, "message" | "codexErrorInfo" | "rateLimits">,
): string | Error | undefined {
  const usageLimitMessage = formatCodexUsageLimitErrorMessage(source);
  if (usageLimitMessage) {
    return new CodexUsageLimitPromptError(usageLimitMessage);
  }
  // Native retry exhaustion is not a permanent model/configuration failure.
  // Preserve the provider facts before terminal projection drops the native envelope.
  const info = source.codexErrorInfo;
  let status =
    info === "rateLimitExceeded"
      ? 429
      : info === "serverOverloaded"
        ? 503
        : info === "internalServerError"
          ? 500
          : undefined;
  if (isJsonObject(info)) {
    for (const variant of [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ]) {
      const detail = info[variant];
      if (isJsonObject(detail) && typeof detail.httpStatusCode === "number") {
        status = detail.httpStatusCode;
        break;
      }
    }
  }
  if (
    isJsonObject(info) &&
    Object.keys(info).length === 1 &&
    isJsonObject(info.httpConnectionFailed) &&
    info.httpConnectionFailed.httpStatusCode === 403 &&
    isRequestPolicyDenial(source.message)
  ) {
    return new AgentHarnessModelRequestPolicyError();
  }
  return status === undefined
    ? (source.message ?? undefined)
    : Object.assign(new Error(source.message ?? "codex app-server error"), {
        status,
        ...(info === "serverOverloaded" ? { code: "OVERLOADED" } : {}),
      });
}

function isRequestPolicyDenial(message: string | null | undefined): boolean {
  const prefix = "unexpected status 403 Forbidden: ";
  if (!message || message.length > 8_192 || !message.startsWith(prefix)) {
    return false;
  }
  const body = message.slice(prefix.length);
  // Parse one complete object before independently optional native transport metadata.
  for (let end = body.indexOf("}"); end !== -1; end = body.indexOf("}", end + 1)) {
    const suffix = body.slice(end + 1);
    if (
      suffix &&
      !/^, (?:url|cf-ray|request id|auth error|auth error code): [^\r\n]*$/.test(suffix)
    ) {
      continue;
    }
    try {
      const error: unknown = JSON.parse(body.slice(0, end + 1));
      return (
        isJsonObject(error) &&
        error.error === "middleware_denied" &&
        error.reason_code === "request_credential_denied" &&
        error.layer === "l7"
      );
    } catch {
      // A closing brace in a string or nested object is not the end of the envelope.
    }
  }
  return false;
}

export async function markCodexAuthProfileBlockedFromRateLimits(params: {
  params: EmbeddedRunAttemptParams;
  authProfileId?: string;
  rateLimits?: JsonValue;
}): Promise<void> {
  const authProfileId = params.authProfileId?.trim();
  if (!authProfileId || !params.params.authProfileStore) {
    return;
  }
  const blockedUntil = resolveCodexUsageLimitResetAtMs(params.rateLimits);
  if (!blockedUntil) {
    return;
  }
  try {
    await markAuthProfileBlockedUntil({
      store: params.params.authProfileStore,
      profileId: authProfileId,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: params.params.agentDir,
      runId: params.params.runId,
      modelId: params.params.modelId,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to mark Codex auth profile blocked from app-server limits", {
      authProfileId,
      error: formatErrorMessage(error),
    });
  }
}

export async function resolveCodexTurnStartError(params: {
  client: CodexAppServerClient;
  error: unknown;
  errorNotification?: CodexServerNotification;
  rateLimitsRevisionBeforeTurnStart?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<(CodexUsageLimitErrorResult & { promptError: Error }) | undefined> {
  const source = readCodexTurnStartUsageLimitErrorSource(
    params.client,
    params.error,
    params.errorNotification,
    params.rateLimitsRevisionBeforeTurnStart,
  );
  const usageLimit = await refreshCodexUsageLimitError({ ...params, source });
  if (usageLimit) {
    return { ...usageLimit, promptError: new CodexUsageLimitPromptError(usageLimit.message) };
  }
  // Startup RPC errors carry the same provider facts as terminal notifications.
  // Normalize them before the generic runner loses the native error envelope.
  const promptError = resolveCodexPromptError(source);
  return promptError instanceof Error ? { message: promptError.message, promptError } : undefined;
}

export async function refreshCodexUsageLimitPromptError(params: {
  client: CodexAppServerClient;
  message: string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(params.message)) {
    return undefined;
  }
  return refreshCodexUsageLimitError({
    ...params,
    source: {
      message: params.message,
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: readRecentCodexRateLimits(params.client),
    },
  });
}

async function refreshCodexUsageLimitError(params: {
  client: CodexAppServerClient;
  source: CodexUsageLimitErrorSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  const initialMessage = formatCodexUsageLimitErrorMessage(params.source);
  const rateLimits = shouldRefreshCodexRateLimitsForUsageLimitMessage(initialMessage)
    ? await readCodexRateLimitsFromAppServerForUsageLimitError(params)
    : undefined;
  const message = rateLimits
    ? (formatCodexUsageLimitErrorMessage({
        ...params.source,
        rateLimits,
        rateLimitsAuthoritative: true,
      }) ?? initialMessage)
    : initialMessage;
  return message
    ? {
        message,
        ...(rateLimits || params.source.rateLimitsTrustedForProfile
          ? { rateLimitsForProfile: rateLimits || params.source.rateLimits }
          : {}),
      }
    : undefined;
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
  // Explicit RPC failures own their facts; unbound notices only enrich a matching local error.
  const source =
    !(error instanceof CodexAppServerRpcError) &&
    notificationError?.codexErrorInfo != null &&
    errorPayload.codexErrorInfo == null &&
    notificationError.message === errorPayload.message
      ? notificationError
      : errorPayload;
  // The cached snapshot may predate this attempt or belong to another turn on
  // the same process. Trust it for the auth profile only when this client saw
  // a primary update after this turn's startup began.
  const cacheUpdatedDuringTurnStart =
    rateLimitsRevisionBeforeTurnStart !== undefined &&
    readCodexRateLimitsRevision(client) > rateLimitsRevisionBeforeTurnStart;
  return {
    message: source.message,
    codexErrorInfo: source.codexErrorInfo,
    rateLimits,
    rateLimitsTrustedForProfile:
      errorPayload.rateLimits !== undefined || cacheUpdatedDuringTurnStart,
  };
}

function readCodexErrorNotification(
  notification: CodexServerNotification | undefined,
): { message?: string; codexErrorInfo?: JsonValue | null } | undefined {
  if (
    notification?.method !== "error" ||
    !isJsonObject(notification.params) ||
    notification.params.willRetry === true
  ) {
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
  const data = error.data;
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
