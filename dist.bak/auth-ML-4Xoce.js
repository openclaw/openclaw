import { t as safeEqualSecret } from "./secret-equal-CzmdvIUc.js";
import { a as isTrustedProxyAddress, l as resolveClientIp, n as isLoopbackAddress, t as isLocalishHost } from "./net-DBrsyv8q.js";
import { n as resolveGatewayCredentialsFromValues } from "./credentials-DQGpxZLN.js";
import { c as readTailscaleWhoisIdentity } from "./tailscale-Cz0j5H8x.js";

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
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_LOCKOUT_MS = 3e5;
const PRUNE_INTERVAL_MS = 6e4;
/**
* Canonicalize client IPs used for auth throttling so all call sites
* share one representation (including IPv4-mapped IPv6 forms).
*/
function normalizeRateLimitClientIp(ip) {
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
		return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
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
//#region src/gateway/auth.ts
function normalizeLogin(login) {
	return login.trim().toLowerCase();
}
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"];
function resolveTailscaleClientIp(req) {
	if (!req) return;
	return resolveClientIp({
		remoteAddr: req.socket?.remoteAddress ?? "",
		forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
		trustedProxies: [...TAILSCALE_TRUSTED_PROXIES]
	});
}
function resolveRequestClientIp(req, trustedProxies, allowRealIpFallback = false) {
	if (!req) return;
	return resolveClientIp({
		remoteAddr: req.socket?.remoteAddress ?? "",
		forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
		realIp: headerValue(req.headers?.["x-real-ip"]),
		trustedProxies,
		allowRealIpFallback
	});
}
function isLocalDirectRequest(req, trustedProxies, allowRealIpFallback = false) {
	if (!req) return false;
	if (!isLoopbackAddress(resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ?? "")) return false;
	const hasForwarded = Boolean(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || req.headers?.["x-forwarded-host"]);
	const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
	return isLocalishHost(req.headers?.host) && (!hasForwarded || remoteIsTrustedProxy);
}
function getTailscaleUser(req) {
	if (!req) return null;
	const login = req.headers["tailscale-user-login"];
	if (typeof login !== "string" || !login.trim()) return null;
	const nameRaw = req.headers["tailscale-user-name"];
	const profilePic = req.headers["tailscale-user-profile-pic"];
	const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
	return {
		login: login.trim(),
		name,
		profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : void 0
	};
}
function hasTailscaleProxyHeaders(req) {
	if (!req) return false;
	return Boolean(req.headers["x-forwarded-for"] && req.headers["x-forwarded-proto"] && req.headers["x-forwarded-host"]);
}
function isTailscaleProxyRequest(req) {
	if (!req) return false;
	return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}
async function resolveVerifiedTailscaleUser(params) {
	const { req, tailscaleWhois } = params;
	const tailscaleUser = getTailscaleUser(req);
	if (!tailscaleUser) return {
		ok: false,
		reason: "tailscale_user_missing"
	};
	if (!isTailscaleProxyRequest(req)) return {
		ok: false,
		reason: "tailscale_proxy_missing"
	};
	const clientIp = resolveTailscaleClientIp(req);
	if (!clientIp) return {
		ok: false,
		reason: "tailscale_whois_failed"
	};
	const whois = await tailscaleWhois(clientIp);
	if (!whois?.login) return {
		ok: false,
		reason: "tailscale_whois_failed"
	};
	if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) return {
		ok: false,
		reason: "tailscale_user_mismatch"
	};
	return {
		ok: true,
		user: {
			login: whois.login,
			name: whois.name ?? tailscaleUser.name,
			profilePic: tailscaleUser.profilePic
		}
	};
}
function resolveGatewayAuth(params) {
	const baseAuthConfig = params.authConfig ?? {};
	const authOverride = params.authOverride ?? void 0;
	const authConfig = { ...baseAuthConfig };
	if (authOverride) {
		if (authOverride.mode !== void 0) authConfig.mode = authOverride.mode;
		if (authOverride.token !== void 0) authConfig.token = authOverride.token;
		if (authOverride.password !== void 0) authConfig.password = authOverride.password;
		if (authOverride.allowTailscale !== void 0) authConfig.allowTailscale = authOverride.allowTailscale;
		if (authOverride.rateLimit !== void 0) authConfig.rateLimit = authOverride.rateLimit;
		if (authOverride.trustedProxy !== void 0) authConfig.trustedProxy = authOverride.trustedProxy;
	}
	const env = params.env ?? process.env;
	const resolvedCredentials = resolveGatewayCredentialsFromValues({
		configToken: authConfig.token,
		configPassword: authConfig.password,
		env,
		includeLegacyEnv: false,
		tokenPrecedence: "config-first",
		passwordPrecedence: "config-first"
	});
	const token = resolvedCredentials.token;
	const password = resolvedCredentials.password;
	const trustedProxy = authConfig.trustedProxy;
	let mode;
	let modeSource;
	if (authOverride?.mode !== void 0) {
		mode = authOverride.mode;
		modeSource = "override";
	} else if (authConfig.mode) {
		mode = authConfig.mode;
		modeSource = "config";
	} else if (password) {
		mode = "password";
		modeSource = "password";
	} else if (token) {
		mode = "token";
		modeSource = "token";
	} else {
		mode = "token";
		modeSource = "default";
	}
	const allowTailscale = authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
	return {
		mode,
		modeSource,
		token,
		password,
		allowTailscale,
		trustedProxy
	};
}
function assertGatewayAuthConfigured(auth) {
	if (auth.mode === "token" && !auth.token) {
		if (auth.allowTailscale) return;
		throw new Error("gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
	}
	if (auth.mode === "password" && !auth.password) throw new Error("gateway auth mode is password, but no password was configured");
	if (auth.mode === "trusted-proxy") {
		if (!auth.trustedProxy) throw new Error("gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)");
		if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") throw new Error("gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)");
	}
}
/**
* Check if the request came from a trusted proxy and extract user identity.
* Returns the user identity if valid, or null with a reason if not.
*/
function authorizeTrustedProxy(params) {
	const { req, trustedProxies, trustedProxyConfig } = params;
	if (!req) return { reason: "trusted_proxy_no_request" };
	const remoteAddr = req.socket?.remoteAddress;
	if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) return { reason: "trusted_proxy_untrusted_source" };
	const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
	for (const header of requiredHeaders) {
		const value = headerValue(req.headers[header.toLowerCase()]);
		if (!value || value.trim() === "") return { reason: `trusted_proxy_missing_header_${header}` };
	}
	const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
	if (!userHeaderValue || userHeaderValue.trim() === "") return { reason: "trusted_proxy_user_missing" };
	const user = userHeaderValue.trim();
	const allowUsers = trustedProxyConfig.allowUsers ?? [];
	if (allowUsers.length > 0 && !allowUsers.includes(user)) return { reason: "trusted_proxy_user_not_allowed" };
	return { user };
}
function shouldAllowTailscaleHeaderAuth(authSurface) {
	return authSurface === "ws-control-ui";
}
async function authorizeGatewayConnect(params) {
	const { auth, connectAuth, req, trustedProxies } = params;
	const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
	const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(params.authSurface ?? "http");
	const localDirect = isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true);
	if (auth.mode === "trusted-proxy") {
		if (!auth.trustedProxy) return {
			ok: false,
			reason: "trusted_proxy_config_missing"
		};
		if (!trustedProxies || trustedProxies.length === 0) return {
			ok: false,
			reason: "trusted_proxy_no_proxies_configured"
		};
		const result = authorizeTrustedProxy({
			req,
			trustedProxies,
			trustedProxyConfig: auth.trustedProxy
		});
		if ("user" in result) return {
			ok: true,
			method: "trusted-proxy",
			user: result.user
		};
		return {
			ok: false,
			reason: result.reason
		};
	}
	if (auth.mode === "none") return {
		ok: true,
		method: "none"
	};
	const limiter = params.rateLimiter;
	const ip = params.clientIp ?? resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ?? req?.socket?.remoteAddress;
	const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
	if (limiter) {
		const rlCheck = limiter.check(ip, rateLimitScope);
		if (!rlCheck.allowed) return {
			ok: false,
			reason: "rate_limited",
			rateLimited: true,
			retryAfterMs: rlCheck.retryAfterMs
		};
	}
	if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
		const tailscaleCheck = await resolveVerifiedTailscaleUser({
			req,
			tailscaleWhois
		});
		if (tailscaleCheck.ok) {
			limiter?.reset(ip, rateLimitScope);
			return {
				ok: true,
				method: "tailscale",
				user: tailscaleCheck.user.login
			};
		}
	}
	if (auth.mode === "token") {
		if (!auth.token) return {
			ok: false,
			reason: "token_missing_config"
		};
		if (!connectAuth?.token) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "token_missing"
			};
		}
		if (!safeEqualSecret(connectAuth.token, auth.token)) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "token_mismatch"
			};
		}
		limiter?.reset(ip, rateLimitScope);
		return {
			ok: true,
			method: "token"
		};
	}
	if (auth.mode === "password") {
		const password = connectAuth?.password;
		if (!auth.password) return {
			ok: false,
			reason: "password_missing_config"
		};
		if (!password) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "password_missing"
			};
		}
		if (!safeEqualSecret(password, auth.password)) {
			limiter?.recordFailure(ip, rateLimitScope);
			return {
				ok: false,
				reason: "password_mismatch"
			};
		}
		limiter?.reset(ip, rateLimitScope);
		return {
			ok: true,
			method: "password"
		};
	}
	limiter?.recordFailure(ip, rateLimitScope);
	return {
		ok: false,
		reason: "unauthorized"
	};
}
async function authorizeHttpGatewayConnect(params) {
	return authorizeGatewayConnect({
		...params,
		authSurface: "http"
	});
}
async function authorizeWsControlUiGatewayConnect(params) {
	return authorizeGatewayConnect({
		...params,
		authSurface: "ws-control-ui"
	});
}

//#endregion
export { resolveGatewayAuth as a, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET as c, isLocalDirectRequest as i, createAuthRateLimiter as l, authorizeHttpGatewayConnect as n, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN as o, authorizeWsControlUiGatewayConnect as r, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH as s, assertGatewayAuthConfigured as t, normalizeRateLimitClientIp as u };