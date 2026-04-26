import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0,
};
const DISCORD_HTML_RATE_LIMIT_RETRY_AFTER_SECONDS = 30;
const DISCORD_ERROR_DETAIL_MAX_CHARS = 240;

type DiscordApiErrorPayload = {
  message?: string;
  retry_after?: number;
  code?: number;
  global?: boolean;
};

function parseDiscordApiErrorPayload(text: string): DiscordApiErrorPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const payload = JSON.parse(trimmed);
    if (payload && typeof payload === "object") {
      return payload as DiscordApiErrorPayload;
    }
  } catch {
    return null;
  }
  return null;
}

function parseRetryAfterSeconds(text: string, response: Response): number | undefined {
  const payload = parseDiscordApiErrorPayload(text);
  const retryAfter =
    payload && typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after)
      ? payload.retry_after
      : undefined;
  if (retryAfter !== undefined) {
    return retryAfter;
  }
  const header = response.headers.get("Retry-After");
  if (!header) {
    return undefined;
  }
  const parsed = Number(header);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  const parsedDateMs = Date.parse(header);
  if (!Number.isFinite(parsedDateMs)) {
    return undefined;
  }
  return Math.max(0, (parsedDateMs - Date.now()) / 1000);
}

function formatRetryAfterSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded}s`;
}

function isHtmlResponseText(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 500).toLowerCase();
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    /<title[\s>]/.test(trimmed) ||
    /<body[\s>]/.test(trimmed)
  );
}

function summarizeHtmlResponseText(text: string): string {
  const withoutScripts = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const normalized = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "HTML response";
  }
  const suffix = normalized.length > DISCORD_ERROR_DETAIL_MAX_CHARS ? "..." : "";
  return `HTML response: ${normalized.slice(0, DISCORD_ERROR_DETAIL_MAX_CHARS)}${suffix}`;
}

function formatDiscordApiErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const payload = parseDiscordApiErrorPayload(trimmed);
  if (!payload) {
    if (isHtmlResponseText(trimmed)) {
      return summarizeHtmlResponseText(trimmed);
    }
    const looksJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    return looksJson ? "unknown error" : trimmed;
  }
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "unknown error";
  const retryAfter = formatRetryAfterSeconds(
    typeof payload.retry_after === "number" ? payload.retry_after : undefined,
  );
  return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}

export class DiscordApiError extends Error {
  status: number;
  retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type DiscordFetchOptions = {
  retry?: RetryConfig;
  label?: string;
};

export async function fetchDiscord<T>(
  path: string,
  token: string,
  fetcher: typeof fetch = fetch,
  options?: DiscordFetchOptions,
): Promise<T> {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }

  const retryConfig = resolveRetryConfig(DISCORD_API_RETRY_DEFAULTS, options?.retry);
  return retryAsync(
    async () => {
      const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const detail = formatDiscordApiErrorText(text);
        const suffix = detail ? `: ${detail}` : "";
        const parsedRetryAfter = res.status === 429 ? parseRetryAfterSeconds(text, res) : undefined;
        const retryAfter =
          parsedRetryAfter === undefined && res.status === 429 && isHtmlResponseText(text)
            ? DISCORD_HTML_RATE_LIMIT_RETRY_AFTER_SECONDS
            : parsedRetryAfter;
        throw new DiscordApiError(
          `Discord API ${path} failed (${res.status})${suffix}`,
          res.status,
          retryAfter,
        );
      }
      return (await res.json()) as T;
    },
    {
      ...retryConfig,
      label: options?.label ?? path,
      shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
      retryAfterMs: (err) =>
        err instanceof DiscordApiError && typeof err.retryAfter === "number"
          ? err.retryAfter * 1000
          : undefined,
    },
  );
}
