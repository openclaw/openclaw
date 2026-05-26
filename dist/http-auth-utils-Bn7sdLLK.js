import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as authorizeHttpGatewayConnect } from "./auth-DZ1o6pTQ.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import { n as authorizeOperatorScopesForMethod, t as CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes-D4RcH8qD.js";
import { r as sendGatewayAuthFailure, s as sendMissingScopeForbidden } from "./http-common-D6Lgf8u5.js";
//#region src/gateway/http-auth-utils.ts
function getHeader(req, name) {
	const raw = req.headers[normalizeLowercaseStringOrEmpty(name)];
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) return raw[0];
}
function getBearerToken(req) {
	const raw = normalizeOptionalString(getHeader(req, "authorization")) ?? "";
	if (!normalizeLowercaseStringOrEmpty(raw).startsWith("bearer ")) return;
	return normalizeOptionalString(raw.slice(7));
}
function resolveHttpBrowserOriginPolicy(req, cfg = getRuntimeConfig()) {
	return {
		requestHost: getHeader(req, "host"),
		origin: getHeader(req, "origin"),
		allowedOrigins: cfg.gateway?.controlUi?.allowedOrigins,
		allowHostHeaderOriginFallback: cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true
	};
}
function usesSharedSecretHttpAuth(auth) {
	return auth?.mode === "token" || auth?.mode === "password";
}
function usesSharedSecretGatewayMethod(method) {
	return method === "token" || method === "password";
}
function shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest) {
	if (authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest) return authOrRequest.trustDeclaredOperatorScopes;
	return !isGatewayBearerHttpRequest(req, authOrRequest);
}
async function authorizeGatewayHttpRequestOrReply(params) {
	const result = await checkGatewayHttpRequestAuth(params);
	if (!result.ok) {
		sendGatewayAuthFailure(params.res, result.authResult);
		return null;
	}
	return result.requestAuth;
}
async function checkGatewayHttpRequestAuth(params) {
	const token = getBearerToken(params.req);
	const browserOriginPolicy = resolveHttpBrowserOriginPolicy(params.req, params.cfg);
	const authResult = await authorizeHttpGatewayConnect({
		auth: params.auth,
		connectAuth: token ? {
			token,
			password: token
		} : null,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimiter: params.rateLimiter,
		browserOriginPolicy
	});
	if (!authResult.ok) return {
		ok: false,
		authResult
	};
	return {
		ok: true,
		requestAuth: {
			authMethod: authResult.method,
			trustDeclaredOperatorScopes: !usesSharedSecretGatewayMethod(authResult.method)
		}
	};
}
async function authorizeScopedGatewayHttpRequestOrReply(params) {
	const cfg = getRuntimeConfig();
	const requestAuth = await authorizeGatewayHttpRequestOrReply({
		req: params.req,
		res: params.res,
		auth: params.auth,
		trustedProxies: params.trustedProxies ?? cfg.gateway?.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
		rateLimiter: params.rateLimiter
	});
	if (!requestAuth) return null;
	const operatorScopes = params.resolveOperatorScopes(params.req, requestAuth);
	const scopeAuth = authorizeOperatorScopesForMethod(params.operatorMethod, operatorScopes);
	if (!scopeAuth.allowed) {
		sendMissingScopeForbidden(params.res, scopeAuth.missingScope);
		return null;
	}
	return {
		cfg,
		requestAuth,
		operatorScopes
	};
}
function isGatewayBearerHttpRequest(req, auth) {
	return usesSharedSecretHttpAuth(auth) && Boolean(getBearerToken(req));
}
function resolveTrustedHttpOperatorScopes(req, authOrRequest) {
	if (!shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest)) return [];
	const headerValue = getHeader(req, "x-openclaw-scopes");
	if (headerValue === void 0) return [...CLI_DEFAULT_OPERATOR_SCOPES];
	const raw = headerValue.trim();
	if (!raw) return [];
	return raw.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0);
}
function resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth) {
	return resolveSharedSecretHttpOperatorScopes(req, requestAuth);
}
function resolveSharedSecretHttpOperatorScopes(req, requestAuth) {
	if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) return [...CLI_DEFAULT_OPERATOR_SCOPES];
	return resolveTrustedHttpOperatorScopes(req, requestAuth);
}
function resolveHttpSenderIsOwner(req, authOrRequest) {
	return resolveTrustedHttpOperatorScopes(req, authOrRequest).includes(ADMIN_SCOPE);
}
function resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth) {
	if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) return true;
	return resolveHttpSenderIsOwner(req, requestAuth);
}
//#endregion
export { getHeader as a, resolveHttpSenderIsOwner as c, resolveSharedSecretHttpOperatorScopes as d, resolveTrustedHttpOperatorScopes as f, getBearerToken as i, resolveOpenAiCompatibleHttpOperatorScopes as l, authorizeScopedGatewayHttpRequestOrReply as n, isGatewayBearerHttpRequest as o, checkGatewayHttpRequestAuth as r, resolveHttpBrowserOriginPolicy as s, authorizeGatewayHttpRequestOrReply as t, resolveOpenAiCompatibleHttpSenderIsOwner as u };
