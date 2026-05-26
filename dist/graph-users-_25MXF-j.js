import { o as __toESM } from "./chunk-CNf5ZN-e.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as isRecord$1 } from "./utils-sBTEdeml.js";
import { d as normalizeSecretInputString, s as hasConfiguredSecretInput, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
import { u as isPrivateIpAddress } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { m as readProviderJsonResponse } from "./provider-http-errors-C90BH-le.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import { a as isHttpsUrlAllowedByHostnameSuffixAllowlist, c as normalizeHostnameSuffixAllowlist, n as buildHostnameAllowlistPolicyFromSuffixAllowlist } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./security-runtime-CcSekjBd.js";
import "./provider-http-CYBE-CBM.js";
import { t as getMSTeamsRuntime } from "./runtime-api-DN6i5eom.js";
import { n as refreshMSTeamsDelegatedTokens } from "./oauth.token-C2fbS5a3.js";
import { createRequire } from "node:module";
import * as fs$1 from "node:fs";
import { readFileSync } from "node:fs";
import path, { basename, dirname } from "node:path";
import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
//#region extensions/msteams/src/attachments/shared.ts
const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;
const DEFAULT_MEDIA_HOST_ALLOWLIST = [
	"graph.microsoft.com",
	"graph.microsoft.us",
	"graph.microsoft.de",
	"graph.microsoft.cn",
	"sharepoint.com",
	"sharepoint.us",
	"sharepoint.de",
	"sharepoint.cn",
	"sharepoint-df.com",
	"1drv.ms",
	"onedrive.com",
	"teams.microsoft.com",
	"teams.cdn.office.net",
	"statics.teams.cdn.office.net",
	"office.com",
	"office.net",
	"asm.skype.com",
	"ams.skype.com",
	"media.ams.skype.com",
	"trafficmanager.net",
	"blob.core.windows.net",
	"azureedge.net",
	"microsoft.com"
];
const DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST = [
	"api.botframework.com",
	"botframework.com",
	"smba.trafficmanager.net",
	"graph.microsoft.com",
	"graph.microsoft.us",
	"graph.microsoft.de",
	"graph.microsoft.cn"
];
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
function estimateBase64DecodedBytes(base64) {
	let effectiveLen = 0;
	for (let i = 0; i < base64.length; i += 1) {
		if (base64.charCodeAt(i) <= 32) continue;
		effectiveLen += 1;
	}
	if (effectiveLen === 0) return 0;
	let padding = 0;
	let end = base64.length - 1;
	while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
	if (end >= 0 && base64[end] === "=") {
		padding = 1;
		end -= 1;
		while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
		if (end >= 0 && base64[end] === "=") padding = 2;
	}
	const estimated = Math.floor(effectiveLen * 3 / 4) - padding;
	return Math.max(0, estimated);
}
/**
* Host suffixes for SharePoint/OneDrive shared links that must be fetched via
* the Graph `/shares/{shareId}/driveItem/content` endpoint instead of directly.
*
* Direct fetches of SharePoint/OneDrive shared URLs return empty/HTML landing
* pages unless encoded as a Graph share id. See
* https://learn.microsoft.com/en-us/graph/api/shares-get for the encoding.
*/
const GRAPH_SHARED_LINK_HOST_SUFFIXES = [
	".sharepoint.com",
	".sharepoint.us",
	".sharepoint.de",
	".sharepoint.cn",
	".sharepoint-df.com",
	"1drv.ms",
	"onedrive.live.com",
	"onedrive.com"
];
/**
* Returns true when the URL points at a SharePoint or OneDrive host whose
* shared-link content must be fetched through the Graph shares API rather
* than directly.
*/
function isGraphSharedLinkUrl(url) {
	let host;
	try {
		host = normalizeLowercaseStringOrEmpty(new URL(url).hostname);
	} catch {
		return false;
	}
	if (!host) return false;
	return GRAPH_SHARED_LINK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(suffix));
}
/**
* Encode a SharePoint/OneDrive URL as a Graph shareId using the documented
* `u!` + base64url (no padding) scheme:
* https://learn.microsoft.com/en-us/graph/api/shares-get#encoding-sharing-urls
*/
function encodeGraphShareId(url) {
	return `u!${Buffer.from(url, "utf8").toString("base64url")}`;
}
/**
* When `url` is a SharePoint/OneDrive shared link, return the matching
* `GET /shares/{shareId}/driveItem/content` URL that actually yields the file
* bytes. Returns `undefined` for non-shared-link URLs so callers can fall
* through to the existing fetch path.
*/
function tryBuildGraphSharesUrlForSharedLink(url) {
	if (!isGraphSharedLinkUrl(url)) return;
	return `${GRAPH_ROOT}/shares/${encodeGraphShareId(url)}/driveItem/content`;
}
function readNestedString(value, keys) {
	let current = value;
	for (const key of keys) {
		if (!isRecord$1(current)) return;
		current = current[key];
	}
	return normalizeOptionalString(current);
}
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof input === "object" && input && "url" in input && typeof input.url === "string") return input.url;
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}
function normalizeContentType(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function inferPlaceholder(params) {
	const mime = normalizeLowercaseStringOrEmpty(params.contentType ?? "");
	const name = normalizeLowercaseStringOrEmpty(params.fileName ?? "");
	const fileType = normalizeLowercaseStringOrEmpty(params.fileType ?? "");
	return mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`) ? "<media:image>" : "<media:document>";
}
function isLikelyImageAttachment(att) {
	const contentType = normalizeContentType(att.contentType) ?? "";
	const name = typeof att.name === "string" ? att.name : "";
	if (contentType.startsWith("image/")) return true;
	if (IMAGE_EXT_RE.test(name)) return true;
	if (contentType === "application/vnd.microsoft.teams.file.download.info" && isRecord$1(att.content)) {
		const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
		if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) return true;
		const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
		if (fileName && IMAGE_EXT_RE.test(fileName)) return true;
	}
	return false;
}
/**
* Returns true if the attachment can be downloaded (any file type).
* Used when downloading all files, not just images.
*/
function isDownloadableAttachment(att) {
	if ((normalizeContentType(att.contentType) ?? "") === "application/vnd.microsoft.teams.file.download.info" && isRecord$1(att.content) && typeof att.content.downloadUrl === "string") return true;
	if (typeof att.contentUrl === "string" && att.contentUrl.trim()) return true;
	return false;
}
function isHtmlAttachment(att) {
	return (normalizeContentType(att.contentType) ?? "").startsWith("text/html");
}
function extractHtmlFromAttachment(att) {
	if (!isHtmlAttachment(att)) return;
	if (typeof att.content === "string") return att.content;
	if (!isRecord$1(att.content)) return;
	return typeof att.content.text === "string" ? att.content.text : typeof att.content.body === "string" ? att.content.body : typeof att.content.content === "string" ? att.content.content : void 0;
}
function canonicalizeInlineBase64Payload(value) {
	let cleaned = "";
	let padding = 0;
	let sawPadding = false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 32) continue;
		if (code === 61) {
			padding += 1;
			if (padding > 2) return;
			sawPadding = true;
			cleaned += "=";
			continue;
		}
		if (sawPadding || !(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) return;
		cleaned += value[index];
	}
	return cleaned && cleaned.length % 4 === 0 ? cleaned : void 0;
}
function decodeDataImageWithLimits(src, opts) {
	const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
	if (!match) return {
		candidate: null,
		estimatedBytes: 0
	};
	const contentType = normalizeLowercaseStringOrEmpty(match[1] ?? "");
	if (!Boolean(match[2])) return {
		candidate: null,
		estimatedBytes: 0
	};
	const canonicalPayload = canonicalizeInlineBase64Payload(match[3] ?? "");
	if (!canonicalPayload) return {
		candidate: null,
		estimatedBytes: 0
	};
	const estimatedBytes = estimateBase64DecodedBytes(canonicalPayload);
	if (estimatedBytes <= 0) return {
		candidate: null,
		estimatedBytes: 0
	};
	if (typeof opts.maxInlineBytes === "number" && estimatedBytes > opts.maxInlineBytes) return {
		candidate: null,
		estimatedBytes
	};
	try {
		return {
			candidate: {
				kind: "data",
				data: Buffer.from(canonicalPayload, "base64"),
				contentType,
				placeholder: "<media:image>"
			},
			estimatedBytes
		};
	} catch {
		return {
			candidate: null,
			estimatedBytes: 0
		};
	}
}
function fileHintFromUrl(src) {
	try {
		return new URL(src).pathname.split("/").pop() || void 0;
	} catch {
		return;
	}
}
function extractInlineImageCandidates(attachments, limits) {
	const out = [];
	let totalEstimatedInlineBytes = 0;
	outerLoop: for (const att of attachments) {
		const html = extractHtmlFromAttachment(att);
		if (!html) continue;
		IMG_SRC_RE.lastIndex = 0;
		let match = IMG_SRC_RE.exec(html);
		while (match) {
			const src = match[1]?.trim();
			if (src && !src.startsWith("cid:")) if (src.startsWith("data:")) {
				const { candidate: decoded, estimatedBytes } = decodeDataImageWithLimits(src, { maxInlineBytes: limits?.maxInlineBytes });
				if (decoded) {
					const nextTotal = totalEstimatedInlineBytes + estimatedBytes;
					if (typeof limits?.maxInlineTotalBytes === "number" && nextTotal > limits.maxInlineTotalBytes) break outerLoop;
					totalEstimatedInlineBytes = nextTotal;
					out.push(decoded);
				}
			} else out.push({
				kind: "url",
				url: src,
				fileHint: fileHintFromUrl(src),
				placeholder: "<media:image>"
			});
			match = IMG_SRC_RE.exec(html);
		}
	}
	return out;
}
function safeHostForUrl(url) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(url).hostname);
	} catch {
		return "invalid-url";
	}
}
function resolveAllowedHosts(input) {
	return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_HOST_ALLOWLIST);
}
function resolveAuthAllowedHosts(input) {
	return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST);
}
function resolveAttachmentFetchPolicy(params) {
	return {
		allowHosts: resolveAllowedHosts(params?.allowHosts),
		authAllowHosts: resolveAuthAllowedHosts(params?.authAllowHosts)
	};
}
function isUrlAllowed(url, allowlist) {
	return isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist);
}
function applyAuthorizationHeaderForUrl(params) {
	if (!params.bearerToken) {
		params.headers.delete("Authorization");
		return;
	}
	if (isUrlAllowed(params.url, params.authAllowHosts)) {
		params.headers.set("Authorization", `Bearer ${params.bearerToken}`);
		return;
	}
	params.headers.delete("Authorization");
}
function resolveMediaSsrfPolicy(allowHosts) {
	return buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts);
}
/**
* Returns true if the given IPv4 or IPv6 address is in a private, loopback,
* or link-local range that must never be reached from media downloads.
*
* Delegates to the SDK's `isPrivateIpAddress` which handles IPv4-mapped IPv6,
* expanded notation, NAT64, 6to4, Teredo, octal IPv4, and fails closed on
* parse errors.
*/
const isPrivateOrReservedIP = isPrivateIpAddress;
/**
* Resolve a hostname via DNS and reject private/reserved IPs.
* Throws if the resolved IP is private or resolution fails.
*/
async function resolveAndValidateIP(hostname, resolveFn) {
	const resolve = resolveFn ?? lookup;
	let resolved;
	try {
		resolved = await resolve(hostname);
	} catch {
		throw new Error(`DNS resolution failed for "${hostname}"`);
	}
	if (isPrivateOrReservedIP(resolved.address)) throw new Error(`Hostname "${hostname}" resolves to private/reserved IP (${resolved.address})`);
	return resolved.address;
}
/** Maximum number of redirects to follow in safeFetch. */
const MAX_SAFE_REDIRECTS = 5;
/**
* Fetch a URL with redirect: "manual", validating each redirect target
* against the hostname allowlist and optional DNS-resolved IP (anti-SSRF).
*
* This prevents:
* - Auto-following redirects to non-allowlisted hosts
* - DNS rebinding attacks when a lookup function is provided
*/
async function safeFetch(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const resolveFn = params.resolveFn ?? lookup;
	const hasDispatcher = Boolean(params.requestInit && typeof params.requestInit === "object" && "dispatcher" in params.requestInit);
	const currentHeaders = new Headers(params.requestInit?.headers);
	let currentUrl = params.url;
	if (!isUrlAllowed(currentUrl, params.allowHosts)) throw new Error(`Initial download URL blocked: ${currentUrl}`);
	if (resolveFn) try {
		const initialHost = new URL(currentUrl).hostname;
		await resolveAndValidateIP(initialHost, resolveFn);
	} catch {
		throw new Error(`Initial download URL blocked: ${currentUrl}`);
	}
	for (let i = 0; i <= MAX_SAFE_REDIRECTS; i++) {
		const res = await fetchFn(currentUrl, {
			...params.requestInit,
			headers: currentHeaders,
			redirect: "manual"
		});
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(res.status)) return res;
		const location = res.headers.get("location");
		if (!location) return res;
		let redirectUrl;
		try {
			redirectUrl = new URL(location, currentUrl).toString();
		} catch {
			throw new Error(`Invalid redirect URL: ${location}`);
		}
		if (!isUrlAllowed(redirectUrl, params.allowHosts)) throw new Error(`Media redirect target blocked by allowlist: ${redirectUrl}`);
		if (currentHeaders.has("authorization") && params.authorizationAllowHosts && !isUrlAllowed(redirectUrl, params.authorizationAllowHosts)) currentHeaders.delete("authorization");
		if (hasDispatcher) return res;
		if (resolveFn) {
			const redirectHost = new URL(redirectUrl).hostname;
			await resolveAndValidateIP(redirectHost, resolveFn);
		}
		currentUrl = redirectUrl;
	}
	throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS})`);
}
async function safeFetchWithPolicy(params) {
	return await safeFetch({
		url: params.url,
		allowHosts: params.policy.allowHosts,
		authorizationAllowHosts: params.policy.authAllowHosts,
		fetchFn: params.fetchFn,
		requestInit: params.requestInit,
		resolveFn: params.resolveFn
	});
}
//#endregion
//#region extensions/msteams/src/errors.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatUnknownError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err === null) return "null";
	if (err === void 0) return "undefined";
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	if (typeof err === "symbol") return err.description ?? err.toString();
	if (typeof err === "function") return err.name ? `[function ${err.name}]` : "[function]";
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
function extractStatusCode(err) {
	if (!isRecord(err)) return null;
	const direct = err.statusCode ?? err.status;
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	if (typeof direct === "string") {
		const parsed = Number.parseInt(direct, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	const response = err.response;
	if (isRecord(response)) {
		const status = response.status;
		if (typeof status === "number" && Number.isFinite(status)) return status;
		if (typeof status === "string") {
			const parsed = Number.parseInt(status, 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}
function extractErrorCode(err) {
	if (!isRecord(err)) return null;
	const direct = err.code;
	if (typeof direct === "string" && direct.trim()) return direct;
	const response = err.response;
	if (!isRecord(response)) return null;
	const body = response.body;
	if (isRecord(body)) {
		const error = body.error;
		if (isRecord(error) && typeof error.code === "string" && error.code.trim()) return error.code;
	}
	return null;
}
function extractRetryAfterMs(err) {
	if (!isRecord(err)) return null;
	const direct = err.retryAfterMs ?? err.retry_after_ms;
	if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
	const retryAfter = err.retryAfter ?? err.retry_after;
	if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) return retryAfter >= 0 ? retryAfter * 1e3 : null;
	if (typeof retryAfter === "string") {
		const parsed = Number.parseFloat(retryAfter);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
	}
	const response = err.response;
	if (!isRecord(response)) return null;
	const headers = response.headers;
	if (!headers) return null;
	if (isRecord(headers)) {
		const raw = headers["retry-after"] ?? headers["Retry-After"];
		if (typeof raw === "string") {
			const parsed = Number.parseFloat(raw);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
		}
	}
	if (typeof headers === "object" && headers !== null && "get" in headers && typeof headers.get === "function") {
		const raw = headers.get("retry-after");
		if (raw) {
			const parsed = Number.parseFloat(raw);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
		}
	}
	return null;
}
/**
* Classify outbound send errors for safe retries and actionable logs.
*
* Important: We only mark errors as retryable when we have an explicit HTTP
* status code that indicates the message was not accepted (e.g. 429, 5xx).
* For transport-level errors where delivery is ambiguous, we prefer to avoid
* retries to reduce the chance of duplicate posts.
*/
function classifyMSTeamsSendError(err) {
	const statusCode = extractStatusCode(err);
	const retryAfterMs = extractRetryAfterMs(err);
	const errorCode = extractErrorCode(err) ?? void 0;
	if (statusCode === 401) return {
		kind: "auth",
		statusCode,
		errorCode
	};
	if (statusCode === 403) {
		if (errorCode === "ContentStreamNotAllowed") return {
			kind: "permanent",
			statusCode,
			errorCode
		};
		return {
			kind: "auth",
			statusCode,
			errorCode
		};
	}
	if (statusCode === 429) return {
		kind: "throttled",
		statusCode,
		retryAfterMs: retryAfterMs ?? void 0,
		errorCode
	};
	if (statusCode === 408 || statusCode != null && statusCode >= 500) return {
		kind: "transient",
		statusCode,
		retryAfterMs: retryAfterMs ?? void 0,
		errorCode
	};
	if (statusCode != null && statusCode >= 400) return {
		kind: "permanent",
		statusCode,
		errorCode
	};
	if (statusCode == null) {
		const networkCode = isRecord(err) && typeof err.code === "string" ? err.code : null;
		if (networkCode === "ECONNREFUSED" || networkCode === "ENOTFOUND" || networkCode === "EHOSTUNREACH" || networkCode === "ETIMEDOUT" || networkCode === "ECONNRESET") return {
			kind: "network",
			errorCode: networkCode
		};
	}
	return {
		kind: "unknown",
		statusCode: statusCode ?? void 0,
		retryAfterMs: retryAfterMs ?? void 0,
		errorCode
	};
}
/**
* Detect whether an error is caused by a revoked Proxy.
*
* The Bot Framework SDK wraps TurnContext in a Proxy that is revoked once the
* turn handler returns.  Any later access (e.g. from a debounced callback)
* throws a TypeError whose message contains the distinctive "proxy that has
* been revoked" string.
*/
function isRevokedProxyError(err) {
	if (!(err instanceof TypeError)) return false;
	return /proxy that has been revoked/i.test(err.message);
}
function formatMSTeamsSendErrorHint(classification) {
	if (classification.kind === "auth") return "check msteams appId/appPassword/tenantId (or env vars MSTEAMS_APP_ID/MSTEAMS_APP_PASSWORD/MSTEAMS_TENANT_ID)";
	if (classification.errorCode === "ContentStreamNotAllowed") return "Teams expired the content stream; stop streaming earlier and fall back to normal message delivery";
	if (classification.kind === "throttled") return "Teams throttled the bot; backing off may help";
	if (classification.kind === "transient") return "transient Teams/Bot Framework error; retry may succeed";
	if (classification.kind === "network") return "transport-level failure sending reply to Teams Bot Connector (smba.trafficmanager.net) — check egress firewall rules allow outbound HTTPS to smba.trafficmanager.net";
}
//#endregion
//#region extensions/msteams/src/user-agent.ts
let cachedUserAgent;
function resolveTeamsSdkVersion() {
	try {
		return createRequire(import.meta.url)("@microsoft/teams.apps/package.json").version ?? "unknown";
	} catch {
		return "unknown";
	}
}
function resolveOpenClawVersion() {
	try {
		return getMSTeamsRuntime().version;
	} catch {
		return "unknown";
	}
}
function buildUserAgent() {
	if (cachedUserAgent) return cachedUserAgent;
	cachedUserAgent = `teams.ts[apps]/${resolveTeamsSdkVersion()} OpenClaw/${resolveOpenClawVersion()}`;
	return cachedUserAgent;
}
function ensureUserAgentHeader(headers) {
	const nextHeaders = new Headers(headers);
	if (!nextHeaders.has("User-Agent")) nextHeaders.set("User-Agent", buildUserAgent());
	return nextHeaders;
}
//#endregion
//#region extensions/msteams/src/sdk.ts
const AZURE_IDENTITY_MODULE = "@azure/identity";
let azureIdentityModulePromise = null;
async function loadAzureIdentity() {
	azureIdentityModulePromise ??= import(AZURE_IDENTITY_MODULE);
	return azureIdentityModulePromise;
}
let msTeamsSdkPromise = null;
async function loadMSTeamsSdk() {
	msTeamsSdkPromise ??= Promise.all([import("./dist-vtDI3Kho.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1)), import("./dist-DDHqlodv.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1))]).then(([appsModule, apiModule]) => ({
		App: appsModule.App,
		Client: apiModule.Client
	}));
	return msTeamsSdkPromise;
}
/**
* Create a no-op HTTP server adapter that satisfies the Teams SDK's
* IHttpServerAdapter interface without spinning up an Express server.
*
* OpenClaw manages its own Express server for the Teams webhook endpoint, so
* the SDK's built-in HTTP server is unnecessary.  Passing this adapter via the
* `httpServerAdapter` option prevents the SDK from creating the default
* HttpPlugin (which uses the deprecated `plugins` array and registers an
* Express middleware with the pattern `/api*` — invalid in Express 5).
*
* See: https://github.com/openclaw/openclaw/issues/55161
* See: https://github.com/openclaw/openclaw/issues/60732
*/
function createNoOpHttpServerAdapter() {
	return { registerRoute() {} };
}
/**
* Create a Teams SDK App instance from credentials. The App manages token
* acquisition, JWT validation, and the HTTP server lifecycle.
*
* This replaces the previous CloudAdapter + MsalTokenProvider + authorizeJWT
* from @microsoft/agents-hosting.
*/
async function createMSTeamsApp(creds, sdk) {
	if (creds.type === "federated") return createFederatedApp(creds, sdk);
	return new sdk.App({
		clientId: creds.appId,
		clientSecret: creds.appPassword,
		tenantId: creds.tenantId,
		httpServerAdapter: createNoOpHttpServerAdapter()
	});
}
function createFederatedApp(creds, sdk) {
	if (creds.useManagedIdentity) return createManagedIdentityApp(creds, sdk);
	if (!creds.certificatePath) throw new Error("Federated credentials require either a certificate path or managed identity.");
	let privateKey;
	try {
		privateKey = fs$1.readFileSync(creds.certificatePath, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read certificate file at '${creds.certificatePath}': ${msg}`, { cause: err });
	}
	return createCertificateApp(creds, privateKey, sdk);
}
function createCertificateApp(creds, privateKey, sdk) {
	let credentialPromise = null;
	const getCredential = async () => {
		if (!credentialPromise) credentialPromise = loadAzureIdentity().then((az) => new az.ClientCertificateCredential(creds.tenantId, creds.appId, { certificate: privateKey }));
		return credentialPromise;
	};
	const tokenProvider = async (scope) => {
		const token = await (await getCredential()).getToken(scope);
		if (!token?.token) throw new Error("Failed to acquire token via certificate credential.");
		return token.token;
	};
	return new sdk.App({
		clientId: creds.appId,
		tenantId: creds.tenantId,
		token: tokenProvider,
		httpServerAdapter: createNoOpHttpServerAdapter()
	});
}
function createManagedIdentityApp(creds, sdk) {
	let credentialPromise = null;
	const getCredential = async () => {
		if (!credentialPromise) credentialPromise = loadAzureIdentity().then((az) => creds.managedIdentityClientId ? new az.ManagedIdentityCredential(creds.managedIdentityClientId) : new az.ManagedIdentityCredential());
		return credentialPromise;
	};
	const tokenProvider = async (scope) => {
		const token = await (await getCredential()).getToken(scope);
		if (!token?.token) throw new Error("Failed to acquire token via managed identity.");
		return token.token;
	};
	return new sdk.App({
		clientId: creds.appId,
		tenantId: creds.tenantId,
		token: tokenProvider,
		httpServerAdapter: createNoOpHttpServerAdapter()
	});
}
/**
* Build a token provider that uses the Teams SDK App for token acquisition.
*/
function createMSTeamsTokenProvider(app) {
	return { async getAccessToken(scope) {
		if (scope.includes("graph.microsoft.com")) {
			const token = await app.getAppGraphToken();
			return token ? String(token) : "";
		}
		const token = await app.getBotToken();
		return token ? String(token) : "";
	} };
}
function createBotTokenGetter(app) {
	return async () => {
		const token = await app.getBotToken();
		return token ? String(token) : void 0;
	};
}
function createApiClient(sdk, serviceUrl, getToken) {
	return new sdk.Client(serviceUrl, {
		token: async () => await getToken() || void 0,
		headers: { "User-Agent": buildUserAgent() }
	});
}
function normalizeOutboundActivity(textOrActivity) {
	return typeof textOrActivity === "string" ? {
		type: "message",
		text: textOrActivity
	} : textOrActivity;
}
function createSendContext(params) {
	const apiClient = params.serviceUrl && params.conversationId ? createApiClient(params.sdk, params.serviceUrl, params.getToken) : void 0;
	return {
		async sendActivity(textOrActivity) {
			const msg = normalizeOutboundActivity(textOrActivity);
			if (params.treatInvokeResponseAsNoop && msg.type === "invokeResponse") return { id: "invokeResponse" };
			if (!apiClient || !params.conversationId) return { id: "unknown" };
			const existingChannelData = msg.channelData && typeof msg.channelData === "object" ? msg.channelData : void 0;
			const channelData = params.tenantId ? {
				...existingChannelData,
				tenant: { id: params.tenantId }
			} : existingChannelData;
			return await apiClient.conversations.activities(params.conversationId).create({
				type: "message",
				...msg,
				...channelData ? { channelData } : {},
				from: params.bot?.id ? {
					id: params.bot.id,
					name: params.bot.name ?? "",
					role: "bot"
				} : void 0,
				conversation: {
					id: params.conversationId,
					conversationType: params.conversationType ?? "personal",
					...params.tenantId ? { tenantId: params.tenantId } : {}
				},
				...params.recipientId || params.recipientAadObjectId ? { recipient: {
					...params.recipientId ? { id: params.recipientId } : {},
					...params.recipientAadObjectId ? { aadObjectId: params.recipientAadObjectId } : {}
				} } : {},
				...params.replyToActivityId && !msg.replyToId ? { replyToId: params.replyToActivityId } : {}
			});
		},
		async updateActivity(activityUpdate) {
			const nextActivity = activityUpdate;
			const activityId = nextActivity.id;
			if (!activityId) throw new Error("updateActivity requires an activity id");
			if (!params.serviceUrl || !params.conversationId) return { id: "unknown" };
			return await updateActivityViaRest({
				serviceUrl: params.serviceUrl,
				conversationId: params.conversationId,
				activityId,
				activity: nextActivity,
				token: await params.getToken()
			});
		},
		async deleteActivity(activityId) {
			if (!activityId) throw new Error("deleteActivity requires an activity id");
			if (!params.serviceUrl || !params.conversationId) return;
			await deleteActivityViaRest({
				serviceUrl: params.serviceUrl,
				conversationId: params.conversationId,
				activityId,
				token: await params.getToken()
			});
		}
	};
}
function createProcessContext(params) {
	const serviceUrl = params.activity?.serviceUrl;
	const conversationId = (params.activity?.conversation)?.id;
	const conversationType = (params.activity?.conversation)?.conversationType;
	const replyToActivityId = params.activity?.id;
	const bot = params.activity?.recipient && typeof params.activity.recipient === "object" ? {
		id: params.activity.recipient.id,
		name: params.activity.recipient.name
	} : void 0;
	const sendContext = createSendContext({
		sdk: params.sdk,
		serviceUrl,
		conversationId,
		conversationType,
		bot,
		replyToActivityId,
		getToken: params.getToken,
		treatInvokeResponseAsNoop: true
	});
	return {
		activity: params.activity,
		...sendContext,
		async sendActivities(activities) {
			const results = [];
			for (const activity of activities) results.push(await sendContext.sendActivity(activity));
			return results;
		}
	};
}
/**
* Update an existing activity via the Bot Framework REST API.
* PUT /v3/conversations/{conversationId}/activities/{activityId}
*/
async function updateActivityViaRest(params) {
	const { serviceUrl, conversationId, activityId, activity, token } = params;
	const url = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;
	const headers = {
		"Content-Type": "application/json",
		"User-Agent": buildUserAgent()
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const currentFetch = globalThis.fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url,
		fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
		init: {
			method: "PUT",
			headers,
			body: JSON.stringify({
				type: "message",
				...activity,
				id: activityId
			})
		},
		auditContext: "msteams-update-activity"
	});
	try {
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw Object.assign(/* @__PURE__ */ new Error(`updateActivity failed: HTTP ${response.status} ${body}`), { statusCode: response.status });
		}
		return await response.json().catch(() => ({ id: activityId }));
	} finally {
		await release();
	}
}
/**
* Delete an existing activity via the Bot Framework REST API.
* DELETE /v3/conversations/{conversationId}/activities/{activityId}
*/
async function deleteActivityViaRest(params) {
	const { serviceUrl, conversationId, activityId, token } = params;
	const url = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;
	const headers = { "User-Agent": buildUserAgent() };
	if (token) headers.Authorization = `Bearer ${token}`;
	const currentFetch = globalThis.fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url,
		fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
		init: {
			method: "DELETE",
			headers
		},
		auditContext: "msteams-delete-activity"
	});
	try {
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw Object.assign(/* @__PURE__ */ new Error(`deleteActivity failed: HTTP ${response.status} ${body}`), { statusCode: response.status });
		}
	} finally {
		await release();
	}
}
/**
* Build a CloudAdapter-compatible adapter using the Teams SDK REST client.
*
* This replaces the previous CloudAdapter from @microsoft/agents-hosting.
* For incoming requests: the App's HTTP server handles JWT validation.
* For proactive sends: uses the Bot Framework REST API via
* @microsoft/teams.api Client.
*/
function createMSTeamsAdapter(app, sdk) {
	return {
		async continueConversation(_appId, reference, logic) {
			const serviceUrl = reference.serviceUrl;
			if (!serviceUrl) throw new Error("Missing serviceUrl in conversation reference");
			const conversationId = reference.conversation?.id;
			if (!conversationId) throw new Error("Missing conversation.id in conversation reference");
			const tenantId = reference.tenantId ?? reference.conversation?.tenantId;
			const recipientAadObjectId = reference.aadObjectId ?? reference.user?.aadObjectId;
			const recipientId = reference.user?.id;
			await logic(createSendContext({
				sdk,
				serviceUrl,
				conversationId,
				conversationType: reference.conversation?.conversationType,
				bot: reference.agent ?? void 0,
				getToken: createBotTokenGetter(app),
				tenantId,
				recipientId,
				recipientAadObjectId
			}));
		},
		async process(req, res, logic) {
			const request = req;
			const response = res;
			const activity = request.body;
			const isInvoke = activity?.type === "invoke";
			try {
				const context = createProcessContext({
					sdk,
					activity,
					getToken: createBotTokenGetter(app)
				});
				if (isInvoke) response.status(200).send();
				await logic(context);
				if (!isInvoke) response.status(200).send();
			} catch (err) {
				if (!isInvoke) response.status(500).send({ error: formatUnknownError(err) });
			}
		},
		async updateActivity(_context, _activity) {},
		async deleteActivity(_context, _reference) {}
	};
}
async function loadMSTeamsSdkWithAuth(creds) {
	const sdk = await loadMSTeamsSdk();
	return {
		sdk,
		app: await createMSTeamsApp(creds, sdk)
	};
}
/**
* Bot Framework issuer → JWKS mapping.
* During Microsoft's transition, inbound service tokens can be signed by either
* the legacy Bot Framework issuer or the Entra issuer. Each gets its own JWKS
* endpoint so we verify signatures with the correct key set.
*/
const BOT_FRAMEWORK_ISSUERS = [
	{
		issuer: "https://api.botframework.com",
		jwksUri: "https://login.botframework.com/v1/.well-known/keys"
	},
	{
		issuer: (tenantId) => `https://login.microsoftonline.com/${tenantId}/v2.0`,
		jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys"
	},
	{
		issuer: (tenantId) => `https://sts.windows.net/${tenantId}/`,
		jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys"
	}
];
const BOT_FRAMEWORK_GLOBAL_AUDIENCE = "https://api.botframework.com";
function isJwtPayloadObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function getAudienceClaims(payload) {
	if (!isJwtPayloadObject(payload)) return [];
	const audience = payload.aud;
	if (typeof audience === "string") {
		const trimmed = audience.trim();
		return trimmed ? [trimmed] : [];
	}
	if (Array.isArray(audience)) return audience.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
	return [];
}
function normalizeBotIdentityClaim(value) {
	if (typeof value !== "string") return null;
	return value.trim().toLowerCase() || null;
}
function hasExpectedBotIdentity(payload, expectedAppId) {
	if (!isJwtPayloadObject(payload)) return false;
	const expected = normalizeBotIdentityClaim(expectedAppId);
	if (!expected) return false;
	return normalizeBotIdentityClaim(payload.appid) === expected || normalizeBotIdentityClaim(payload.azp) === expected;
}
let botFrameworkJwtDepsPromise = null;
function hasDefaultExport(value) {
	return !!value && typeof value === "object" && "default" in value;
}
function isJsonwebtokenRuntime(value) {
	return !!value && typeof value === "object" && typeof value.decode === "function" && typeof value.verify === "function";
}
function loadJsonwebtokenRuntime(jwtModule) {
	const jwt = hasDefaultExport(jwtModule) ? jwtModule.default ?? jwtModule : jwtModule;
	if (!isJsonwebtokenRuntime(jwt)) throw new Error("jsonwebtoken did not export decode/verify");
	return jwt;
}
function isJwksClientRuntime(value) {
	return typeof value === "function";
}
function loadJwksClientRuntime(jwksModule) {
	const direct = jwksModule && typeof jwksModule === "object" ? jwksModule.JwksClient : void 0;
	const fallback = hasDefaultExport(jwksModule) && jwksModule.default && typeof jwksModule.default === "object" ? jwksModule.default.JwksClient : void 0;
	const JwksClient = direct ?? fallback;
	if (!isJwksClientRuntime(JwksClient)) throw new Error("jwks-rsa did not export JwksClient");
	return JwksClient;
}
async function loadBotFrameworkJwtDeps() {
	botFrameworkJwtDepsPromise ??= Promise.all([import("./jsonwebtoken-Biq5rPPj.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1)), import("./src-BWvrN9BA.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1))]).then(([jwtModule, jwksModule]) => {
		return {
			jwt: loadJsonwebtokenRuntime(jwtModule),
			JwksClient: loadJwksClientRuntime(jwksModule)
		};
	});
	return botFrameworkJwtDepsPromise;
}
/**
* Create a Bot Framework JWT validator using jsonwebtoken + jwks-rsa directly.
*
* The @microsoft/teams.apps JwtValidator hardcodes audience to [clientId, api://clientId],
* which rejects valid Bot Framework tokens that carry aud: "https://api.botframework.com".
* This implementation uses jsonwebtoken directly with the correct audience list, matching
* the behavior of the legacy @microsoft/agents-hosting authorizeJWT middleware.
*
* Security invariants:
* - signature verification via issuer-specific JWKS endpoints
* - audience validation: appId, api://appId, and https://api.botframework.com
* - issuer validation: strict allowlist (Bot Framework + tenant-scoped Entra)
* - expiration validation with 5-minute clock tolerance
*/
async function createBotFrameworkJwtValidator(creds) {
	const { jwt, JwksClient } = await loadBotFrameworkJwtDeps();
	const allowedAudiences = [
		creds.appId,
		`api://${creds.appId}`,
		BOT_FRAMEWORK_GLOBAL_AUDIENCE
	];
	const allowedIssuers = BOT_FRAMEWORK_ISSUERS.map((entry) => typeof entry.issuer === "function" ? entry.issuer(creds.tenantId) : entry.issuer);
	const jwksClients = /* @__PURE__ */ new Map();
	function getJwksClient(uri) {
		let client = jwksClients.get(uri);
		if (!client) {
			client = new JwksClient({
				jwksUri: uri,
				cache: true,
				cacheMaxAge: 6e5,
				rateLimit: true
			});
			jwksClients.set(uri, client);
		}
		return client;
	}
	/** Decode the token header without verification to determine the kid. */
	function decodeHeader(token) {
		const decoded = jwt.decode(token, { complete: true });
		return decoded && typeof decoded === "object" ? decoded.header : null;
	}
	/** Resolve the issuer entry for a token's issuer claim (pre-verification). */
	function resolveIssuerEntry(issuerClaim) {
		if (!issuerClaim) return;
		return BOT_FRAMEWORK_ISSUERS.find((entry) => {
			return (typeof entry.issuer === "function" ? entry.issuer(creds.tenantId) : entry.issuer) === issuerClaim;
		});
	}
	return { async validate(authHeader, _serviceUrl) {
		const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
		if (!token) return false;
		const header = decodeHeader(token);
		const unverifiedPayload = jwt.decode(token);
		if (!header?.kid || !isJwtPayloadObject(unverifiedPayload) || typeof unverifiedPayload.iss !== "string") return false;
		const issuerEntry = resolveIssuerEntry(unverifiedPayload.iss);
		if (!issuerEntry) return false;
		const client = getJwksClient(issuerEntry.jwksUri);
		try {
			const publicKey = (await client.getSigningKey(header.kid)).getPublicKey();
			const verifiedPayload = jwt.verify(token, publicKey, {
				audience: allowedAudiences,
				issuer: allowedIssuers,
				algorithms: ["RS256"],
				clockTolerance: 300
			});
			if (!isJwtPayloadObject(verifiedPayload)) return false;
			if (getAudienceClaims(verifiedPayload).includes(BOT_FRAMEWORK_GLOBAL_AUDIENCE) && !hasExpectedBotIdentity(verifiedPayload, creds.appId)) return false;
			return true;
		} catch (err) {
			if (isJwksNetworkError(err)) throw err;
			return false;
		}
	} };
}
/**
* Return true when the error originated from a network-level failure fetching
* the JWKS endpoint (DNS resolution, connection refused, TLS handshake, etc.)
* rather than from token verification logic.
*/
function isJwksNetworkError(err) {
	if (!(err instanceof Error)) return false;
	const code = err.code;
	if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT" || code === "ECONNRESET") return true;
	return /jwks|key fetch|getSigningKey/i.test(err.message) && /network|fetch|connect/i.test(err.message);
}
//#endregion
//#region extensions/msteams/src/token-response.ts
function readAccessToken(value) {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const token = value.accessToken ?? value.token;
		return typeof token === "string" ? token : null;
	}
	return null;
}
//#endregion
//#region extensions/msteams/src/storage.ts
function resolveMSTeamsStorePath(params) {
	if (params.storePath) return params.storePath;
	if (params.stateDir) return path.join(params.stateDir, params.filename);
	const env = params.env ?? process.env;
	const stateDir = params.homedir ? getMSTeamsRuntime().state.resolveStateDir(env, params.homedir) : getMSTeamsRuntime().state.resolveStateDir(env);
	return path.join(stateDir, params.filename);
}
//#endregion
//#region extensions/msteams/src/token.ts
function resolveAuthType(cfg) {
	const fromCfg = cfg?.authType;
	if (fromCfg === "secret" || fromCfg === "federated") return fromCfg;
	if (process.env.MSTEAMS_AUTH_TYPE === "federated") return "federated";
	return "secret";
}
function hasConfiguredMSTeamsCredentials(cfg) {
	const authType = resolveAuthType(cfg);
	const hasAppId = Boolean(normalizeSecretInputString(cfg?.appId) || normalizeSecretInputString(process.env.MSTEAMS_APP_ID));
	const hasTenantId = Boolean(normalizeSecretInputString(cfg?.tenantId) || normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID));
	if (authType === "federated") {
		const hasCert = Boolean(cfg?.certificatePath || process.env.MSTEAMS_CERTIFICATE_PATH);
		const hasManagedIdentity = cfg?.useManagedIdentity ?? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true";
		return hasAppId && hasTenantId && (hasCert || hasManagedIdentity);
	}
	return Boolean(normalizeSecretInputString(cfg?.appId) && hasConfiguredSecretInput(cfg?.appPassword) && normalizeSecretInputString(cfg?.tenantId));
}
function resolveMSTeamsCredentials(cfg) {
	const authType = resolveAuthType(cfg);
	const appId = normalizeSecretInputString(cfg?.appId) || normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
	const tenantId = normalizeSecretInputString(cfg?.tenantId) || normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);
	if (!appId || !tenantId) return;
	if (authType === "federated") {
		const certificatePath = cfg?.certificatePath || process.env.MSTEAMS_CERTIFICATE_PATH || void 0;
		const certificateThumbprint = cfg?.certificateThumbprint || process.env.MSTEAMS_CERTIFICATE_THUMBPRINT || void 0;
		const useManagedIdentity = cfg?.useManagedIdentity ?? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true";
		const managedIdentityClientId = cfg?.managedIdentityClientId || process.env.MSTEAMS_MANAGED_IDENTITY_CLIENT_ID || void 0;
		if (!certificatePath && !useManagedIdentity) return;
		return {
			type: "federated",
			appId,
			tenantId,
			certificatePath,
			certificateThumbprint,
			useManagedIdentity: useManagedIdentity || void 0,
			managedIdentityClientId
		};
	}
	const appPassword = normalizeResolvedSecretInputString({
		value: cfg?.appPassword,
		path: "channels.msteams.appPassword"
	}) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
	if (!appPassword) return;
	return {
		type: "secret",
		appId,
		appPassword,
		tenantId
	};
}
const DELEGATED_TOKEN_FILENAME = "msteams-delegated.json";
function resolveDelegatedTokenPath() {
	return resolveMSTeamsStorePath({ filename: DELEGATED_TOKEN_FILENAME });
}
function loadDelegatedTokens() {
	try {
		const content = readFileSync(resolveDelegatedTokenPath(), "utf8");
		return JSON.parse(content);
	} catch {
		return;
	}
}
function saveDelegatedTokens(tokens) {
	const tokenPath = resolveDelegatedTokenPath();
	privateFileStoreSync(dirname(tokenPath)).writeJson(basename(tokenPath), tokens);
}
async function resolveDelegatedAccessToken(params) {
	const tokens = loadDelegatedTokens();
	if (!tokens) return;
	if (tokens.expiresAt > Date.now()) return tokens.accessToken;
	try {
		const refreshed = await refreshMSTeamsDelegatedTokens({
			tenantId: params.tenantId,
			clientId: params.clientId,
			clientSecret: params.clientSecret,
			refreshToken: tokens.refreshToken,
			scopes: tokens.scopes
		});
		saveDelegatedTokens(refreshed);
		return refreshed.accessToken;
	} catch {
		return;
	}
}
//#endregion
//#region extensions/msteams/src/graph.ts
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const NULL_BODY_STATUSES = new Set([
	101,
	204,
	205,
	304
]);
function normalizeQuery(value) {
	return value?.trim() ?? "";
}
function escapeOData(value) {
	return value.replace(/'/g, "''");
}
async function requestGraph(params) {
	const hasBody = params.body !== void 0;
	const url = `${params.root ?? "https://graph.microsoft.com/v1.0"}${params.path}`;
	const currentFetch = globalThis.fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url,
		fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
		init: {
			method: params.method,
			headers: {
				"User-Agent": buildUserAgent(),
				Authorization: `Bearer ${params.token}`,
				...hasBody ? { "Content-Type": "application/json" } : {},
				...params.headers
			},
			body: hasBody ? JSON.stringify(params.body) : void 0
		},
		auditContext: "msteams.graph"
	});
	try {
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`${params.errorPrefix ?? "Graph"} ${params.path} failed (${response.status}): ${text || "unknown error"}`);
		}
		const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers)
		});
	} finally {
		await release();
	}
}
async function readOptionalGraphJson(res, label) {
	if (res.status === 204 || res.headers?.get?.("content-length") === "0") return;
	return await readProviderJsonResponse(res, label);
}
async function fetchGraphJson(params) {
	return await readOptionalGraphJson(await requestGraph({
		token: params.token,
		path: params.path,
		method: params.method,
		body: params.body,
		headers: params.headers
	}), `Graph ${params.path} failed`);
}
/**
* Fetch JSON from an absolute Graph API URL (for example @odata.nextLink
* pagination URLs) without prepending GRAPH_ROOT.
*/
async function fetchGraphAbsoluteUrl(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		init: { headers: {
			"User-Agent": buildUserAgent(),
			Authorization: `Bearer ${params.token}`,
			...params.headers
		} },
		auditContext: "msteams.graph.absolute"
	});
	try {
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Graph ${params.url} failed (${response.status}): ${text || "unknown error"}`);
		}
		return await readProviderJsonResponse(response, `Graph ${params.url} failed`);
	} finally {
		await release();
	}
}
/**
* Fetch all pages of a Graph API collection, following @odata.nextLink.
* Optionally stop early when `findOne` matches an item.
*/
async function fetchAllGraphPages(params) {
	const maxPages = params.maxPages ?? 50;
	const items = [];
	let nextPath = params.path;
	for (let page = 0; page < maxPages && nextPath; page++) {
		const res = await fetchGraphJson({
			token: params.token,
			path: nextPath,
			headers: params.headers
		});
		const pageItems = res.value ?? [];
		if (params.findOne) {
			const match = pageItems.find(params.findOne);
			if (match) {
				items.push(...pageItems);
				return {
					items,
					truncated: false,
					found: match
				};
			}
		}
		items.push(...pageItems);
		const rawNext = res["@odata.nextLink"];
		if (rawNext) nextPath = rawNext.replace("https://graph.microsoft.com/v1.0", "").replace("https://graph.microsoft.com/beta", "");
		else nextPath = void 0;
	}
	return {
		items,
		truncated: Boolean(nextPath)
	};
}
async function resolveGraphToken(cfg, options) {
	const msteamsCfg = cfg?.channels?.msteams;
	const creds = resolveMSTeamsCredentials(msteamsCfg);
	if (!creds) throw new Error("MS Teams credentials missing");
	if (options?.preferDelegated && msteamsCfg?.delegatedAuth?.enabled && creds.type === "secret") {
		const delegated = await resolveDelegatedAccessToken({
			tenantId: creds.tenantId,
			clientId: creds.appId,
			clientSecret: creds.appPassword
		});
		if (delegated) return delegated;
	}
	const { app } = await loadMSTeamsSdkWithAuth(creds);
	const accessToken = readAccessToken(await createMSTeamsTokenProvider(app).getAccessToken("https://graph.microsoft.com"));
	if (!accessToken) throw new Error("MS Teams graph token unavailable");
	return accessToken;
}
async function listTeamsByName(token, query) {
	const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escapeOData(query)}')`;
	const { items } = await fetchAllGraphPages({
		token,
		path: `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`,
		maxPages: 5
	});
	return items;
}
async function postGraphJson(params) {
	return readOptionalGraphJson(await requestGraph({
		token: params.token,
		path: params.path,
		method: "POST",
		body: params.body,
		errorPrefix: "Graph POST"
	}), `Graph POST ${params.path} failed`);
}
async function postGraphBetaJson(params) {
	return readOptionalGraphJson(await requestGraph({
		token: params.token,
		path: params.path,
		method: "POST",
		root: GRAPH_BETA,
		body: params.body,
		errorPrefix: "Graph beta POST"
	}), `Graph beta POST ${params.path} failed`);
}
async function deleteGraphRequest(params) {
	await requestGraph({
		token: params.token,
		path: params.path,
		method: "DELETE",
		errorPrefix: "Graph DELETE"
	});
}
async function patchGraphJson(params) {
	return readOptionalGraphJson(await requestGraph({
		token: params.token,
		path: params.path,
		method: "PATCH",
		body: params.body,
		errorPrefix: "Graph PATCH"
	}), `Graph PATCH ${params.path} failed`);
}
async function listChannelsForTeam(token, teamId) {
	const { items } = await fetchAllGraphPages({
		token,
		path: `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`,
		maxPages: 10
	});
	return items;
}
//#endregion
//#region extensions/msteams/src/graph-users.ts
async function searchGraphUsers(params) {
	const query = params.query.trim();
	if (!query) return [];
	if (query.includes("@")) {
		const escaped = escapeOData(query);
		const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
		const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
		return (await fetchGraphJson({
			token: params.token,
			path
		})).value ?? [];
	}
	const top = typeof params.top === "number" && params.top > 0 ? params.top : 10;
	const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=${top}`;
	return (await fetchGraphJson({
		token: params.token,
		path,
		headers: { ConsistencyLevel: "eventual" }
	})).value ?? [];
}
//#endregion
export { GRAPH_ROOT as A, isUrlAllowed as B, buildUserAgent as C, formatUnknownError as D, formatMSTeamsSendErrorHint as E, extractHtmlFromAttachment as F, resolveRequestUrl as G, readNestedString as H, extractInlineImageCandidates as I, tryBuildGraphSharesUrlForSharedLink as J, safeFetchWithPolicy as K, inferPlaceholder as L, applyAuthorizationHeaderForUrl as M, encodeGraphShareId as N, isRevokedProxyError as O, estimateBase64DecodedBytes as P, isDownloadableAttachment as R, loadMSTeamsSdkWithAuth as S, classifyMSTeamsSendError as T, resolveAttachmentFetchPolicy as U, normalizeContentType as V, resolveMediaSsrfPolicy as W, resolveMSTeamsStorePath as _, fetchGraphJson as a, createMSTeamsAdapter as b, normalizeQuery as c, postGraphJson as d, resolveGraphToken as f, saveDelegatedTokens as g, resolveMSTeamsCredentials as h, fetchGraphAbsoluteUrl as i, IMG_SRC_RE as j, ATTACHMENT_TAG_RE as k, patchGraphJson as l, loadDelegatedTokens as m, deleteGraphRequest as n, listChannelsForTeam as o, hasConfiguredMSTeamsCredentials as p, safeHostForUrl as q, escapeOData as r, listTeamsByName as s, searchGraphUsers as t, postGraphBetaJson as u, readAccessToken as v, ensureUserAgentHeader as w, createMSTeamsTokenProvider as x, createBotFrameworkJwtValidator as y, isLikelyImageAttachment as z };
