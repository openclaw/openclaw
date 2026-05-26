import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as readTailscaleWhoisIdentity } from "./tailscale-BvtowUdS.js";
import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { _ as resolveRequestClientIp, c as isTrustedProxyAddress, f as resolveClientIp, g as resolveLocalInterfaceAddressMatch, h as resolveHostName, i as isLoopbackHost, r as isLoopbackAddress, u as normalizeHostHeader } from "./net-DCUMtgJy.js";
import { p as isPrivateOrLoopbackIpAddress } from "./ip-WAe3-2zT.js";
import { o as normalizeRateLimitClientIp } from "./auth-rate-limit-DA3xJNFz.js";
import "./auth-resolve-BEn3Se6k.js";
import net from "node:net";
//#region src/gateway/origin-check.ts
function parseOrigin(originRaw) {
	const trimmed = (originRaw ?? "").trim();
	if (!trimmed || trimmed === "null") return null;
	try {
		const url = new URL(trimmed);
		return {
			origin: normalizeLowercaseStringOrEmpty(url.origin),
			host: normalizeLowercaseStringOrEmpty(url.host),
			hostname: normalizeLowercaseStringOrEmpty(url.hostname)
		};
	} catch {
		return null;
	}
}
function checkBrowserOrigin(params) {
	const parsedOrigin = parseOrigin(params.origin);
	if (!parsedOrigin) return {
		ok: false,
		reason: "origin missing or invalid"
	};
	const allowlist = new Set((params.allowedOrigins ?? []).map((value) => normalizeOptionalLowercaseString(value)).filter(Boolean));
	if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) return {
		ok: true,
		matchedBy: "allowlist"
	};
	const requestHost = normalizeHostHeader(params.requestHost);
	if (params.allowHostHeaderOriginFallback === true && requestHost && parsedOrigin.host === requestHost) return {
		ok: true,
		matchedBy: "host-header-fallback"
	};
	if (requestHost && parsedOrigin.host === requestHost && isTrustedSameOriginHost(requestHost, params.isLocalClient)) return {
		ok: true,
		matchedBy: "private-same-origin"
	};
	if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) return {
		ok: true,
		matchedBy: "local-loopback"
	};
	return {
		ok: false,
		reason: "origin not allowed"
	};
}
function isTrustedSameOriginHost(hostHeader, isLocalClient) {
	const hostname = resolveHostName(hostHeader);
	if (!hostname) return false;
	if (isLoopbackHost(hostname)) return isLocalClient !== false;
	if (net.isIP(hostname) !== 0) return isPrivateOrLoopbackIpAddress(hostname);
	return hostname.endsWith(".local") || hostname.endsWith(".ts.net");
}
//#endregion
//#region src/gateway/rate-limit-attempt-serialization.ts
const pendingAttempts = /* @__PURE__ */ new Map();
function normalizeScope(scope) {
	return (scope ?? "default").trim() || "default";
}
function buildSerializationKey(ip, scope) {
	return `${normalizeScope(scope)}:${normalizeRateLimitClientIp(ip)}`;
}
async function withSerializedRateLimitAttempt(params) {
	const key = buildSerializationKey(params.ip, params.scope);
	const previous = pendingAttempts.get(key) ?? Promise.resolve();
	let releaseCurrent;
	const current = new Promise((resolve) => {
		releaseCurrent = resolve;
	});
	const tail = previous.catch(() => {}).then(() => current);
	pendingAttempts.set(key, tail);
	await previous.catch(() => {});
	try {
		return await params.run();
	} finally {
		releaseCurrent();
		if (pendingAttempts.get(key) === tail) pendingAttempts.delete(key);
	}
}
//#endregion
//#region src/gateway/auth.ts
const LEGACY_OPENCLAW_ENV_NOTE = " Legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored; use OPENCLAW_* names.";
function hasExplicitSharedSecretAuth(connectAuth) {
	return Boolean(normalizeOptionalString(connectAuth?.token) || normalizeOptionalString(connectAuth?.password));
}
function normalizeLogin(login) {
	return normalizeLowercaseStringOrEmpty(login);
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
function hasForwardedRequestHeaders(req) {
	if (!req) return false;
	const headers = req.headers ?? {};
	return Boolean(headers.forwarded || headers["x-real-ip"] || Object.keys(headers).some((header) => normalizeLowercaseStringOrEmpty(header).startsWith("x-forwarded-")));
}
function isLocalDirectRequest(req, _trustedProxies, _allowRealIpFallback = false) {
	if (!req) return false;
	if (!hasForwardedRequestHeaders(req)) return isLoopbackAddress(req.socket?.remoteAddress);
	return false;
}
function getTailscaleUser(req) {
	if (!req) return null;
	const login = normalizeOptionalString(req.headers["tailscale-user-login"]);
	if (!login) return null;
	const nameRaw = req.headers["tailscale-user-name"];
	const profilePic = req.headers["tailscale-user-profile-pic"];
	return {
		login,
		name: normalizeOptionalString(nameRaw) ?? login,
		profilePic: normalizeOptionalString(profilePic)
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
function assertGatewayAuthConfigured(auth, rawAuthConfig) {
	if (auth.mode === "token" && !auth.token) {
		if (auth.allowTailscale) return;
		throw new Error(`gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN).${LEGACY_OPENCLAW_ENV_NOTE}`);
	}
	if (auth.mode === "password" && !auth.password) {
		if (rawAuthConfig?.password != null && typeof rawAuthConfig.password !== "string") throw new Error("gateway auth mode is password, but gateway.auth.password contains a provider reference object instead of a resolved string — bootstrap secrets (gateway.auth.password) must be plaintext strings or set via the OPENCLAW_GATEWAY_PASSWORD environment variable because the secrets provider system has not initialised yet at gateway startup");
		throw new Error(`gateway auth mode is password, but no password was configured.${LEGACY_OPENCLAW_ENV_NOTE}`);
	}
	if (auth.mode === "trusted-proxy") {
		if (!auth.trustedProxy) throw new Error("gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)");
		if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") throw new Error("gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)");
		if (auth.token) throw new Error("gateway auth mode is trusted-proxy, but a shared token is also configured; remove gateway.auth.token / OPENCLAW_GATEWAY_TOKEN because trusted-proxy and token auth are mutually exclusive");
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
	const remoteIsLoopback = isLoopbackAddress(remoteAddr);
	if (remoteIsLoopback && trustedProxyConfig.allowLoopback !== true) return { reason: "trusted_proxy_loopback_source" };
	if (!remoteIsLoopback) {
		const localInterfaceMatch = resolveLocalInterfaceAddressMatch(remoteAddr);
		if (localInterfaceMatch === void 0) return { reason: "trusted_proxy_local_interface_check_failed" };
		if (localInterfaceMatch) return { reason: "trusted_proxy_local_interface_source" };
	}
	const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
	for (const header of requiredHeaders) {
		const value = headerValue(req.headers[normalizeLowercaseStringOrEmpty(header)]);
		if (!value || value.trim() === "") return { reason: `trusted_proxy_missing_header_${header}` };
	}
	const userHeaderValue = headerValue(req.headers[normalizeLowercaseStringOrEmpty(trustedProxyConfig.userHeader)]);
	if (!userHeaderValue || userHeaderValue.trim() === "") return { reason: "trusted_proxy_user_missing" };
	const user = userHeaderValue.trim();
	const allowUsers = trustedProxyConfig.allowUsers ?? [];
	if (allowUsers.length > 0 && !allowUsers.includes(user)) return { reason: "trusted_proxy_user_not_allowed" };
	return { user };
}
function shouldAllowTailscaleHeaderAuth(authSurface) {
	return authSurface === "ws-control-ui";
}
function authorizeTrustedProxyBrowserOrigin(params) {
	if (params.authSurface !== "http") return null;
	const origin = params.browserOriginPolicy?.origin?.trim();
	if (!origin) return null;
	if (checkBrowserOrigin({
		requestHost: params.browserOriginPolicy?.requestHost,
		origin,
		allowedOrigins: params.browserOriginPolicy?.allowedOrigins,
		allowHostHeaderOriginFallback: params.browserOriginPolicy?.allowHostHeaderOriginFallback,
		isLocalClient: false
	}).ok) return null;
	return {
		ok: false,
		reason: "trusted_proxy_origin_not_allowed"
	};
}
function authorizeTokenAuth(params) {
	if (!params.authToken) return {
		ok: false,
		reason: "token_missing_config"
	};
	if (!params.connectToken) return {
		ok: false,
		reason: "token_missing"
	};
	if (!safeEqualSecret(params.connectToken, params.authToken)) {
		params.limiter?.recordFailure(params.ip, params.rateLimitScope);
		return {
			ok: false,
			reason: "token_mismatch"
		};
	}
	params.limiter?.reset(params.ip, params.rateLimitScope);
	return {
		ok: true,
		method: "token"
	};
}
function authorizePasswordAuth(params) {
	if (!params.authPassword) return {
		ok: false,
		reason: "password_missing_config"
	};
	if (!params.connectPassword) return {
		ok: false,
		reason: "password_missing"
	};
	if (!safeEqualSecret(params.connectPassword, params.authPassword)) {
		params.limiter?.recordFailure(params.ip, params.rateLimitScope);
		return {
			ok: false,
			reason: "password_mismatch"
		};
	}
	params.limiter?.reset(params.ip, params.rateLimitScope);
	return {
		ok: true,
		method: "password"
	};
}
async function authorizeGatewayConnect(params) {
	const { auth, req, trustedProxies } = params;
	const authSurface = params.authSurface ?? "http";
	const limiter = params.rateLimiter;
	const ip = params.clientIp ?? resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ?? req?.socket?.remoteAddress;
	const rateLimitScope = params.rateLimitScope ?? "shared-secret";
	const localDirect = isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true);
	if (limiter && shouldAllowTailscaleHeaderAuth(authSurface) && auth.allowTailscale && !localDirect) return await withSerializedRateLimitAttempt({
		ip,
		scope: rateLimitScope,
		run: async () => await authorizeGatewayConnectCore(params)
	});
	return await authorizeGatewayConnectCore(params);
}
async function authorizeGatewayConnectCore(params) {
	const { auth, connectAuth, req, trustedProxies } = params;
	const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
	const authSurface = params.authSurface ?? "http";
	const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
	const limiter = params.rateLimiter;
	const ip = params.clientIp ?? resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ?? req?.socket?.remoteAddress;
	const rateLimitScope = params.rateLimitScope ?? "shared-secret";
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
		if ("user" in result) {
			const originResult = authorizeTrustedProxyBrowserOrigin({
				authSurface,
				browserOriginPolicy: params.browserOriginPolicy
			});
			if (originResult) return originResult;
			return {
				ok: true,
				method: "trusted-proxy",
				user: result.user
			};
		}
		if (localDirect && auth.password && connectAuth?.password) {
			if (limiter) {
				const rlCheck = limiter.check(ip, rateLimitScope);
				if (!rlCheck.allowed) return {
					ok: false,
					reason: "rate_limited",
					rateLimited: true,
					retryAfterMs: rlCheck.retryAfterMs
				};
			}
			return authorizePasswordAuth({
				authPassword: auth.password,
				connectPassword: connectAuth.password,
				limiter,
				ip,
				rateLimitScope
			});
		}
		return {
			ok: false,
			reason: result.reason
		};
	}
	if (auth.mode === "none") return {
		ok: true,
		method: "none"
	};
	if (limiter) {
		const rlCheck = limiter.check(ip, rateLimitScope);
		if (!rlCheck.allowed) return {
			ok: false,
			reason: "rate_limited",
			rateLimited: true,
			retryAfterMs: rlCheck.retryAfterMs
		};
	}
	if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect && !hasExplicitSharedSecretAuth(connectAuth)) {
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
	if (auth.mode === "token") return authorizeTokenAuth({
		authToken: auth.token,
		connectToken: connectAuth?.token,
		limiter,
		ip,
		rateLimitScope
	});
	if (auth.mode === "password") return authorizePasswordAuth({
		authPassword: auth.password,
		connectPassword: connectAuth?.password,
		limiter,
		ip,
		rateLimitScope
	});
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
export { hasForwardedRequestHeaders as a, authorizeWsControlUiGatewayConnect as i, authorizeGatewayConnect as n, isLocalDirectRequest as o, authorizeHttpGatewayConnect as r, checkBrowserOrigin as s, assertGatewayAuthConfigured as t };
