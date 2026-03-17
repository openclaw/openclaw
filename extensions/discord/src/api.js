import { resolveFetch } from "../../../src/infra/fetch.js";
import { resolveRetryConfig, retryAsync } from "../../../src/infra/retry.js";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 3e4,
  jitter: 0.1
};
function parseDiscordApiErrorPayload(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const payload = JSON.parse(trimmed);
    if (payload && typeof payload === "object") {
      return payload;
    }
  } catch {
    return null;
  }
  return null;
}
function parseRetryAfterSeconds(text, response) {
  const payload = parseDiscordApiErrorPayload(text);
  const retryAfter = payload && typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after) ? payload.retry_after : void 0;
  if (retryAfter !== void 0) {
    return retryAfter;
  }
  const header = response.headers.get("Retry-After");
  if (!header) {
    return void 0;
  }
  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function formatRetryAfterSeconds(value) {
  if (value === void 0 || !Number.isFinite(value) || value < 0) {
    return void 0;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded}s`;
}
function formatDiscordApiErrorText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return void 0;
  }
  const payload = parseDiscordApiErrorPayload(trimmed);
  if (!payload) {
    const looksJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    return looksJson ? "unknown error" : trimmed;
  }
  const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "unknown error";
  const retryAfter = formatRetryAfterSeconds(
    typeof payload.retry_after === "number" ? payload.retry_after : void 0
  );
  return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}
class DiscordApiError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
async function fetchDiscord(path, token, fetcher = fetch, options) {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const retryConfig = resolveRetryConfig(DISCORD_API_RETRY_DEFAULTS, options?.retry);
  return retryAsync(
    async () => {
      const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
        headers: { Authorization: `Bot ${token}` }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const detail = formatDiscordApiErrorText(text);
        const suffix = detail ? `: ${detail}` : "";
        const retryAfter = res.status === 429 ? parseRetryAfterSeconds(text, res) : void 0;
        throw new DiscordApiError(
          `Discord API ${path} failed (${res.status})${suffix}`,
          res.status,
          retryAfter
        );
      }
      return await res.json();
    },
    {
      ...retryConfig,
      label: options?.label ?? path,
      shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
      retryAfterMs: (err) => err instanceof DiscordApiError && typeof err.retryAfter === "number" ? err.retryAfter * 1e3 : void 0
    }
  );
}
export {
  DiscordApiError,
  fetchDiscord
};
