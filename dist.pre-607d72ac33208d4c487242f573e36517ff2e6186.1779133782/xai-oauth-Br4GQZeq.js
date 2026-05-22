import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { g as toFormUrlEncoded, m as generateHexPkceVerifierChallenge } from "./provider-auth-B7pd3okH.js";
import { t as buildOauthProviderAuthResult } from "./provider-auth-result-DCcA22WH.js";
import "./error-runtime-Bx-JXJwN.js";
import { s as waitForLocalOAuthCallback } from "./provider-auth-runtime-D1SQhxFJ.js";
import { n as applyXaiConfig, t as XAI_DEFAULT_MODEL_REF } from "./onboard-BG7uzgwC.js";
import { t as xaiUserAgent } from "./xai-user-agent-B0To0Hlf.js";
import { randomBytes } from "node:crypto";
//#region extensions/xai/xai-oauth.ts
const PROVIDER_ID = "xai";
const XAI_OAUTH_METHOD_ID = "oauth";
const XAI_OAUTH_CHOICE_ID = "xai-oauth";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CALLBACK_HOST = "127.0.0.1";
const XAI_OAUTH_CALLBACK_PORT = 56121;
const XAI_OAUTH_CALLBACK_PATH = "/callback";
const XAI_OAUTH_REDIRECT_URI = `http://${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT}${XAI_OAUTH_CALLBACK_PATH}`;
const XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST = ["auth.x.ai", "accounts.x.ai"];
const XAI_OAUTH_TIMEOUT_MS = 300 * 1e3;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30 * 1e3;
function getFetchImpl(fetchImpl) {
	return fetchImpl ?? fetch;
}
function isTrustedXaiOAuthEndpoint(endpoint) {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "https:") return false;
		return url.hostname === "x.ai" || url.hostname.endsWith(".x.ai");
	} catch {
		return false;
	}
}
function requireTrustedXaiOAuthEndpoint(endpoint, label) {
	if (!isTrustedXaiOAuthEndpoint(endpoint)) throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
	return endpoint;
}
function readStringRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function readJsonResponse(response, context) {
	let body;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const errorText = readStringRecord(body).error_description ?? readStringRecord(body).error;
		throw new Error(`${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`);
	}
	return body;
}
async function fetchXaiOAuthDiscovery(options = {}) {
	const json = readStringRecord(await readJsonResponse(await getFetchImpl(options.fetchImpl)(XAI_OAUTH_DISCOVERY_URL, {
		headers: {
			Accept: "application/json",
			"User-Agent": xaiUserAgent()
		},
		signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS)
	}), "xAI OAuth discovery"));
	const authorizationEndpoint = json.authorization_endpoint;
	const tokenEndpoint = json.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") throw new Error("xAI OAuth discovery response is missing endpoints");
	return {
		authorizationEndpoint: requireTrustedXaiOAuthEndpoint(authorizationEndpoint, "authorization endpoint"),
		tokenEndpoint: requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint")
	};
}
function buildXaiOAuthAuthorizeUrl(params) {
	const url = new URL(requireTrustedXaiOAuthEndpoint(params.authorizationEndpoint, "authorization endpoint"));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", XAI_OAUTH_REDIRECT_URI);
	url.searchParams.set("scope", XAI_OAUTH_SCOPE);
	url.searchParams.set("state", params.state);
	url.searchParams.set("nonce", params.nonce);
	url.searchParams.set("code_challenge", params.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("plan", "generic");
	url.searchParams.set("referrer", "openclaw");
	return url.toString();
}
function buildXaiOAuthAuthorizationCodeTokenBody(params) {
	return {
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: XAI_OAUTH_REDIRECT_URI,
		client_id: XAI_OAUTH_CLIENT_ID,
		code_verifier: params.codeVerifier,
		code_challenge: params.codeChallenge,
		code_challenge_method: "S256"
	};
}
function normalizeExpires(value, now) {
	const seconds = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return;
	return now() + seconds * 1e3;
}
function parseXaiOAuthTokenResponse(value, now, options = {}) {
	const json = readStringRecord(value);
	const accessToken = json.access_token;
	if (typeof accessToken !== "string" || accessToken.trim().length === 0) throw new Error("xAI OAuth token response is missing access_token");
	const refreshToken = typeof json.refresh_token === "string" && json.refresh_token.trim().length > 0 ? json.refresh_token : void 0;
	if (options.requireRefreshToken && !refreshToken) throw new Error("xAI OAuth token response is missing refresh_token. Re-run the login; if the issue persists, the OAuth client is not configured to issue refresh tokens (commonly because the offline_access scope was rejected).");
	const idToken = typeof json.id_token === "string" && json.id_token.trim().length > 0 ? json.id_token : void 0;
	const expires = normalizeExpires(json.expires_in, now) ?? deriveExpiresFromJwt(accessToken);
	return {
		accessToken,
		...refreshToken ? { refreshToken } : {},
		...idToken ? { idToken } : {},
		...expires ? { expires } : {}
	};
}
function deriveExpiresFromJwt(token) {
	if (!token) return;
	const exp = decodeJwtPayload(token).exp;
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return;
	return exp * 1e3;
}
async function exchangeXaiOAuthToken(params) {
	return parseXaiOAuthTokenResponse(await readJsonResponse(await getFetchImpl(params.fetchImpl)(requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, "token endpoint"), {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": xaiUserAgent()
		},
		body: toFormUrlEncoded(params.body),
		signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS)
	}), params.context), params.now ?? Date.now, { requireRefreshToken: params.requireRefreshToken });
}
function decodeJwtPayload(token) {
	if (!token) return {};
	const part = token.split(".")[1];
	if (!part) return {};
	try {
		return readStringRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
	} catch {
		return {};
	}
}
function resolveXaiOAuthIdentity(tokens) {
	const payload = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
	const email = typeof payload.email === "string" ? payload.email : void 0;
	const name = typeof payload.name === "string" ? payload.name : void 0;
	const sub = typeof payload.sub === "string" ? payload.sub : void 0;
	return {
		...email ? { email } : {},
		...name ? { displayName: name } : {},
		...sub ? { accountId: sub } : {}
	};
}
function readCredentialString(credential, key) {
	const value = credential[key];
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
async function noteXaiOAuthUrl(ctx, authorizeUrl) {
	const lines = ["Open this xAI OAuth URL in your browser:", authorizeUrl];
	if (ctx.isRemote) lines.push("", "Remote host: forward the callback before signing in:", `ssh -N -L ${XAI_OAUTH_CALLBACK_PORT}:${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT} <host>`);
	await ctx.prompter.note(lines.join("\n"), "xAI OAuth");
}
async function loginXaiOAuth(ctx) {
	const progress = ctx.prompter.progress("Starting xAI OAuth...");
	try {
		const discovery = await fetchXaiOAuthDiscovery();
		const pkce = generateHexPkceVerifierChallenge();
		const state = randomBytes(32).toString("hex");
		const nonce = randomBytes(16).toString("hex");
		const authorizeUrl = buildXaiOAuthAuthorizeUrl({
			authorizationEndpoint: discovery.authorizationEndpoint,
			state,
			nonce,
			challenge: pkce.challenge
		});
		progress.update(`Waiting for xAI OAuth callback on ${XAI_OAUTH_REDIRECT_URI}...`);
		const callbackPromise = waitForLocalOAuthCallback({
			expectedState: state,
			timeoutMs: XAI_OAUTH_TIMEOUT_MS,
			port: XAI_OAUTH_CALLBACK_PORT,
			callbackPath: XAI_OAUTH_CALLBACK_PATH,
			redirectUri: XAI_OAUTH_REDIRECT_URI,
			hostname: XAI_OAUTH_CALLBACK_HOST,
			successTitle: "xAI OAuth complete",
			onProgress: (message) => progress.update(message),
			corsOriginAllowlist: XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST
		});
		callbackPromise.catch(() => void 0);
		await noteXaiOAuthUrl(ctx, authorizeUrl);
		if (!ctx.isRemote) await ctx.openUrl(authorizeUrl);
		const callback = await callbackPromise;
		const tokens = await exchangeXaiOAuthToken({
			tokenEndpoint: discovery.tokenEndpoint,
			context: "xAI OAuth token exchange",
			requireRefreshToken: true,
			body: buildXaiOAuthAuthorizationCodeTokenBody({
				code: callback.code,
				codeVerifier: pkce.verifier,
				codeChallenge: pkce.challenge
			})
		});
		const identity = resolveXaiOAuthIdentity(tokens);
		progress.stop("xAI OAuth complete");
		return buildOauthProviderAuthResult({
			providerId: PROVIDER_ID,
			defaultModel: XAI_DEFAULT_MODEL_REF,
			access: tokens.accessToken,
			refresh: tokens.refreshToken,
			expires: tokens.expires,
			email: identity.email,
			displayName: identity.displayName,
			profileName: identity.email ?? identity.accountId,
			configPatch: applyXaiConfig(ctx.config),
			credentialExtra: {
				tokenEndpoint: discovery.tokenEndpoint,
				issuer: XAI_OAUTH_ISSUER,
				...tokens.idToken ? { idToken: tokens.idToken } : {},
				...identity.accountId ? { accountId: identity.accountId } : {}
			},
			notes: ["xAI OAuth uses your xAI account entitlement; xAI API keys still work.", "xAI may label the consent app as Grok Build because OpenClaw uses xAI's shared OAuth client."]
		});
	} catch (err) {
		progress.stop("xAI OAuth failed");
		throw new Error(`xAI OAuth failed: ${formatErrorMessage(err)}`, { cause: err });
	}
}
async function refreshXaiOAuthCredential(credential, options = {}) {
	const refreshToken = credential.refresh;
	if (!refreshToken) throw new Error("xAI OAuth credential is missing refresh token");
	const tokenEndpoint = readCredentialString(credential, "tokenEndpoint") ?? (await fetchXaiOAuthDiscovery(options)).tokenEndpoint;
	const tokens = await exchangeXaiOAuthToken({
		...options,
		tokenEndpoint,
		context: "xAI OAuth refresh",
		body: {
			grant_type: "refresh_token",
			client_id: XAI_OAUTH_CLIENT_ID,
			refresh_token: refreshToken
		}
	});
	const identity = resolveXaiOAuthIdentity(tokens);
	return {
		...credential,
		type: "oauth",
		provider: PROVIDER_ID,
		access: tokens.accessToken,
		refresh: tokens.refreshToken ?? refreshToken,
		...tokens.expires ? { expires: tokens.expires } : {},
		...tokens.idToken ? { idToken: tokens.idToken } : {},
		...identity.email ? { email: identity.email } : {},
		...identity.displayName ? { displayName: identity.displayName } : {},
		...identity.accountId ? { accountId: identity.accountId } : {},
		tokenEndpoint,
		issuer: XAI_OAUTH_ISSUER
	};
}
function createXaiOAuthAuthMethod() {
	return {
		id: XAI_OAUTH_METHOD_ID,
		label: "xAI OAuth",
		hint: "Browser sign-in for eligible xAI accounts",
		kind: "oauth",
		wizard: {
			choiceId: XAI_OAUTH_CHOICE_ID,
			choiceLabel: "xAI OAuth",
			choiceHint: "Browser sign-in for eligible xAI accounts",
			groupId: PROVIDER_ID,
			groupLabel: "xAI (Grok)",
			groupHint: "API key or browser OAuth",
			methodId: XAI_OAUTH_METHOD_ID
		},
		run: async (ctx) => loginXaiOAuth(ctx)
	};
}
//#endregion
export { loginXaiOAuth as _, XAI_OAUTH_CHOICE_ID as a, XAI_OAUTH_ISSUER as c, XAI_OAUTH_SCOPE as d, buildXaiOAuthAuthorizationCodeTokenBody as f, isTrustedXaiOAuthEndpoint as g, fetchXaiOAuthDiscovery as h, XAI_OAUTH_CALLBACK_PORT as i, XAI_OAUTH_METHOD_ID as l, createXaiOAuthAuthMethod as m, XAI_OAUTH_CALLBACK_HOST as n, XAI_OAUTH_CLIENT_ID as o, buildXaiOAuthAuthorizeUrl as p, XAI_OAUTH_CALLBACK_PATH as r, XAI_OAUTH_DISCOVERY_URL as s, XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST as t, XAI_OAUTH_REDIRECT_URI as u, refreshXaiOAuthCredential as v };
