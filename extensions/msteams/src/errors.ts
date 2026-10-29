import { asFiniteNumberInRange, asSafeIntegerInRange } from "openclaw/plugin-sdk/number-runtime";
import {
  isTransientNetworkError,
  parseRetryAfterHeaderSeconds,
} from "openclaw/plugin-sdk/retry-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "symbol") {
    return err.description ?? err.toString();
  }
  if (typeof err === "function") {
    return err.name ? `[function ${err.name}]` : "[function]";
  }
  if (err === null || typeof err !== "object") {
    return String(err);
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function extractStatusCode(err: Record<string, unknown>): number | null {
  const range = { min: 100, max: 599 };
  const directStatus = asSafeIntegerInRange(err.statusCode ?? err.status, range);
  if (directStatus !== undefined) {
    return directStatus;
  }

  const response = err.response;
  return isRecord(response) ? (asSafeIntegerInRange(response.status, range) ?? null) : null;
}

function extractRetryAfterMs(err: Record<string, unknown>): number | null {
  const directMs = asFiniteNumberInRange(err.retryAfterMs, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (directMs !== undefined) {
    return directMs;
  }

  const response = err.response;
  if (!isRecord(response)) {
    return null;
  }

  const headers = response.headers;
  if (!headers) {
    return null;
  }

  if (isRecord(headers)) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string") {
      const parsed = parseRetryAfterHeaderSeconds(raw);
      if (parsed !== undefined) {
        return parsed * 1000;
      }
    }
  }

  if (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
    if (raw) {
      const parsed = parseRetryAfterHeaderSeconds(raw);
      if (parsed !== undefined) {
        return parsed * 1000;
      }
    }
  }

  return null;
}

type MSTeamsSendErrorMetadata = {
  statusCode?: number;
  errorCode?: string;
};

type MSTeamsSendErrorClassification =
  | (MSTeamsSendErrorMetadata & { kind: "auth" })
  | (MSTeamsSendErrorMetadata & {
      kind: "replay-safe";
      statusCode: 429;
      retryAfterMs?: number;
    })
  | (MSTeamsSendErrorMetadata & {
      kind: "ambiguous";
      source: "http" | "transport";
    })
  | (MSTeamsSendErrorMetadata & { kind: "permanent" })
  | (MSTeamsSendErrorMetadata & { kind: "unknown" });

/**
 * Owns retry safety and delivery ambiguity for Teams send failures.
 * Only Teams rate-limit rejection proves this unkeyed POST safe to replay.
 */
export function classifyMSTeamsSendError(err: unknown): MSTeamsSendErrorClassification {
  const error = isRecord(err) ? err : {};
  const statusCode = extractStatusCode(error);
  const retryAfterMs = extractRetryAfterMs(error);
  const errorCode = typeof error.code === "string" && error.code.trim() ? error.code : undefined;

  if (statusCode === 401) {
    return { kind: "auth", statusCode, errorCode };
  }

  if (statusCode === 403) {
    if (errorCode === "ContentStreamNotAllowed") {
      return { kind: "permanent", statusCode, errorCode };
    }
    return { kind: "auth", statusCode, errorCode };
  }

  if (statusCode === 429) {
    return {
      kind: "replay-safe",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
      errorCode,
    };
  }

  if (statusCode === 408 || (statusCode != null && statusCode >= 500)) {
    return {
      kind: "ambiguous",
      source: "http",
      statusCode,
      errorCode,
    };
  }

  if (statusCode != null && statusCode >= 400) {
    return { kind: "permanent", statusCode, errorCode };
  }

  // A transport failure can happen after the Connector accepted the POST.
  // Preserve its code for diagnostics without implying replay is safe.
  if (statusCode == null && isTransientNetworkError(err)) {
    return { kind: "ambiguous", source: "transport", errorCode };
  }

  return {
    kind: "unknown",
    statusCode: statusCode ?? undefined,
    errorCode,
  };
}

export function formatMSTeamsSendErrorHint(
  classification: MSTeamsSendErrorClassification,
): string | undefined {
  if (classification.kind === "auth") {
    return "check msteams appId/appPassword/tenantId (or env vars MSTEAMS_APP_ID/MSTEAMS_APP_PASSWORD/MSTEAMS_TENANT_ID)";
  }
  if (classification.errorCode === "ContentStreamNotAllowed") {
    return "Teams expired the content stream; stop streaming earlier and fall back to normal message delivery";
  }
  if (classification.kind === "replay-safe") {
    return "Teams throttled the bot; backing off may help";
  }
  if (classification.kind === "ambiguous") {
    if (classification.source === "transport") {
      return "transport-level failure sending to Teams Bot Connector (smba.trafficmanager.net); the outcome is unknown, so check egress and conversation history before taking further action";
    }
    return "Teams/Bot Framework delivery outcome is unknown; inspect the conversation history before taking further action";
  }
  return undefined;
}

export function formatMSTeamsDeliveryFailureGuidance(
  classification: MSTeamsSendErrorClassification,
): string | undefined {
  if (classification.kind === "replay-safe") {
    return "The request was rate-limited before delivery; retrying later may succeed.";
  }
  if (classification.kind === "ambiguous") {
    return "Delivery may already have succeeded; do not send the same content again without checking the conversation.";
  }
  return undefined;
}
