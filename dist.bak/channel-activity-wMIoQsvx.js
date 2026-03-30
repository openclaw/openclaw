import { s as createSubsystemLogger } from "./entry.js";
import { n as formatErrorMessage } from "./errors-Cu3BYw29.js";
import { n as retryAsync, t as resolveRetryConfig } from "./retry-DRMxSLyf.js";
import { RateLimitError } from "@buape/carbon";

//#region src/infra/retry-policy.ts
const DISCORD_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 500,
	maxDelayMs: 3e4,
	jitter: .1
};
const TELEGRAM_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 400,
	maxDelayMs: 3e4,
	jitter: .1
};
const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;
const log = createSubsystemLogger("retry-policy");
function getTelegramRetryAfterMs(err) {
	if (!err || typeof err !== "object") return;
	const candidate = "parameters" in err && err.parameters && typeof err.parameters === "object" ? err.parameters.retry_after : "response" in err && err.response && typeof err.response === "object" && "parameters" in err.response ? err.response.parameters?.retry_after : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error ? err.error.parameters?.retry_after : void 0;
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1e3 : void 0;
}
function createDiscordRetryRunner(params) {
	const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
		...params.configRetry,
		...params.retry
	});
	return (fn, label) => retryAsync(fn, {
		...retryConfig,
		label,
		shouldRetry: (err) => err instanceof RateLimitError,
		retryAfterMs: (err) => err instanceof RateLimitError ? err.retryAfter * 1e3 : void 0,
		onRetry: params.verbose ? (info) => {
			const labelText = info.label ?? "request";
			const maxRetries = Math.max(1, info.maxAttempts - 1);
			log.warn(`discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`);
		} : void 0
	});
}
function createTelegramRetryRunner(params) {
	const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
		...params.configRetry,
		...params.retry
	});
	const shouldRetry = params.shouldRetry ? (err) => params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err)) : (err) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));
	return (fn, label) => retryAsync(fn, {
		...retryConfig,
		label,
		shouldRetry,
		retryAfterMs: getTelegramRetryAfterMs,
		onRetry: params.verbose ? (info) => {
			const maxRetries = Math.max(1, info.maxAttempts - 1);
			log.warn(`telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`);
		} : void 0
	});
}

//#endregion
//#region src/infra/channel-activity.ts
const activity = /* @__PURE__ */ new Map();
function keyFor(channel, accountId) {
	return `${channel}:${accountId || "default"}`;
}
function ensureEntry(channel, accountId) {
	const key = keyFor(channel, accountId);
	const existing = activity.get(key);
	if (existing) return existing;
	const created = {
		inboundAt: null,
		outboundAt: null
	};
	activity.set(key, created);
	return created;
}
function recordChannelActivity(params) {
	const at = typeof params.at === "number" ? params.at : Date.now();
	const accountId = params.accountId?.trim() || "default";
	const entry = ensureEntry(params.channel, accountId);
	if (params.direction === "inbound") entry.inboundAt = at;
	if (params.direction === "outbound") entry.outboundAt = at;
}
function getChannelActivity(params) {
	const accountId = params.accountId?.trim() || "default";
	return activity.get(keyFor(params.channel, accountId)) ?? {
		inboundAt: null,
		outboundAt: null
	};
}

//#endregion
export { createTelegramRetryRunner as i, recordChannelActivity as n, createDiscordRetryRunner as r, getChannelActivity as t };