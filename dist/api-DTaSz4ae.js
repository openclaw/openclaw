import { o as __toESM } from "./chunk-CNf5ZN-e.js";
import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { n as readResponseWithLimit } from "./read-response-with-limit-S6PVjcFB.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as buildHostnameAllowlistPolicyFromSuffixAllowlist } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./text-utility-runtime-CaGXarh9.js";
import "./runtime-api-BjlJCGKW.js";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region extensions/googlechat/src/google-auth.runtime.ts
const GOOGLE_AUTH_POLICY = buildHostnameAllowlistPolicyFromSuffixAllowlist(["accounts.google.com", "googleapis.com"]);
const GOOGLE_AUTH_AUDIT_CONTEXT = "googlechat.auth.google-auth";
const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_AUTH_PROVIDER_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_AUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_UNIVERSE_DOMAIN = "googleapis.com";
const GOOGLE_CLIENT_CERTS_URL_PREFIX = "https://www.googleapis.com/robot/v1/metadata/x509/";
const MAX_GOOGLE_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES = 64 * 1024;
let googleAuthRuntimePromise = null;
function normalizeGoogleAuthPreparedRequestHeaders(config) {
	if (!(config.headers instanceof Headers)) config.headers = new Headers(config.headers);
	return config;
}
function normalizeGoogleAuthResponseHeaders(response) {
	if (!(response.headers instanceof Headers)) response.headers = new Headers(response.headers);
	return response;
}
function installGoogleAuthHeaderCompatibilityInterceptor(transport) {
	transport.interceptors.request.add({ resolved: async (config) => normalizeGoogleAuthPreparedRequestHeaders(config) });
	transport.interceptors.response.add({ resolved: async (response) => normalizeGoogleAuthResponseHeaders(response) });
	return transport;
}
function asNullableObjectRecord(value) {
	return value !== null && typeof value === "object" ? value : null;
}
function hasProxyAgentShape(value) {
	const record = asNullableObjectRecord(value);
	return record !== null && record.proxy instanceof URL;
}
function hasTlsAgentShape(value) {
	const record = asNullableObjectRecord(value);
	return record !== null && asNullableObjectRecord(record.options) !== null;
}
function resolveGoogleAuthAgent(init, url) {
	return typeof init.agent === "function" ? init.agent(url) : init.agent;
}
function hasTlsOptions(options) {
	return options.cert !== void 0 || options.key !== void 0;
}
function resolveGoogleAuthTlsOptions(init, url) {
	const explicit = {
		cert: init.cert,
		key: init.key
	};
	if (hasTlsOptions(explicit)) return explicit;
	const agent = resolveGoogleAuthAgent(init, url);
	if (hasProxyAgentShape(agent)) return {
		cert: agent.connectOpts?.cert,
		key: agent.connectOpts?.key
	};
	if (hasTlsAgentShape(agent)) return {
		cert: agent.options?.cert,
		key: agent.options?.key
	};
	return {};
}
function normalizeGoogleAuthProxyEnvValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function resolveGoogleAuthEnvProxyUrl(protocol) {
	const httpProxy = normalizeGoogleAuthProxyEnvValue(process.env.HTTP_PROXY) ?? normalizeGoogleAuthProxyEnvValue(process.env.http_proxy);
	const httpsProxy = normalizeGoogleAuthProxyEnvValue(process.env.HTTPS_PROXY) ?? normalizeGoogleAuthProxyEnvValue(process.env.https_proxy);
	if (protocol === "https") return httpsProxy ?? httpProxy ?? void 0;
	return httpProxy ?? void 0;
}
function collectGoogleAuthNoProxyRules(noProxy = []) {
	const rules = [...noProxy];
	const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
	for (const rule of envRules) {
		const trimmed = rule.trim();
		if (trimmed.length > 0) rules.push(trimmed);
	}
	return rules;
}
function shouldBypassGoogleAuthProxy(url, noProxy = []) {
	for (const rule of collectGoogleAuthNoProxyRules(noProxy)) {
		if (rule instanceof RegExp) {
			if (rule.test(url.toString())) return true;
			continue;
		}
		if (rule instanceof URL) {
			if (rule.origin === url.origin) return true;
			continue;
		}
		if (rule.startsWith("*.") || rule.startsWith(".")) {
			const cleanedRule = rule.replace(/^\*\./, ".");
			if (url.hostname.endsWith(cleanedRule)) return true;
			continue;
		}
		if (rule === url.origin || rule === url.hostname || rule === url.href) return true;
	}
	return false;
}
function readGoogleAuthProxyUrl(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : void 0;
	}
	if (value instanceof URL) return value.toString();
}
function readOptionalTrimmedString(record, fieldName) {
	const value = record[fieldName];
	if (value === void 0 || value === null) return;
	if (typeof value !== "string") throw new Error(`Google Chat service account field "${fieldName}" must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Google Chat service account field "${fieldName}" cannot be empty`);
	return trimmed;
}
function readRequiredTrimmedString(record, fieldName) {
	return readOptionalTrimmedString(record, fieldName) ?? (() => {
		throw new Error(`Google Chat service account is missing "${fieldName}"`);
	})();
}
function assertExactUrlField(record, fieldName, expectedUrl) {
	const value = readOptionalTrimmedString(record, fieldName);
	if (!value) return;
	if (value !== expectedUrl) throw new Error(`Google Chat service account field "${fieldName}" must be ${expectedUrl}, got ${value}`);
}
function assertUrlPrefixField(record, fieldName, expectedPrefix) {
	const value = readOptionalTrimmedString(record, fieldName);
	if (!value) return;
	if (!value.startsWith(expectedPrefix)) throw new Error(`Google Chat service account field "${fieldName}" must start with ${expectedPrefix}, got ${value}`);
}
function validateGoogleChatServiceAccountCredentials(credentials) {
	const type = readOptionalTrimmedString(credentials, "type");
	if (type && type !== "service_account") throw new Error(`Google Chat credentials must use service_account auth, got "${type}" instead`);
	readRequiredTrimmedString(credentials, "client_email");
	readRequiredTrimmedString(credentials, "private_key");
	const universeDomain = readOptionalTrimmedString(credentials, "universe_domain");
	if (universeDomain && universeDomain !== GOOGLE_AUTH_UNIVERSE_DOMAIN) throw new Error(`Google Chat service account field "universe_domain" must be ${GOOGLE_AUTH_UNIVERSE_DOMAIN}, got ${universeDomain}`);
	assertExactUrlField(credentials, "auth_uri", GOOGLE_AUTH_URI);
	assertExactUrlField(credentials, "auth_provider_x509_cert_url", GOOGLE_AUTH_PROVIDER_CERTS_URL);
	assertExactUrlField(credentials, "token_uri", GOOGLE_AUTH_TOKEN_URI);
	assertUrlPrefixField(credentials, "client_x509_cert_url", GOOGLE_CLIENT_CERTS_URL_PREFIX);
	return credentials;
}
async function readCredentialsFile(filePath) {
	const resolvedPath = resolveUserPath(filePath);
	if (!resolvedPath) throw new Error("Google Chat service account file path is empty");
	let handle = null;
	try {
		handle = await fs.open(resolvedPath, "r");
	} catch {
		throw new Error("Failed to load Google Chat service account file.");
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("Google Chat service account file must be a regular file.");
		if (stat.size > MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES) throw new Error(`Google Chat service account file exceeds ${MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES} bytes.`);
		let raw;
		try {
			raw = await handle.readFile({ encoding: "utf8" });
		} catch {
			throw new Error("Failed to load Google Chat service account file.");
		}
		if (Buffer.byteLength(raw, "utf8") > MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES) throw new Error(`Google Chat service account file exceeds ${MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES} bytes.`);
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("Invalid Google Chat service account JSON.");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Google Chat service account file must contain a JSON object.");
		return parsed;
	} finally {
		await handle.close().catch(() => {});
	}
}
function sanitizeGoogleAuthInit(init) {
	if (!init) return;
	const nextInit = { ...init };
	delete nextInit.agent;
	delete nextInit.cert;
	delete nextInit.dispatcher;
	delete nextInit.fetchImplementation;
	delete nextInit.key;
	delete nextInit.noProxy;
	delete nextInit.proxy;
	return nextInit;
}
function resolveGoogleAuthDispatcherPolicy(input, init) {
	const requestUrl = input instanceof Request ? new URL(input.url) : new URL(typeof input === "string" ? input : input.toString());
	const nextInit = sanitizeGoogleAuthInit(init);
	const googleAuthInit = init ?? {};
	const tlsOptions = resolveGoogleAuthTlsOptions(googleAuthInit, requestUrl);
	const proxyBypassed = shouldBypassGoogleAuthProxy(requestUrl, Array.isArray(googleAuthInit.noProxy) ? googleAuthInit.noProxy : []);
	const agent = resolveGoogleAuthAgent(googleAuthInit, requestUrl);
	const explicitProxy = readGoogleAuthProxyUrl(googleAuthInit.proxy) ?? (hasProxyAgentShape(agent) ? agent.proxy.toString() : void 0);
	if (!proxyBypassed && explicitProxy) return {
		dispatcherPolicy: {
			allowPrivateProxy: true,
			mode: "explicit-proxy",
			...hasTlsOptions(tlsOptions) ? { proxyTls: { ...tlsOptions } } : {},
			proxyUrl: explicitProxy
		},
		init: nextInit
	};
	if (proxyBypassed ? void 0 : resolveGoogleAuthEnvProxyUrl(requestUrl.protocol === "http:" ? "http" : "https")) return {
		dispatcherPolicy: {
			mode: "env-proxy",
			...hasTlsOptions(tlsOptions) ? { proxyTls: { ...tlsOptions } } : {}
		},
		init: nextInit
	};
	if (hasTlsOptions(tlsOptions)) return {
		dispatcherPolicy: {
			connect: { ...tlsOptions },
			mode: "direct"
		},
		init: nextInit
	};
	return { init: nextInit };
}
function createGoogleAuthFetch(baseFetch) {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const guardedOptions = resolveGoogleAuthDispatcherPolicy(input, init);
		const { response, release } = await fetchWithSsrFGuard({
			auditContext: GOOGLE_AUTH_AUDIT_CONTEXT,
			dispatcherPolicy: guardedOptions.dispatcherPolicy,
			init: guardedOptions.init,
			policy: GOOGLE_AUTH_POLICY,
			url,
			...baseFetch ? { fetchImpl: baseFetch } : {}
		});
		try {
			const body = await readGoogleAuthResponseBytes(response);
			const bufferedBody = Uint8Array.from(body);
			return new Response(bufferedBody.buffer, {
				headers: response.headers,
				status: response.status,
				statusText: response.statusText
			});
		} finally {
			await release();
		}
	};
}
async function readGoogleAuthResponseBytes(response) {
	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader) {
		const contentLength = Number(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength > MAX_GOOGLE_AUTH_RESPONSE_BYTES) throw new Error(`Google auth response exceeds ${MAX_GOOGLE_AUTH_RESPONSE_BYTES} bytes.`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Google auth response body stream unavailable; refusing to buffer unbounded response.");
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_GOOGLE_AUTH_RESPONSE_BYTES) {
				try {
					await reader.cancel("Google auth response exceeded buffer limit");
				} catch {}
				throw new Error(`Google auth response exceeds ${MAX_GOOGLE_AUTH_RESPONSE_BYTES} bytes.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
async function loadGoogleAuthRuntime() {
	if (!googleAuthRuntimePromise) googleAuthRuntimePromise = (async () => {
		try {
			const [googleAuthModule, gaxiosModule] = await Promise.all([import("./src-B1sC_XUd.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1)), import("./src-ChHMeDfb.js")]);
			return {
				Gaxios: gaxiosModule.Gaxios,
				GoogleAuth: googleAuthModule.GoogleAuth,
				OAuth2Client: googleAuthModule.OAuth2Client
			};
		} catch (error) {
			googleAuthRuntimePromise = null;
			throw error;
		}
	})();
	return await googleAuthRuntimePromise;
}
async function getGoogleAuthTransport() {
	const { Gaxios } = await loadGoogleAuthRuntime();
	return installGoogleAuthHeaderCompatibilityInterceptor(new Gaxios({ fetchImplementation: createGoogleAuthFetch() }));
}
async function resolveValidatedGoogleChatCredentials(account) {
	if (account.credentials) return validateGoogleChatServiceAccountCredentials(account.credentials);
	if (account.credentialsFile) return validateGoogleChatServiceAccountCredentials(await readCredentialsFile(account.credentialsFile));
	return null;
}
//#endregion
//#region extensions/googlechat/src/auth.ts
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
async function readGoogleChatCertsResponse(response) {
	try {
		return await response.json();
	} catch (cause) {
		throw new Error("Google Chat cert fetch failed: malformed JSON response", { cause });
	}
}
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = /* @__PURE__ */ new Map();
let cachedCerts = null;
let verifyClientPromise = null;
async function getVerifyClient() {
	if (!verifyClientPromise) verifyClientPromise = (async () => {
		try {
			const { OAuth2Client } = await loadGoogleAuthRuntime();
			return new OAuth2Client({ transporter: await getGoogleAuthTransport() });
		} catch (error) {
			verifyClientPromise = null;
			throw error;
		}
	})();
	return await verifyClientPromise;
}
function buildAuthKey(account) {
	if (account.credentialsFile) return `file:${account.credentialsFile}`;
	if (account.credentials) return `inline:${JSON.stringify(account.credentials)}`;
	return "none";
}
async function getAuthInstance(account) {
	const key = buildAuthKey(account);
	const cached = authCache.get(account.accountId);
	if (cached && cached.key === key) return cached.auth;
	const [{ GoogleAuth }, rawTransporter, credentials] = await Promise.all([
		loadGoogleAuthRuntime(),
		getGoogleAuthTransport(),
		resolveValidatedGoogleChatCredentials(account)
	]);
	const transporter = rawTransporter;
	const evictOldest = () => {
		if (authCache.size > MAX_AUTH_CACHE_SIZE) {
			const oldest = authCache.keys().next().value;
			if (oldest !== void 0) authCache.delete(oldest);
		}
	};
	const auth = new GoogleAuth({
		...credentials ? { credentials } : {},
		clientOptions: { transporter },
		scopes: [CHAT_SCOPE]
	});
	authCache.set(account.accountId, {
		key,
		auth
	});
	evictOldest();
	return auth;
}
async function getGoogleChatAccessToken(account) {
	const access = await (await (await getAuthInstance(account)).getClient()).getAccessToken();
	const token = typeof access === "string" ? access : access?.token;
	if (!token) throw new Error("Missing Google Chat access token");
	return token;
}
async function fetchChatCerts() {
	const now = Date.now();
	if (cachedCerts && now - cachedCerts.fetchedAt < 600 * 1e3) return cachedCerts.certs;
	const { response, release } = await fetchWithSsrFGuard({
		url: CHAT_CERTS_URL,
		auditContext: "googlechat.auth.certs"
	});
	try {
		if (!response.ok) throw new Error(`Failed to fetch Chat certs (${response.status})`);
		const certs = await readGoogleChatCertsResponse(response);
		cachedCerts = {
			fetchedAt: now,
			certs
		};
		return certs;
	} finally {
		await release();
	}
}
async function verifyGoogleChatRequest(params) {
	const bearer = params.bearer?.trim();
	if (!bearer) return {
		ok: false,
		reason: "missing token"
	};
	const audience = params.audience?.trim();
	if (!audience) return {
		ok: false,
		reason: "missing audience"
	};
	const audienceType = params.audienceType ?? null;
	if (audienceType === "app-url") try {
		const payload = (await (await getVerifyClient()).verifyIdToken({
			idToken: bearer,
			audience
		})).getPayload();
		const email = normalizeLowercaseStringOrEmpty(payload?.email ?? "");
		if (!payload?.email_verified) return {
			ok: false,
			reason: "email not verified"
		};
		if (email === CHAT_ISSUER) return { ok: true };
		if (!ADDON_ISSUER_PATTERN.test(email)) return {
			ok: false,
			reason: `invalid issuer: ${email}`
		};
		const expectedAddOnPrincipal = normalizeLowercaseStringOrEmpty(params.expectedAddOnPrincipal ?? "");
		if (!expectedAddOnPrincipal) return {
			ok: false,
			reason: "missing add-on principal binding"
		};
		const tokenPrincipal = normalizeLowercaseStringOrEmpty(payload?.sub ?? "");
		if (!tokenPrincipal || tokenPrincipal !== expectedAddOnPrincipal) return {
			ok: false,
			reason: `unexpected add-on principal: ${tokenPrincipal || "<missing>"}`
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : "invalid token"
		};
	}
	if (audienceType === "project-number") try {
		const verifyClient = await getVerifyClient();
		const certs = await fetchChatCerts();
		await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : "invalid token"
		};
	}
	return {
		ok: false,
		reason: "unsupported audience type"
	};
}
//#endregion
//#region extensions/googlechat/src/api.ts
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";
async function readGoogleChatJsonResponse(response, label) {
	try {
		return await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
}
const headersToObject = (headers) => headers instanceof Headers ? Object.fromEntries(headers.entries()) : Array.isArray(headers) ? Object.fromEntries(headers) : headers || {};
async function withGoogleChatResponse(params) {
	const { account, url, init, auditContext, errorPrefix = "Google Chat API", handleResponse } = params;
	const token = await getGoogleChatAccessToken(account);
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: {
			...init,
			headers: {
				...headersToObject(init?.headers),
				Authorization: `Bearer ${token}`
			}
		},
		auditContext
	});
	try {
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`${errorPrefix} ${response.status}: ${text || response.statusText}`);
		}
		return await handleResponse(response);
	} finally {
		await release();
	}
}
async function fetchJson(account, url, init) {
	return await withGoogleChatResponse({
		account,
		url,
		init: {
			...init,
			headers: {
				...headersToObject(init.headers),
				"Content-Type": "application/json"
			}
		},
		auditContext: "googlechat.api.json",
		handleResponse: async (response) => await readGoogleChatJsonResponse(response, "Google Chat API request failed")
	});
}
async function fetchOk(account, url, init) {
	await withGoogleChatResponse({
		account,
		url,
		init,
		auditContext: "googlechat.api.ok",
		handleResponse: async () => void 0
	});
}
async function fetchBuffer(account, url, init, options) {
	return await withGoogleChatResponse({
		account,
		url,
		init,
		auditContext: "googlechat.api.buffer",
		handleResponse: async (res) => {
			const maxBytes = options?.maxBytes;
			const lengthHeader = res.headers.get("content-length");
			if (maxBytes && lengthHeader) {
				const length = Number(lengthHeader);
				if (Number.isFinite(length) && length > maxBytes) throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
			}
			if (!maxBytes) return {
				buffer: Buffer.from(await res.arrayBuffer()),
				contentType: res.headers.get("content-type") ?? void 0
			};
			return {
				buffer: await readResponseWithLimit(res, maxBytes, { onOverflow: () => /* @__PURE__ */ new Error(`Google Chat media exceeds max bytes (${maxBytes})`) }),
				contentType: res.headers.get("content-type") ?? void 0
			};
		}
	});
}
async function sendGoogleChatMessage(params) {
	const { account, space, text, thread, attachments } = params;
	const body = {};
	if (text) body.text = text;
	if (thread) body.thread = { name: thread };
	if (attachments && attachments.length > 0) body.attachment = attachments.map((item) => Object.assign({ attachmentDataRef: { attachmentUploadToken: item.attachmentUploadToken } }, item.contentName ? { contentName: item.contentName } : {}));
	const urlObj = new URL(`${CHAT_API_BASE}/${space}/messages`);
	if (thread) urlObj.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
	const result = await fetchJson(account, urlObj.toString(), {
		method: "POST",
		body: JSON.stringify(body)
	});
	return result ? { messageName: result.name } : null;
}
async function updateGoogleChatMessage(params) {
	const { account, messageName, text } = params;
	return { messageName: (await fetchJson(account, `${CHAT_API_BASE}/${messageName}?updateMask=text`, {
		method: "PATCH",
		body: JSON.stringify({ text })
	})).name };
}
async function deleteGoogleChatMessage(params) {
	const { account, messageName } = params;
	await fetchOk(account, `${CHAT_API_BASE}/${messageName}`, { method: "DELETE" });
}
async function uploadGoogleChatAttachment(params) {
	const { account, space, filename, buffer, contentType } = params;
	const boundary = `openclaw-${crypto.randomUUID()}`;
	const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename })}\r\n`;
	const mediaHeader = `--${boundary}\r\nContent-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;
	const footer = `\r\n--${boundary}--\r\n`;
	const body = Buffer.concat([
		Buffer.from(header, "utf8"),
		Buffer.from(mediaHeader, "utf8"),
		buffer,
		Buffer.from(footer, "utf8")
	]);
	return { attachmentUploadToken: (await withGoogleChatResponse({
		account,
		url: `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`,
		init: {
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body
		},
		auditContext: "googlechat.upload",
		errorPrefix: "Google Chat upload",
		handleResponse: async (response) => await readGoogleChatJsonResponse(response, "Google Chat upload failed")
	})).attachmentDataRef?.attachmentUploadToken };
}
async function downloadGoogleChatMedia(params) {
	const { account, resourceName, maxBytes } = params;
	return await fetchBuffer(account, `${CHAT_API_BASE}/media/${resourceName}?alt=media`, void 0, { maxBytes });
}
async function createGoogleChatReaction(params) {
	const { account, messageName, emoji } = params;
	return await fetchJson(account, `${CHAT_API_BASE}/${messageName}/reactions`, {
		method: "POST",
		body: JSON.stringify({ emoji: { unicode: emoji } })
	});
}
async function listGoogleChatReactions(params) {
	const { account, messageName, limit } = params;
	const url = new URL(`${CHAT_API_BASE}/${messageName}/reactions`);
	if (limit && limit > 0) url.searchParams.set("pageSize", String(limit));
	return (await fetchJson(account, url.toString(), { method: "GET" })).reactions ?? [];
}
async function deleteGoogleChatReaction(params) {
	const { account, reactionName } = params;
	await fetchOk(account, `${CHAT_API_BASE}/${reactionName}`, { method: "DELETE" });
}
async function findGoogleChatDirectMessage(params) {
	const { account, userName } = params;
	const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
	url.searchParams.set("name", userName);
	return await fetchJson(account, url.toString(), { method: "GET" });
}
async function probeGoogleChat(account) {
	try {
		const url = new URL(`${CHAT_API_BASE}/spaces`);
		url.searchParams.set("pageSize", "1");
		await fetchJson(account, url.toString(), { method: "GET" });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
export { findGoogleChatDirectMessage as a, sendGoogleChatMessage as c, verifyGoogleChatRequest as d, downloadGoogleChatMedia as i, updateGoogleChatMessage as l, deleteGoogleChatMessage as n, listGoogleChatReactions as o, deleteGoogleChatReaction as r, probeGoogleChat as s, createGoogleChatReaction as t, uploadGoogleChatAttachment as u };
