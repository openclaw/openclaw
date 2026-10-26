import { inspect } from "node:util";
import { formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  parseFiniteNumber as readFiniteNumber,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { DiscordError, RateLimitError } from "../internal/rest.js";

const DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT = 3;

type DiscordDeployErrorLike = {
  status?: unknown;
  discordCode?: unknown;
  rawBody?: unknown;
  deployRequestBody?: unknown;
  deployRestMethod?: unknown;
  deployRestPath?: unknown;
  deployRequestMs?: unknown;
  deployTimeoutMs?: unknown;
};

function stringifyDiscordDeployField(value: unknown, depth = 2): string {
  try {
    return JSON.stringify(value);
  } catch {
    return inspect(value, { depth, breakLength: 120 });
  }
}

function readDiscordDeployRejectedFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").slice(0, 6);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.keys(value).slice(0, 6);
}

function resolveDiscordRejectedDeployEntriesSource(
  rawBody: unknown,
): Record<string, unknown> | null {
  if (!rawBody || typeof rawBody !== "object") {
    return null;
  }
  const payload = rawBody as { errors?: unknown };
  const errors = payload.errors && typeof payload.errors === "object" ? payload.errors : undefined;
  return (errors ?? rawBody) as Record<string, unknown>;
}

function isAbortLikeError(err: unknown): err is DiscordDeployErrorLike {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err && typeof err.name === "string" ? err.name : undefined;
  const message = formatErrorMessage(err);
  return name === "AbortError" || /\boperation was aborted\b/i.test(message);
}

export function formatDiscordDeployErrorMessage(err: unknown): string {
  if (!isAbortLikeError(err)) {
    return formatErrorMessage(err);
  }
  const deployErr = err;
  const requestMs = readFiniteNumber(deployErr.deployRequestMs);
  const timeoutMs = readFiniteNumber(deployErr.deployTimeoutMs);
  const method = readNonBlankString(deployErr.deployRestMethod)?.toUpperCase();
  const path = readNonBlankString(deployErr.deployRestPath);
  const operation = method && path ? `${method} ${path}` : (method ?? path ?? "request");
  const hasRestContext =
    requestMs !== undefined ||
    timeoutMs !== undefined ||
    deployErr.deployRestMethod !== undefined ||
    deployErr.deployRestPath !== undefined;
  if (!hasRestContext) {
    return "Discord REST request was aborted";
  }
  const timing: string[] = [];
  for (const [label, value] of [
    ["timeout", timeoutMs],
    ["observed", requestMs],
  ] as const) {
    if (value !== undefined) {
      timing.push(`${label}=${formatDurationSeconds(value, { decimals: value >= 1000 ? 1 : 0 })}`);
    }
  }
  const timingText = timing.length > 0 ? ` (${timing.join(", ")})` : "";
  if (timeoutMs !== undefined && requestMs !== undefined && requestMs >= timeoutMs) {
    return `Discord REST ${operation} timed out${timingText}`;
  }
  return `Discord REST ${operation} was aborted${timingText}`;
}

function formatDiscordDeployRateLimitDetails(err: unknown): string {
  if (!(err instanceof RateLimitError)) {
    return "";
  }
  const details = [
    `status=${err.status}`,
    `retryAfter=${formatDurationSeconds(err.retryAfter * 1000, { decimals: 1 })}`,
    `scope=${err.scope ?? "route"}`,
    err.discordCode !== undefined ? `code=${err.discordCode}` : undefined,
  ].filter(Boolean);
  return ` (${details.join(", ")})`;
}

export function formatDiscordDeployRateLimitWarning(
  err: unknown,
  accountId: string,
): string | undefined {
  if (!(err instanceof RateLimitError)) {
    return undefined;
  }
  const parts = [
    `[${accountId}] slash command deploy rate limited`,
    `retry after ${formatDurationSeconds(err.retryAfter * 1000, { decimals: 1 })}`,
    `scope=${err.scope ?? "route"}`,
    err.discordCode !== undefined ? `code=${err.discordCode}` : undefined,
  ].filter(Boolean);
  return `${parts.join("; ")}. Existing slash commands stay active. Message send/receive is unaffected.`;
}

function formatDiscordRejectedDeployEntries(params: {
  rawBody: unknown;
  requestBody: unknown;
}): string[] {
  const requestBody = Array.isArray(params.requestBody) ? params.requestBody : null;
  const rejectedEntriesSource = resolveDiscordRejectedDeployEntriesSource(params.rawBody);
  if (!rejectedEntriesSource || !requestBody || requestBody.length === 0) {
    return [];
  }
  const rawEntries = Object.entries(rejectedEntriesSource).filter(([key]) => /^\d+$/.test(key));
  return rawEntries.slice(0, DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT).flatMap(([key, value]) => {
    const index = Number.parseInt(key, 10);
    if (!Number.isFinite(index) || index < 0 || index >= requestBody.length) {
      return [];
    }
    const command = requestBody[index];
    if (!command || typeof command !== "object") {
      return [`#${index} fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
    }
    const payload = command as {
      name?: unknown;
      description?: unknown;
      options?: unknown;
    };
    const parts = [
      `#${index}`,
      `fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`,
    ];
    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      parts.push(`name=${payload.name}`);
    }
    if (payload.description !== undefined) {
      parts.push(`description=${stringifyDiscordDeployField(payload.description)}`);
    }
    if (Array.isArray(payload.options) && payload.options.length > 0) {
      parts.push(`options=${payload.options.length}`);
    }
    return [parts.join(" ")];
  });
}

// Discord error envelopes are usually plain {message, code}; both already
// appear via the error message and the code= detail, so repeating the JSON
// body would only double the line length without adding information.
function isRedundantDiscordDeployBody(rawBody: unknown): boolean {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return false;
  }
  const keys = Object.keys(rawBody);
  return keys.length > 0 && keys.every((key) => key === "message" || key === "code");
}

export function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const rateLimitDetails = formatDiscordDeployRateLimitDetails(err);
  if (rateLimitDetails) {
    return rateLimitDetails;
  }
  const {
    status,
    discordCode,
    rawBody,
    deployRequestBody: requestBody,
  } = err as DiscordDeployErrorLike;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined && !isRedundantDiscordDeployBody(rawBody)) {
    const bodyText = stringifyDiscordDeployField(rawBody, 3);
    if (bodyText) {
      const maxLen = 800;
      const trimmed =
        bodyText.length > maxLen ? `${truncateUtf16Safe(bodyText, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  const rejectedEntries = formatDiscordRejectedDeployEntries({ rawBody, requestBody });
  if (rejectedEntries.length > 0) {
    details.push(`rejected=${rejectedEntries.join("; ")}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function isDiscordDeployDailyCreateLimit(err: unknown): boolean {
  return (
    err instanceof DiscordError &&
    err.discordCode === 30034 &&
    /daily application command creates/i.test(err.message)
  );
}
