import { dt as sleep } from "./entry.js";

//#region src/infra/retry.ts
const DEFAULT_RETRY_CONFIG = {
	attempts: 3,
	minDelayMs: 300,
	maxDelayMs: 3e4,
	jitter: 0
};
const asFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
const clampNumber = (value, fallback, min, max) => {
	const next = asFiniteNumber(value);
	if (next === void 0) return fallback;
	const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
	const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
	return Math.min(Math.max(next, floor), ceiling);
};
function resolveRetryConfig(defaults = DEFAULT_RETRY_CONFIG, overrides) {
	const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
	const minDelayMs = Math.max(0, Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)));
	return {
		attempts,
		minDelayMs,
		maxDelayMs: Math.max(minDelayMs, Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))),
		jitter: clampNumber(overrides?.jitter, defaults.jitter, 0, 1)
	};
}
function applyJitter(delayMs, jitter) {
	if (jitter <= 0) return delayMs;
	const offset = (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.round(delayMs * (1 + offset)));
}
async function retryAsync(fn, attemptsOrOptions = 3, initialDelayMs = 300) {
	if (typeof attemptsOrOptions === "number") {
		const attempts = Math.max(1, Math.round(attemptsOrOptions));
		let lastErr;
		for (let i = 0; i < attempts; i += 1) try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i === attempts - 1) break;
			await sleep(initialDelayMs * 2 ** i);
		}
		throw lastErr ?? /* @__PURE__ */ new Error("Retry failed");
	}
	const options = attemptsOrOptions;
	const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
	const maxAttempts = resolved.attempts;
	const minDelayMs = resolved.minDelayMs;
	const maxDelayMs = Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0 ? resolved.maxDelayMs : Number.POSITIVE_INFINITY;
	const jitter = resolved.jitter;
	const shouldRetry = options.shouldRetry ?? (() => true);
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) try {
		return await fn();
	} catch (err) {
		lastErr = err;
		if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break;
		const retryAfterMs = options.retryAfterMs?.(err);
		const baseDelay = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? Math.max(retryAfterMs, minDelayMs) : minDelayMs * 2 ** (attempt - 1);
		let delay = Math.min(baseDelay, maxDelayMs);
		delay = applyJitter(delay, jitter);
		delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);
		options.onRetry?.({
			attempt,
			maxAttempts,
			delayMs: delay,
			err,
			label: options.label
		});
		await sleep(delay);
	}
	throw lastErr ?? /* @__PURE__ */ new Error("Retry failed");
}

//#endregion
export { retryAsync as n, resolveRetryConfig as t };