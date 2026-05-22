import { f as resolveClientIp, r as isLoopbackAddress } from "./net-DCUMtgJy.js";
//#region src/gateway/auth-rate-limit.ts
/**
* In-memory sliding-window rate limiter for gateway authentication attempts.
*
* Tracks failed auth attempts by {scope, clientIp}. A scope lets callers keep
* independent counters for different credential classes (for example, shared
* gateway token/password vs device-token auth) while still sharing one
* limiter instance.
*
* Design decisions:
* - Pure in-memory Map – no external dependencies; suitable for a single
*   gateway process.  The Map is periodically pruned to avoid unbounded
*   growth.
* - Loopback addresses (127.0.0.1 / ::1) are exempt by default so that local
*   CLI sessions are never locked out.
* - The module is side-effect-free: callers create an instance via
*   {@link createAuthRateLimiter} and pass it where needed.
*/
const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_LOCKOUT_MS = 3e5;
const PRUNE_INTERVAL_MS = 6e4;
/**
* Canonicalize client IPs used for auth throttling so all call sites
* share one representation (including IPv4-mapped IPv6 forms).
*/
function normalizeRateLimitClientIp(ip) {
	if (typeof ip === "string" && ip.startsWith(BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX)) return ip;
	return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
}
function createAuthRateLimiter(config) {
	const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
	const lockoutMs = config?.lockoutMs ?? DEFAULT_LOCKOUT_MS;
	const exemptLoopback = config?.exemptLoopback ?? true;
	const pruneIntervalMs = config?.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
	const entries = /* @__PURE__ */ new Map();
	const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
	if (pruneTimer?.unref) pruneTimer.unref();
	function normalizeScope(scope) {
		return (scope ?? "default").trim() || "default";
	}
	function normalizeIp(ip) {
		return normalizeRateLimitClientIp(ip);
	}
	function resolveKey(rawIp, rawScope) {
		const ip = normalizeIp(rawIp);
		return {
			key: `${normalizeScope(rawScope)}:${ip}`,
			ip
		};
	}
	function isExempt(ip) {
		return exemptLoopback && isLoopbackAddress(ip);
	}
	function slideWindow(entry, now) {
		const cutoff = now - windowMs;
		entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
	}
	function check(rawIp, rawScope) {
		const { key, ip } = resolveKey(rawIp, rawScope);
		if (isExempt(ip)) return {
			allowed: true,
			remaining: maxAttempts,
			retryAfterMs: 0
		};
		const now = Date.now();
		const entry = entries.get(key);
		if (!entry) return {
			allowed: true,
			remaining: maxAttempts,
			retryAfterMs: 0
		};
		if (entry.lockedUntil && now < entry.lockedUntil) return {
			allowed: false,
			remaining: 0,
			retryAfterMs: entry.lockedUntil - now
		};
		if (entry.lockedUntil && now >= entry.lockedUntil) {
			entry.lockedUntil = void 0;
			entry.attempts = [];
		}
		slideWindow(entry, now);
		const remaining = Math.max(0, maxAttempts - entry.attempts.length);
		return {
			allowed: remaining > 0,
			remaining,
			retryAfterMs: 0
		};
	}
	function recordFailure(rawIp, rawScope) {
		const { key, ip } = resolveKey(rawIp, rawScope);
		if (isExempt(ip)) return;
		const now = Date.now();
		let entry = entries.get(key);
		if (!entry) {
			entry = { attempts: [] };
			entries.set(key, entry);
		}
		if (entry.lockedUntil && now < entry.lockedUntil) return;
		slideWindow(entry, now);
		entry.attempts.push(now);
		if (entry.attempts.length >= maxAttempts) entry.lockedUntil = now + lockoutMs;
	}
	function reset(rawIp, rawScope) {
		const { key } = resolveKey(rawIp, rawScope);
		entries.delete(key);
	}
	function prune() {
		const now = Date.now();
		for (const [key, entry] of entries) {
			if (entry.lockedUntil && now < entry.lockedUntil) continue;
			slideWindow(entry, now);
			if (entry.attempts.length === 0) entries.delete(key);
		}
	}
	function size() {
		return entries.size;
	}
	function dispose() {
		if (pruneTimer) clearInterval(pruneTimer);
		entries.clear();
	}
	return {
		check,
		recordFailure,
		reset,
		size,
		prune,
		dispose
	};
}
//#endregion
export { createAuthRateLimiter as a, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET as i, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN as n, normalizeRateLimitClientIp as o, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH as r, AUTH_RATE_LIMIT_SCOPE_DEFAULT as t };
