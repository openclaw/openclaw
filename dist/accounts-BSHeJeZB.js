import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { d as normalizeSecretInputString, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { Et as array, Nn as record, Rn as string, Tn as object, Zn as unknown, wn as number } from "./schemas-Del5uzR8.js";
import { C as resolveChannelStreamingChunkMode, S as resolveChannelStreamingBlockEnabled, m as resolveChannelPreviewStreamMode, x as resolveChannelStreamingBlockCoalesce } from "./channel-streaming-BKIuGSWW.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, i as hasConfiguredAccountValue, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./secret-input-CWnTb0tw.js";
import { d as ssrfPolicyFromPrivateNetworkOptIn } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/mattermost/src/mattermost/client.ts
const MattermostPostSchema = object({
	id: string(),
	user_id: string().nullable().optional(),
	channel_id: string().nullable().optional(),
	message: string().nullable().optional(),
	file_ids: array(string()).nullable().optional(),
	type: string().nullable().optional(),
	root_id: string().nullable().optional(),
	create_at: number().nullable().optional(),
	props: record(string(), unknown()).nullable().optional()
}).passthrough();
function normalizeMattermostBaseUrl(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	return trimmed.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
}
function buildMattermostApiUrl(baseUrl, path) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) throw new Error("Mattermost baseUrl is required");
	return `${normalized}/api/v4${path.startsWith("/") ? path : `/${path}`}`;
}
async function readMattermostError(res) {
	if ((res.headers.get("content-type") ?? "").includes("application/json")) {
		const data = await res.json();
		if (data?.message) return data.message;
		return JSON.stringify(data);
	}
	return await res.text();
}
function createMattermostClient(params) {
	const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
	if (!baseUrl) throw new Error("Mattermost baseUrl is required");
	const apiBaseUrl = `${baseUrl}/api/v4`;
	const token = params.botToken.trim();
	const externalFetchImpl = params.fetchImpl;
	const NULL_BODY_STATUSES = new Set([
		101,
		204,
		205,
		304
	]);
	const guardedFetchImpl = async (input, init) => {
		const { response, release } = await fetchWithSsrFGuard({
			url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			init,
			auditContext: "mattermost-api",
			policy: ssrfPolicyFromPrivateNetworkOptIn(params.allowPrivateNetwork)
		});
		try {
			const bodyBytes = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
			return new Response(bodyBytes, {
				status: response.status,
				headers: response.headers
			});
		} finally {
			await release();
		}
	};
	const fetchImpl = externalFetchImpl ?? guardedFetchImpl;
	const request = async (path, init) => {
		const url = buildMattermostApiUrl(baseUrl, path);
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
		const res = await fetchImpl(url, {
			...init,
			headers
		});
		if (!res.ok) {
			const detail = await readMattermostError(res);
			throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
		}
		if (res.status === 204) return;
		if ((res.headers.get("content-type") ?? "").includes("application/json")) return await res.json();
		return await res.text();
	};
	return {
		baseUrl,
		apiBaseUrl,
		token,
		request,
		fetchImpl
	};
}
async function fetchMattermostMe(client) {
	return await client.request("/users/me");
}
async function fetchMattermostUser(client, userId) {
	return await client.request(`/users/${userId}`);
}
async function fetchMattermostUserByUsername(client, username) {
	return await client.request(`/users/username/${encodeURIComponent(username)}`);
}
async function fetchMattermostChannel(client, channelId) {
	return await client.request(`/channels/${channelId}`);
}
async function fetchMattermostChannelByName(client, teamId, channelName) {
	return await client.request(`/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`);
}
async function sendMattermostTyping(client, params) {
	const payload = { channel_id: params.channelId };
	const parentId = params.parentId?.trim();
	if (parentId) payload.parent_id = parentId;
	await client.request("/users/me/typing", {
		method: "POST",
		body: JSON.stringify(payload)
	});
}
async function createMattermostDirectChannel(client, userIds, signal) {
	return await client.request("/channels/direct", {
		method: "POST",
		body: JSON.stringify(userIds),
		signal
	});
}
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_DNS_RESOLVE_FAILED",
	"UND_ERR_CONNECT",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT"
]);
const RETRYABLE_NETWORK_ERROR_NAMES = new Set([
	"AbortError",
	"TimeoutError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError"
]);
const RETRYABLE_NETWORK_MESSAGE_SNIPPETS = [
	"network error",
	"timeout",
	"timed out",
	"abort",
	"connection refused",
	"econnreset",
	"econnrefused",
	"etimedout",
	"enotfound",
	"socket hang up",
	"getaddrinfo"
];
/**
* Creates a Mattermost DM channel with exponential backoff retry logic.
* Retries on transient errors (429, 5xx, network errors) but not on
* client errors (4xx except 429) or permanent failures.
*/
async function createMattermostDirectChannelWithRetry(client, userIds, options = {}) {
	const { maxRetries = 3, initialDelayMs = 1e3, maxDelayMs = 1e4, timeoutMs = 3e4, onRetry } = options;
	let lastError;
	for (let attempt = 0; attempt <= maxRetries; attempt++) try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await createMattermostDirectChannel(client, userIds, controller.signal);
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (err) {
		lastError = err instanceof Error ? err : new Error(String(err));
		if (attempt >= maxRetries) break;
		if (!isRetryableError(lastError)) throw lastError;
		const exponentialDelay = initialDelayMs * 2 ** attempt;
		const jitter = Math.random() * exponentialDelay;
		const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs);
		if (onRetry) onRetry(attempt + 1, delayMs, lastError);
		await sleep(delayMs);
	}
	throw lastError ?? /* @__PURE__ */ new Error("Failed to create DM channel after retries");
}
function isRetryableError(error) {
	const candidates = collectErrorCandidates(error);
	const messages = candidates.map((candidate) => normalizeLowercaseStringOrEmpty(readErrorMessage(candidate))).filter((message) => Boolean(message));
	if (messages.some((message) => /mattermost api 5\d{2}\b/.test(message))) return true;
	if (messages.some((message) => /mattermost api 429\b/.test(message) || message.includes("too many requests"))) return true;
	for (const message of messages) {
		const clientErrorMatch = message.match(/mattermost api (4\d{2})\b/);
		if (!clientErrorMatch) continue;
		const statusCode = Number.parseInt(clientErrorMatch[1], 10);
		if (statusCode >= 400 && statusCode < 500) return false;
	}
	if (messages.some((message) => /mattermost api \d{3}\b/.test(message))) return false;
	const codes = [];
	for (const candidate of candidates) {
		const code = readErrorCode(candidate);
		if (code) codes.push(code);
	}
	if (codes.some((code) => RETRYABLE_NETWORK_ERROR_CODES.has(code))) return true;
	const names = [];
	for (const candidate of candidates) {
		const name = readErrorName(candidate);
		if (name) names.push(name);
	}
	if (names.some((name) => RETRYABLE_NETWORK_ERROR_NAMES.has(name))) return true;
	return messages.some((message) => RETRYABLE_NETWORK_MESSAGE_SNIPPETS.some((pattern) => message.includes(pattern)));
}
function collectErrorCandidates(error) {
	const queue = [error];
	let queueIndex = 0;
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	while (queueIndex < queue.length) {
		const current = queue[queueIndex];
		queueIndex += 1;
		if (!current || seen.has(current)) continue;
		seen.add(current);
		candidates.push(current);
		if (typeof current !== "object") continue;
		const nested = current;
		queue.push(nested.cause, nested.reason);
		if (Array.isArray(nested.errors)) queue.push(...nested.errors);
	}
	return candidates;
}
function readErrorMessage(error) {
	if (!error || typeof error !== "object") return;
	const message = error.message;
	return typeof message === "string" && message.trim() ? message : void 0;
}
function readErrorName(error) {
	if (!error || typeof error !== "object") return;
	const name = error.name;
	return typeof name === "string" && name.trim() ? name : void 0;
}
function readErrorCode(error) {
	if (!error || typeof error !== "object") return;
	const { code, errno } = error;
	const raw = typeof code === "string" && code.trim() ? code : errno;
	if (typeof raw === "string" && raw.trim()) return raw.trim().toUpperCase();
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
}
async function createMattermostPost(client, params) {
	const payload = {
		channel_id: params.channelId,
		message: params.message
	};
	if (params.rootId) payload.root_id = params.rootId;
	if (params.fileIds?.length) payload.file_ids = params.fileIds;
	if (params.props) payload.props = params.props;
	return await client.request("/posts", {
		method: "POST",
		body: JSON.stringify(payload)
	});
}
async function fetchMattermostUserTeams(client, userId) {
	return await client.request(`/users/${userId}/teams`);
}
async function updateMattermostPost(client, postId, params) {
	const payload = { id: postId };
	if (params.message !== void 0) payload.message = params.message;
	if (params.props !== void 0) payload.props = params.props;
	return await client.request(`/posts/${postId}`, {
		method: "PUT",
		body: JSON.stringify(payload)
	});
}
async function deleteMattermostPost(client, postId) {
	await client.request(`/posts/${postId}`, { method: "DELETE" });
}
async function uploadMattermostFile(client, params) {
	const form = new FormData();
	const fileName = normalizeOptionalString(params.fileName) ?? "upload";
	const bytes = Uint8Array.from(params.buffer);
	const blob = params.contentType ? new Blob([bytes], { type: params.contentType }) : new Blob([bytes]);
	form.append("files", blob, fileName);
	form.append("channel_id", params.channelId);
	const res = await client.fetchImpl(`${client.apiBaseUrl}/files`, {
		method: "POST",
		headers: { Authorization: `Bearer ${client.token}` },
		body: form
	});
	if (!res.ok) {
		const detail = await readMattermostError(res);
		throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
	}
	const info = (await res.json()).file_infos?.[0];
	if (!info?.id) throw new Error("Mattermost file upload failed");
	return info;
}
//#endregion
//#region extensions/mattermost/src/mattermost/accounts.ts
const mattermostAccountHelpers = createAccountListHelpers("mattermost", { hasImplicitDefaultAccount: (cfg) => {
	const mattermost = cfg.channels?.mattermost;
	return Boolean(mattermost?.baseUrl?.trim() && (hasConfiguredAccountValue(mattermost.botToken) || process.env.MATTERMOST_BOT_TOKEN?.trim()));
} });
function listMattermostAccountIds(cfg) {
	return mattermostAccountHelpers.listAccountIds(cfg);
}
function resolveDefaultMattermostAccountId(cfg) {
	return mattermostAccountHelpers.resolveDefaultAccountId(cfg);
}
function mergeMattermostAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.mattermost,
		accounts: cfg.channels?.mattermost?.accounts,
		accountId,
		omitKeys: ["defaultAccount"],
		nestedObjectKeys: ["commands"]
	});
}
function resolveMattermostRequireMention(config) {
	if (config.chatmode === "oncall") return true;
	if (config.chatmode === "onmessage") return false;
	if (config.chatmode === "onchar") return true;
	return config.requireMention;
}
function resolveMattermostAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultMattermostAccountId(params.cfg));
	const baseEnabled = params.cfg.channels?.mattermost?.enabled !== false;
	const merged = mergeMattermostAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
	const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() : void 0;
	const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() : void 0;
	const configToken = params.allowUnresolvedSecretRef ? normalizeSecretInputString(merged.botToken) : normalizeResolvedSecretInputString({
		value: merged.botToken,
		path: `channels.mattermost.accounts.${accountId}.botToken`
	});
	const configUrl = merged.baseUrl?.trim();
	const botToken = configToken || envToken;
	const baseUrl = normalizeMattermostBaseUrl(configUrl || envUrl);
	const requireMention = resolveMattermostRequireMention(merged);
	const botTokenSource = configToken ? "config" : envToken ? "env" : "none";
	const baseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";
	return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		botToken,
		baseUrl,
		botTokenSource,
		baseUrlSource,
		config: merged,
		chatmode: merged.chatmode,
		oncharPrefixes: merged.oncharPrefixes,
		requireMention,
		textChunkLimit: merged.textChunkLimit,
		chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode,
		streamingMode: resolveChannelPreviewStreamMode(merged, "partial"),
		blockStreaming: resolveChannelStreamingBlockEnabled(merged) ?? merged.blockStreaming,
		blockStreamingCoalesce: resolveChannelStreamingBlockCoalesce(merged) ?? merged.blockStreamingCoalesce
	};
}
/**
* Resolve the effective replyToMode for a given chat type.
* Mattermost auto-threading only applies to channel and group messages.
*/
function resolveMattermostReplyToMode(account, kind) {
	if (kind === "direct") return "off";
	return account.config.replyToMode ?? "off";
}
//#endregion
export { readMattermostError as _, MattermostPostSchema as a, uploadMattermostFile as b, createMattermostPost as c, fetchMattermostChannelByName as d, fetchMattermostMe as f, normalizeMattermostBaseUrl as g, fetchMattermostUserTeams as h, resolveMattermostReplyToMode as i, deleteMattermostPost as l, fetchMattermostUserByUsername as m, resolveDefaultMattermostAccountId as n, createMattermostClient as o, fetchMattermostUser as p, resolveMattermostAccount as r, createMattermostDirectChannelWithRetry as s, listMattermostAccountIds as t, fetchMattermostChannel as u, sendMattermostTyping as v, updateMattermostPost as y };
