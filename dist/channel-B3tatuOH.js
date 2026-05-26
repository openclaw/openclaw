import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { At as boolean, Et as array, Rn as string, Tn as object, Zn as unknown, wn as number } from "./schemas-Del5uzR8.js";
import { n as safeParseWithSchema, t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { _ as resolvePinnedHostnameWithPolicy } from "./ssrf-DdDeGa5L.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { i as createHybridChannelConfigAdapter, l as createScopedDmSecurityResolver } from "./channel-config-helpers-xZ4-bv2H.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as createChatChannelPlugin } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import "./routing-79DRZvfm.js";
import { a as waitUntilAbort } from "./channel-lifecycle.core-CDt0hRZR.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-config-schema-BBVXL5oD.js";
import { T as projectAccountWarningCollector, b as createConditionalWarningCollector, h as composeWarningCollectors, w as projectAccountConfigWarningCollector } from "./channel-policy-pv8ZpZxj.js";
import { n as createEmptyChannelDirectoryAdapter } from "./directory-runtime-wFQhDUBI.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-dxinAe5Y.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "./http-body-BfDL157U.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { t as registerPluginHttpRoute } from "./http-registry-Dt8GAiji.js";
import "./security-runtime-CcSekjBd.js";
import "./account-resolution-Dy8RKAMt.js";
import "./extension-shared-DSIp8QS_.js";
import "./channel-lifecycle-B7VOl7bW.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { a as createFixedWindowRateLimiter } from "./webhook-ingress-R0qMwT4u.js";
import { a as createWebhookInFlightLimiter, i as beginWebhookRequestPipelineOrReject } from "./webhook-request-guards-iMi786D5.js";
import { i as resolveAccount, n as synologyChatSetupWizard, r as listAccountIds, t as synologyChatSetupAdapter } from "./setup-surface-ifGsunE7.js";
import { t as collectSynologyChatSecurityAuditFindings } from "./security-audit-DIsaxIaB.js";
import * as http$1 from "node:http";
import * as https$1 from "node:https";
import * as querystring from "node:querystring";
//#region extensions/synology-chat/src/approval-auth.ts
function normalizeSynologyChatApproverId(value) {
	const trimmed = String(value).trim();
	return /^\d+$/.test(trimmed) ? trimmed : void 0;
}
const synologyChatApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Synology Chat",
	resolveApprovers: ({ cfg, accountId }) => {
		return resolveApprovalApprovers({
			allowFrom: resolveAccount(cfg ?? {}, accountId).allowedUserIds,
			normalizeApprover: normalizeSynologyChatApproverId
		});
	},
	normalizeSenderId: (value) => normalizeSynologyChatApproverId(value)
});
//#endregion
//#region extensions/synology-chat/src/client.ts
/**
* Synology Chat HTTP client.
* Sends messages TO Synology Chat via the incoming webhook URL.
*/
const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;
const ChatUserSchema = object({
	user_id: number(),
	username: string().optional(),
	nickname: string().optional()
}).transform((user) => ({
	user_id: user.user_id,
	username: user.username ?? "",
	nickname: user.nickname ?? ""
}));
const ChatUserListResponseSchema = object({
	success: boolean(),
	data: object({ users: array(unknown()).optional().transform((users) => (users ?? []).flatMap((user) => {
		const parsed = safeParseWithSchema(ChatUserSchema, user);
		return parsed ? [parsed] : [];
	})) }).optional()
});
const chatUserCache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 300 * 1e3;
/**
* Send a text message to Synology Chat via the incoming webhook.
*
* @param incomingUrl - Synology Chat incoming webhook URL
* @param text - Message text to send
* @param userId - Optional user ID to mention with @
* @returns true if sent successfully
*/
async function sendMessage(incomingUrl, text, userId, allowInsecureSsl = false) {
	const body = buildWebhookBody({ text }, userId);
	const elapsed = Date.now() - lastSendTime;
	if (elapsed < MIN_SEND_INTERVAL_MS) await sleep(MIN_SEND_INTERVAL_MS - elapsed);
	const maxRetries = 3;
	const baseDelay = 300;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const ok = await doPost(incomingUrl, body, allowInsecureSsl);
			lastSendTime = Date.now();
			if (ok) return true;
		} catch {}
		if (attempt < maxRetries - 1) await sleep(baseDelay * 2 ** attempt);
	}
	return false;
}
/**
* Send a file URL to Synology Chat.
*/
async function sendFileUrl(incomingUrl, fileUrl, userId, allowInsecureSsl = false) {
	try {
		const body = buildWebhookBody({ file_url: await assertSafeWebhookFileUrl(fileUrl) }, userId);
		const elapsed = Date.now() - lastSendTime;
		if (elapsed < MIN_SEND_INTERVAL_MS) await sleep(MIN_SEND_INTERVAL_MS - elapsed);
		const ok = await doPost(incomingUrl, body, allowInsecureSsl);
		lastSendTime = Date.now();
		return ok;
	} catch {
		return false;
	}
}
/**
* Fetch the list of Chat users visible to this bot via the user_list API.
* Results are cached for CACHE_TTL_MS to avoid excessive API calls.
*
* The user_list endpoint uses the same base URL as the chatbot API but
* with method=user_list instead of method=chatbot.
*/
async function fetchChatUsers(incomingUrl, allowInsecureSsl = false, log) {
	const now = Date.now();
	const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
	const cached = chatUserCache.get(listUrl);
	if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.users;
	return new Promise((resolve) => {
		let parsedUrl;
		try {
			parsedUrl = new URL(listUrl);
		} catch {
			log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
			resolve(cached?.users ?? []);
			return;
		}
		const transport = parsedUrl.protocol === "https:" ? https$1 : http$1;
		const requestOptions = parsedUrl.protocol === "https:" ? { rejectUnauthorized: !allowInsecureSsl } : {};
		transport.get(listUrl, requestOptions, (res) => {
			let data = "";
			res.on("data", (c) => {
				data += c.toString();
			});
			res.on("end", () => {
				const result = safeParseJsonWithSchema(ChatUserListResponseSchema, data);
				if (!result) {
					log?.warn("fetchChatUsers: failed to parse user_list response");
					resolve(cached?.users ?? []);
					return;
				}
				if (result.success) {
					const users = result.data?.users ?? [];
					chatUserCache.set(listUrl, {
						users,
						cachedAt: now
					});
					resolve(users);
					return;
				}
				log?.warn(`fetchChatUsers: API returned success=${result.success}, using cached data`);
				resolve(cached?.users ?? []);
			});
		}).on("error", (err) => {
			log?.warn(`fetchChatUsers: HTTP error — ${err instanceof Error ? err.message : err}`);
			resolve(cached?.users ?? []);
		});
	});
}
async function assertSafeWebhookFileUrl(fileUrl) {
	let parsed;
	try {
		parsed = new URL(fileUrl);
	} catch (err) {
		throw new Error(`Invalid Synology Chat file URL: ${formatErrorMessage(err)}`, { cause: err });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Synology Chat file URL must use HTTP or HTTPS");
	await resolvePinnedHostnameWithPolicy(parsed.hostname);
	return parsed.toString();
}
/**
* Resolve a mutable webhook username/nickname to the correct Chat API user_id.
*
* Synology Chat outgoing webhooks send a user_id that may NOT match the
* Chat-internal user_id needed by the chatbot API (method=chatbot).
* The webhook's "username" field corresponds to the Chat user's "nickname".
*
* @returns The correct Chat user_id, or undefined if not found
*/
async function resolveLegacyWebhookNameToChatUserId(params) {
	const users = await fetchChatUsers(params.incomingUrl, params.allowInsecureSsl, params.log);
	const lower = normalizeLowercaseStringOrEmpty(params.mutableWebhookUsername);
	const byNickname = users.find((u) => normalizeLowercaseStringOrEmpty(u.nickname) === lower);
	if (byNickname) return byNickname.user_id;
	const byUsername = users.find((u) => normalizeLowercaseStringOrEmpty(u.username) === lower);
	if (byUsername) return byUsername.user_id;
}
function buildWebhookBody(payload, userId) {
	const numericId = parseNumericUserId(userId);
	if (numericId !== void 0) payload.user_ids = [numericId];
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}
function parseNumericUserId(userId) {
	if (userId === void 0) return;
	const numericId = typeof userId === "number" ? userId : Number.parseInt(userId, 10);
	return Number.isNaN(numericId) ? void 0 : numericId;
}
function doPost(url, body, allowInsecureSsl = false) {
	return new Promise((resolve, reject) => {
		let parsedUrl;
		try {
			parsedUrl = new URL(url);
		} catch {
			reject(/* @__PURE__ */ new Error(`Invalid URL: ${url}`));
			return;
		}
		const req = (parsedUrl.protocol === "https:" ? https$1 : http$1).request(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(body)
			},
			timeout: 3e4,
			rejectUnauthorized: !allowInsecureSsl
		}, (res) => {
			let data = "";
			res.on("data", (chunk) => {
				data += chunk.toString();
			});
			res.on("end", () => {
				resolve(res.statusCode === 200);
			});
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(/* @__PURE__ */ new Error("Request timeout"));
		});
		req.write(body);
		req.end();
	});
}
//#endregion
//#region extensions/synology-chat/src/config-schema.ts
const SynologyChatChannelConfigSchema = buildChannelConfigSchema(object({
	dangerouslyAllowNameMatching: boolean().optional(),
	dangerouslyAllowInheritedWebhookPath: boolean().optional()
}).passthrough());
//#endregion
//#region extensions/synology-chat/src/runtime.ts
const { setRuntime: setSynologyRuntime, getRuntime: getSynologyRuntime } = createPluginRuntimeStore({
	pluginId: "synology-chat",
	errorMessage: "Synology Chat runtime not initialized - plugin not registered"
});
//#endregion
//#region extensions/synology-chat/src/session-key.ts
const CHANNEL_ID$3 = "synology-chat";
function buildSynologyChatInboundSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: CHANNEL_ID$3,
		accountId: params.accountId,
		peer: {
			kind: "direct",
			id: params.userId
		},
		dmScope: "per-account-channel-peer",
		identityLinks: params.identityLinks
	});
}
//#endregion
//#region extensions/synology-chat/src/inbound-event.ts
const CHANNEL_ID$2 = "synology-chat";
function resolveSynologyChatInboundRoute(params) {
	const rt = getSynologyRuntime();
	const route = rt.channel.routing.resolveAgentRoute({
		cfg: params.cfg,
		channel: CHANNEL_ID$2,
		accountId: params.account.accountId,
		peer: {
			kind: "direct",
			id: params.userId
		}
	});
	return {
		rt,
		route,
		sessionKey: buildSynologyChatInboundSessionKey({
			agentId: route.agentId,
			accountId: params.account.accountId,
			userId: params.userId,
			identityLinks: params.cfg.session?.identityLinks
		})
	};
}
async function deliverSynologyChatReply(params) {
	const text = params.payload.text ?? params.payload.body;
	if (!text) return { visibleReplySent: false };
	return { visibleReplySent: await sendMessage(params.account.incomingUrl, text, params.sendUserId, params.account.allowInsecureSsl) };
}
async function dispatchSynologyChatInboundEvent(params) {
	const currentCfg = getSynologyRuntime().config.current();
	const sendUserId = params.msg.chatUserId ?? params.msg.from;
	const resolved = resolveSynologyChatInboundRoute({
		cfg: currentCfg,
		account: params.account,
		userId: params.msg.from
	});
	await resolved.rt.channel.turn.run({
		channel: CHANNEL_ID$2,
		accountId: params.account.accountId,
		raw: params.msg,
		adapter: {
			ingest: (msg) => ({
				id: `${params.account.accountId}:${msg.from}`,
				timestamp: Date.now(),
				rawText: msg.body,
				textForAgent: msg.body,
				textForCommands: msg.body,
				raw: msg
			}),
			resolveTurn: (input) => {
				const chatKind = params.msg.chatType === "group" || params.msg.chatType === "channel" ? params.msg.chatType : "direct";
				const msgCtx = resolved.rt.channel.turn.buildContext({
					channel: CHANNEL_ID$2,
					accountId: params.account.accountId,
					timestamp: input.timestamp,
					from: `synology-chat:${params.msg.from}`,
					sender: {
						id: params.msg.from,
						name: params.msg.senderName
					},
					conversation: {
						kind: chatKind,
						id: params.msg.from,
						label: params.msg.senderName || params.msg.from,
						routePeer: {
							kind: "direct",
							id: params.msg.from
						}
					},
					route: {
						agentId: resolved.route.agentId,
						accountId: params.account.accountId,
						routeSessionKey: resolved.sessionKey,
						dispatchSessionKey: resolved.sessionKey
					},
					reply: {
						to: `synology-chat:${params.msg.from}`,
						originatingTo: `synology-chat:${params.msg.from}`
					},
					message: {
						rawBody: input.rawText,
						commandBody: input.textForCommands,
						bodyForAgent: input.textForAgent,
						envelopeFrom: params.msg.senderName
					},
					extra: {
						ChatType: params.msg.chatType,
						CommandAuthorized: params.msg.commandAuthorized
					}
				});
				const storePath = resolved.rt.channel.session.resolveStorePath(currentCfg.session?.store, { agentId: resolved.route.agentId });
				return {
					cfg: currentCfg,
					channel: CHANNEL_ID$2,
					accountId: params.account.accountId,
					agentId: resolved.route.agentId,
					routeSessionKey: resolved.route.sessionKey,
					storePath,
					ctxPayload: msgCtx,
					recordInboundSession: resolved.rt.channel.session.recordInboundSession,
					dispatchReplyWithBufferedBlockDispatcher: resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
					delivery: {
						durable: () => ({ to: sendUserId }),
						deliver: async (payload) => {
							return await deliverSynologyChatReply({
								account: params.account,
								sendUserId,
								payload
							});
						}
					},
					dispatcherOptions: { onReplyStart: () => {
						params.log?.info?.(`Agent reply started for ${params.msg.from}`);
					} },
					record: { onRecordError: (err) => {
						params.log?.info?.(`Session metadata update failed for ${params.msg.from}`, err);
					} }
				};
			}
		}
	});
	return null;
}
//#endregion
//#region extensions/synology-chat/src/security.ts
/**
* Security module: token validation, rate limiting, input sanitization, user allowlist.
*/
/**
* Validate webhook token using constant-time comparison.
* Reject empty tokens explicitly; use shared constant-time comparison otherwise.
*/
function validateToken(received, expected) {
	if (!received || !expected) return false;
	return safeEqualSecret(received, expected);
}
async function authorizeUserForDmWithIngress(params) {
	return await resolveStableChannelMessageIngress({
		channelId: "synology-chat",
		accountId: params.accountId,
		identity: {
			key: "sender-id",
			entryIdPrefix: "synology-chat-entry"
		},
		subject: { stableId: params.userId },
		conversation: {
			kind: "direct",
			id: "direct"
		},
		event: { mayPair: false },
		dmPolicy: params.dmPolicy,
		allowFrom: params.allowedUserIds
	});
}
/**
* Sanitize user input to prevent prompt injection attacks.
* Filters known dangerous patterns and truncates long messages.
*/
function sanitizeInput(text) {
	const dangerousPatterns = [
		/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
		/you\s+are\s+now\s+/gi,
		/system:\s*/gi,
		/<\|.*?\|>/g
	];
	let sanitized = text;
	for (const pattern of dangerousPatterns) sanitized = sanitized.replace(pattern, "[FILTERED]");
	const maxLength = 4e3;
	if (sanitized.length > maxLength) sanitized = sanitized.slice(0, maxLength) + "... [truncated]";
	return sanitized;
}
/**
* Sliding window rate limiter per user ID.
*/
var RateLimiter = class {
	constructor(limit = 30, windowSeconds = 60, maxTrackedUsers = 5e3) {
		this.limit = limit;
		this.limiter = createFixedWindowRateLimiter({
			windowMs: Math.max(1, Math.floor(windowSeconds * 1e3)),
			maxRequests: Math.max(1, Math.floor(limit)),
			maxTrackedKeys: Math.max(1, Math.floor(maxTrackedUsers))
		});
	}
	/** Returns true if the request is allowed, false if rate-limited. */
	check(userId) {
		return !this.limiter.isRateLimited(userId);
	}
	/** Exposed for tests and diagnostics. */
	size() {
		return this.limiter.size();
	}
	/** Exposed for tests and account lifecycle cleanup. */
	clear() {
		this.limiter.clear();
	}
	/** Exposed for tests. */
	maxRequests() {
		return this.limit;
	}
};
//#endregion
//#region extensions/synology-chat/src/webhook-handler.ts
const rateLimiters = /* @__PURE__ */ new Map();
const invalidTokenRateLimiters = /* @__PURE__ */ new Map();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5e3;
const PREAUTH_MAX_REQUESTS_PER_MINUTE = 10;
const INVALID_TOKEN_WINDOW_MS = 6e4;
const INVALID_TOKEN_MAX_TRACKED_KEYS = 5e3;
var InvalidTokenRateLimiter = class {
	constructor(limit) {
		this.state = /* @__PURE__ */ new Map();
		this.limit = limit;
	}
	normalizeState(key, nowMs) {
		const existing = this.state.get(key);
		if (!existing) return;
		if (nowMs - existing.windowStartMs >= INVALID_TOKEN_WINDOW_MS) {
			this.state.delete(key);
			return;
		}
		return existing;
	}
	touch(key, value) {
		this.state.delete(key);
		this.state.set(key, value);
		while (this.state.size > INVALID_TOKEN_MAX_TRACKED_KEYS) {
			const oldestKey = this.state.keys().next().value;
			if (!oldestKey) break;
			this.state.delete(oldestKey);
		}
	}
	isLocked(key, nowMs = Date.now()) {
		if (!key) return false;
		return (this.normalizeState(key, nowMs)?.count ?? 0) > this.limit;
	}
	recordFailure(key, nowMs = Date.now()) {
		if (!key) return false;
		const existing = this.normalizeState(key, nowMs);
		const nextCount = (existing?.count ?? 0) + 1;
		const windowStartMs = existing?.windowStartMs ?? nowMs;
		this.touch(key, {
			count: nextCount,
			windowStartMs
		});
		return nextCount > this.limit;
	}
	clear() {
		this.state.clear();
	}
	maxRequests() {
		return this.limit;
	}
};
function getRateLimiter(account) {
	let rl = rateLimiters.get(account.accountId);
	if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
		rl?.clear();
		rl = new RateLimiter(account.rateLimitPerMinute);
		rateLimiters.set(account.accountId, rl);
	}
	return rl;
}
function getInvalidTokenRateLimiter(account) {
	const limit = Math.min(account.rateLimitPerMinute, PREAUTH_MAX_REQUESTS_PER_MINUTE);
	let rl = invalidTokenRateLimiters.get(account.accountId);
	if (!rl || rl.maxRequests() !== limit) {
		rl?.clear();
		rl = new InvalidTokenRateLimiter(limit);
		invalidTokenRateLimiters.set(account.accountId, rl);
	}
	return rl;
}
function getSynologyWebhookInvalidTokenRateLimitKey(req) {
	return req.socket?.remoteAddress ?? "unknown";
}
function getSynologyWebhookInFlightKey(account) {
	return account.accountId;
}
/** Read the full request body as a string. */
async function readBody(req, timeoutMs = PREAUTH_BODY_TIMEOUT_MS) {
	try {
		return {
			ok: true,
			body: await readRequestBodyWithLimit(req, {
				maxBytes: PREAUTH_MAX_BODY_BYTES,
				timeoutMs
			})
		};
	} catch (err) {
		if (isRequestBodyLimitError(err)) return {
			ok: false,
			statusCode: err.statusCode,
			error: requestBodyErrorToText(err.code)
		};
		return {
			ok: false,
			statusCode: 400,
			error: "Invalid request body"
		};
	}
}
function firstNonEmptyString(value) {
	if (Array.isArray(value)) {
		for (const item of value) {
			const normalized = firstNonEmptyString(item);
			if (normalized) return normalized;
		}
		return;
	}
	if (value === null || value === void 0) return;
	const str = typeof value === "string" ? value.trim() : "";
	return str.length > 0 ? str : void 0;
}
function pickAlias(record, aliases) {
	for (const alias of aliases) {
		const normalized = firstNonEmptyString(record[alias]);
		if (normalized) return normalized;
	}
}
function parseQueryParams(req) {
	try {
		const url = new URL(req.url ?? "", "http://localhost");
		const out = {};
		for (const [key, value] of url.searchParams.entries()) out[key] = value;
		return out;
	} catch {
		return {};
	}
}
function parseFormBody(body) {
	return querystring.parse(body);
}
function parseJsonBody(body) {
	if (!body.trim()) return {};
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Invalid JSON body");
	}
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Invalid JSON body");
	return parsed;
}
function headerValue(header) {
	return firstNonEmptyString(header);
}
function extractTokenFromHeaders(req) {
	const explicit = headerValue(req.headers["x-synology-token"]) ?? headerValue(req.headers["x-webhook-token"]) ?? headerValue(req.headers["x-openclaw-token"]);
	if (explicit) return explicit;
	const auth = headerValue(req.headers.authorization);
	if (!auth) return;
	const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
	if (bearerMatch?.[1]) return bearerMatch[1].trim();
	return auth.trim();
}
/**
* Parse/normalize incoming webhook payload.
*
* Supports:
* - application/x-www-form-urlencoded
* - application/json
*
* Token resolution order: body.token -> query.token -> headers
* Field aliases:
* - user_id <- user_id | userId | user
* - text    <- text | message | content
*/
function parsePayload(req, body) {
	const contentType = normalizeLowercaseStringOrEmpty(req.headers["content-type"]);
	let bodyFields = {};
	if (contentType.includes("application/json")) bodyFields = parseJsonBody(body);
	else if (contentType.includes("application/x-www-form-urlencoded")) bodyFields = parseFormBody(body);
	else try {
		bodyFields = parseJsonBody(body);
	} catch {
		bodyFields = parseFormBody(body);
	}
	const queryFields = parseQueryParams(req);
	const headerToken = extractTokenFromHeaders(req);
	const token = pickAlias(bodyFields, ["token"]) ?? pickAlias(queryFields, ["token"]) ?? headerToken;
	const userId = pickAlias(bodyFields, [
		"user_id",
		"userId",
		"user"
	]) ?? pickAlias(queryFields, [
		"user_id",
		"userId",
		"user"
	]);
	const text = pickAlias(bodyFields, [
		"text",
		"message",
		"content"
	]) ?? pickAlias(queryFields, [
		"text",
		"message",
		"content"
	]);
	if (!token || !userId || !text) return null;
	return {
		token,
		channel_id: pickAlias(bodyFields, ["channel_id"]) ?? pickAlias(queryFields, ["channel_id"]) ?? void 0,
		channel_name: pickAlias(bodyFields, ["channel_name"]) ?? pickAlias(queryFields, ["channel_name"]) ?? void 0,
		user_id: userId,
		username: pickAlias(bodyFields, [
			"username",
			"user_name",
			"name"
		]) ?? pickAlias(queryFields, [
			"username",
			"user_name",
			"name"
		]) ?? "unknown",
		post_id: pickAlias(bodyFields, ["post_id"]) ?? pickAlias(queryFields, ["post_id"]) ?? void 0,
		timestamp: pickAlias(bodyFields, ["timestamp"]) ?? pickAlias(queryFields, ["timestamp"]) ?? void 0,
		text,
		trigger_word: pickAlias(bodyFields, ["trigger_word", "triggerWord"]) ?? pickAlias(queryFields, ["trigger_word", "triggerWord"]) ?? void 0
	};
}
/** Send a JSON response. */
function respondJson(res, statusCode, body) {
	res.writeHead(statusCode, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}
/** Send a no-content ACK. */
function respondNoContent(res) {
	res.writeHead(204);
	res.end();
}
async function parseWebhookPayloadRequest(params) {
	const bodyResult = await readBody(params.req, params.bodyTimeoutMs);
	if (!bodyResult.ok) {
		params.log?.error("Failed to read request body", bodyResult.error);
		respondJson(params.res, bodyResult.statusCode, { error: bodyResult.error });
		return { ok: false };
	}
	let payload = null;
	try {
		payload = parsePayload(params.req, bodyResult.body);
	} catch (err) {
		params.log?.warn("Failed to parse webhook payload", err);
		respondJson(params.res, 400, { error: "Invalid request body" });
		return { ok: false };
	}
	if (!payload) {
		respondJson(params.res, 400, { error: "Missing required fields (token, user_id, text)" });
		return { ok: false };
	}
	return {
		ok: true,
		payload
	};
}
async function authorizeSynologyWebhook(params) {
	const invalidTokenRateLimitKey = getSynologyWebhookInvalidTokenRateLimitKey(params.req);
	if (params.invalidTokenRateLimiter.isLocked(invalidTokenRateLimitKey)) {
		params.log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
		return {
			ok: false,
			statusCode: 429,
			error: "Rate limit exceeded"
		};
	}
	if (!validateToken(params.payload.token, params.account.token)) {
		if (params.invalidTokenRateLimiter.recordFailure(invalidTokenRateLimitKey)) {
			params.log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
			return {
				ok: false,
				statusCode: 429,
				error: "Rate limit exceeded"
			};
		}
		params.log?.warn(`Invalid token from ${params.req.socket?.remoteAddress}`);
		return {
			ok: false,
			statusCode: 401,
			error: "Invalid token"
		};
	}
	const auth = await authorizeUserForDmWithIngress({
		accountId: params.account.accountId,
		userId: params.payload.user_id,
		dmPolicy: params.account.dmPolicy,
		allowedUserIds: params.account.allowedUserIds
	});
	if (!auth.senderAccess.allowed) {
		if (auth.senderAccess.reasonCode === "dm_policy_disabled") return {
			ok: false,
			statusCode: 403,
			error: "DMs are disabled"
		};
		if (params.account.dmPolicy === "allowlist" && params.account.allowedUserIds.length === 0) {
			params.log?.warn("Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message");
			return {
				ok: false,
				statusCode: 403,
				error: "Allowlist is empty. Configure allowedUserIds or use dmPolicy=open with allowedUserIds=[\"*\"]."
			};
		}
		params.log?.warn(`Unauthorized user: ${params.payload.user_id}`);
		return {
			ok: false,
			statusCode: 403,
			error: "User not authorized"
		};
	}
	if (!params.rateLimiter.check(params.payload.user_id)) {
		params.log?.warn(`Rate limit exceeded for user: ${params.payload.user_id}`);
		return {
			ok: false,
			statusCode: 429,
			error: "Rate limit exceeded"
		};
	}
	return {
		ok: true,
		commandAuthorized: auth.senderAccess.allowed
	};
}
function sanitizeSynologyWebhookText(payload) {
	let cleanText = sanitizeInput(payload.text);
	if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) cleanText = cleanText.slice(payload.trigger_word.length).trim();
	return cleanText;
}
async function parseAndAuthorizeSynologyWebhook(params) {
	const parsed = await parseWebhookPayloadRequest(params);
	if (!parsed.ok) return { ok: false };
	const authorized = await authorizeSynologyWebhook({
		req: params.req,
		account: params.account,
		payload: parsed.payload,
		invalidTokenRateLimiter: params.invalidTokenRateLimiter,
		rateLimiter: params.rateLimiter,
		log: params.log
	});
	if (!authorized.ok) {
		respondJson(params.res, authorized.statusCode, { error: authorized.error });
		return { ok: false };
	}
	const cleanText = sanitizeSynologyWebhookText(parsed.payload);
	if (!cleanText) {
		respondNoContent(params.res);
		return { ok: false };
	}
	const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
	return {
		ok: true,
		message: {
			payload: parsed.payload,
			body: cleanText,
			commandAuthorized: authorized.commandAuthorized,
			preview
		}
	};
}
async function resolveSynologyReplyDeliveryUserId(params) {
	if (!params.account.dangerouslyAllowNameMatching) return params.payload.user_id;
	const resolvedChatApiUserId = await resolveLegacyWebhookNameToChatUserId({
		incomingUrl: params.account.incomingUrl,
		mutableWebhookUsername: params.payload.username,
		allowInsecureSsl: params.account.allowInsecureSsl,
		log: params.log
	});
	if (resolvedChatApiUserId !== void 0) return String(resolvedChatApiUserId);
	params.log?.warn(`Could not resolve Chat API user_id for "${params.payload.username}" — falling back to webhook user_id ${params.payload.user_id}. Reply delivery may fail.`);
	return params.payload.user_id;
}
async function processAuthorizedSynologyWebhook(params) {
	const authorizedWebhookUserId = params.message.payload.user_id;
	let deliveryUserId = authorizedWebhookUserId;
	try {
		deliveryUserId = await resolveSynologyReplyDeliveryUserId({
			account: params.account,
			payload: params.message.payload,
			log: params.log
		});
		const deliverPromise = params.deliver({
			body: params.message.body,
			from: authorizedWebhookUserId,
			senderName: params.message.payload.username,
			provider: "synology-chat",
			chatType: "direct",
			accountId: params.account.accountId,
			commandAuthorized: params.message.commandAuthorized,
			chatUserId: deliveryUserId
		});
		const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("Agent response timeout (120s)")), 12e4));
		const reply = await Promise.race([deliverPromise, timeoutPromise]);
		if (!reply) return;
		await sendMessage(params.account.incomingUrl, reply, deliveryUserId, params.account.allowInsecureSsl);
		const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
		params.log?.info?.(`Reply sent to ${params.message.payload.username} (${deliveryUserId}): ${replyPreview}`);
	} catch (err) {
		const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
		params.log?.error?.(`Failed to process message from ${params.message.payload.username}: ${errMsg}`);
		await sendMessage(params.account.incomingUrl, "Sorry, an error occurred while processing your message.", deliveryUserId, params.account.allowInsecureSsl);
	}
}
function createWebhookHandler(deps) {
	const { account, deliver, log } = deps;
	const rateLimiter = getRateLimiter(account);
	const invalidTokenRateLimiter = getInvalidTokenRateLimiter(account);
	return async (req, res) => {
		if (req.method !== "POST") {
			respondJson(res, 405, { error: "Method not allowed" });
			return;
		}
		const requestLifecycle = beginWebhookRequestPipelineOrReject({
			req,
			res,
			inFlightLimiter: webhookInFlightLimiter,
			inFlightKey: getSynologyWebhookInFlightKey(account)
		});
		if (!requestLifecycle.ok) return;
		let authorized;
		try {
			authorized = await parseAndAuthorizeSynologyWebhook({
				req,
				res,
				account,
				invalidTokenRateLimiter,
				rateLimiter,
				log,
				bodyTimeoutMs: deps.bodyTimeoutMs
			});
		} finally {
			requestLifecycle.release();
		}
		if (!authorized.ok) return;
		log?.info(`Message from ${authorized.message.payload.username} (${authorized.message.payload.user_id}): ${authorized.message.preview}`);
		respondNoContent(res);
		await processAuthorizedSynologyWebhook({
			account,
			deliver,
			log,
			message: authorized.message
		});
	};
}
//#endregion
//#region extensions/synology-chat/src/gateway-runtime.ts
const CHANNEL_ID$1 = "synology-chat";
const activeRouteUnregisters = /* @__PURE__ */ new Map();
function buildStartupIssue(code, message, logLevel = "warn") {
	return {
		code,
		logLevel,
		message
	};
}
function logStartupIssues(log, issues) {
	for (const issue of issues) {
		const message = `Synology Chat ${issue.message}`;
		if (issue.logLevel === "info") {
			log?.info?.(message);
			continue;
		}
		log?.warn?.(message);
	}
}
function getRouteKey(account) {
	return `${account.accountId}:${account.webhookPath}`;
}
function createUnknownArgsLogAdapter(log) {
	if (!log) return;
	const formatArg = (value) => typeof value === "string" ? value : value instanceof Error ? value.message : "";
	return {
		info: (...args) => log.info?.(formatArg(args[0])),
		warn: (...args) => log.warn?.(formatArg(args[0])),
		error: (...args) => log.error?.(formatArg(args[0]))
	};
}
function collectSynologyGatewayStartupIssues(params) {
	const { cfg, account, accountId } = params;
	const issues = [];
	if (!account.enabled) {
		issues.push(buildStartupIssue("disabled", `account ${accountId} is disabled, skipping`, "info"));
		return issues;
	}
	if (!account.token || !account.incomingUrl) issues.push(buildStartupIssue("missing-credentials", `account ${accountId} not fully configured (missing token or incomingUrl)`));
	if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) issues.push(buildStartupIssue("empty-allowlist", `account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`));
	if (account.dmPolicy === "open" && account.allowedUserIds.length === 0) issues.push(buildStartupIssue("empty-open-allowlist", `account ${accountId} has dmPolicy=open but empty allowedUserIds; add allowedUserIds=["*"] for public DMs or set explicit user IDs`));
	const accountIds = listAccountIds(cfg);
	if (accountIds.length > 1 && accountId !== "default" && account.webhookPathSource === "inherited-base" && !account.dangerouslyAllowInheritedWebhookPath) issues.push(buildStartupIssue("inherited-shared-webhook-path", `account ${accountId} must set an explicit webhookPath in multi-account setups; refusing inherited shared path. Set channels.synology-chat.accounts.${accountId}.webhookPath or opt in with dangerouslyAllowInheritedWebhookPath=true.`));
	const conflictingAccounts = accountIds.filter((candidateId) => {
		if (candidateId === accountId) return false;
		const candidate = resolveAccount(cfg, candidateId);
		return candidate.enabled && candidate.webhookPath === account.webhookPath;
	});
	if (conflictingAccounts.length > 0) issues.push(buildStartupIssue("duplicate-webhook-path", `account ${accountId} conflicts on webhookPath ${account.webhookPath} with ${conflictingAccounts.join(", ")}; refusing to start ambiguous shared route.`));
	return issues;
}
function collectSynologyGatewayRoutingWarnings(params) {
	return collectSynologyGatewayStartupIssues({
		cfg: params.cfg,
		account: params.account,
		accountId: params.account.accountId
	}).filter((issue) => issue.code === "inherited-shared-webhook-path" || issue.code === "duplicate-webhook-path").map((issue) => `- Synology Chat: ${issue.message}`);
}
function validateSynologyGatewayAccountStartup(params) {
	const issues = collectSynologyGatewayStartupIssues(params);
	if (issues.length > 0) {
		logStartupIssues(params.log, issues);
		return { ok: false };
	}
	return { ok: true };
}
function registerSynologyWebhookRoute(params) {
	const { account, log } = params;
	const routeKey = getRouteKey(account);
	const prevUnregister = activeRouteUnregisters.get(routeKey);
	if (prevUnregister) {
		log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
		prevUnregister();
		activeRouteUnregisters.delete(routeKey);
	}
	const handler = createWebhookHandler({
		account,
		deliver: async (msg) => await dispatchSynologyChatInboundEvent({
			account,
			msg,
			log: createUnknownArgsLogAdapter(log)
		}),
		log: createUnknownArgsLogAdapter(log)
	});
	const unregister = registerPluginHttpRoute({
		path: account.webhookPath,
		auth: "plugin",
		pluginId: CHANNEL_ID$1,
		accountId: account.accountId,
		log: (msg) => log?.info?.(msg),
		handler
	});
	activeRouteUnregisters.set(routeKey, unregister);
	return () => {
		unregister();
		activeRouteUnregisters.delete(routeKey);
	};
}
//#endregion
//#region extensions/synology-chat/src/channel.ts
/**
* Synology Chat Channel Plugin for OpenClaw.
*
* Implements the ChannelPlugin interface following the LINE pattern.
*/
const CHANNEL_ID = "synology-chat";
const resolveSynologyChatDmPolicy = createScopedDmSecurityResolver({
	channelKey: CHANNEL_ID,
	resolvePolicy: (account) => account.dmPolicy,
	resolveAllowFrom: (account) => account.allowedUserIds,
	policyPathSuffix: "dmPolicy",
	defaultPolicy: "allowlist",
	approveHint: "openclaw pairing approve synology-chat <code>",
	normalizeEntry: (raw) => normalizeLowercaseStringOrEmpty(raw)
});
const synologyChatConfigAdapter = createHybridChannelConfigAdapter({
	sectionKey: CHANNEL_ID,
	listAccountIds,
	resolveAccount,
	defaultAccountId: () => DEFAULT_ACCOUNT_ID,
	clearBaseFields: [
		"token",
		"incomingUrl",
		"nasHost",
		"webhookPath",
		"dangerouslyAllowNameMatching",
		"dangerouslyAllowInheritedWebhookPath",
		"dmPolicy",
		"allowedUserIds",
		"rateLimitPerMinute",
		"botName",
		"allowInsecureSsl"
	],
	resolveAllowFrom: (account) => account.allowedUserIds,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => normalizeLowercaseStringOrEmpty(String(entry))).filter(Boolean)
});
const collectSynologyChatSecurityWarnings = createConditionalWarningCollector((account) => !account.token && "- Synology Chat: token is not configured. The webhook will reject all requests.", (account) => !account.incomingUrl && "- Synology Chat: incomingUrl is not configured. The bot cannot send replies.", (account) => account.allowInsecureSsl && "- Synology Chat: SSL verification is disabled (allowInsecureSsl=true). Only use this for local NAS with self-signed certificates.", (account) => account.dangerouslyAllowNameMatching && "- Synology Chat: dangerouslyAllowNameMatching=true re-enables mutable username/nickname recipient matching for replies. Prefer stable numeric user IDs.", (account) => account.dangerouslyAllowInheritedWebhookPath && account.webhookPathSource === "inherited-base" && "- Synology Chat: dangerouslyAllowInheritedWebhookPath=true opts a named account into a shared inherited webhook path. Prefer an explicit per-account webhookPath.", (account) => account.dmPolicy === "open" && account.allowedUserIds.length === 0 && "- Synology Chat: dmPolicy=\"open\" with empty allowedUserIds blocks all senders. Add allowedUserIds=[\"*\"] for public DMs or set explicit user IDs.", (account) => account.dmPolicy === "open" && account.allowedUserIds.includes("*") && "- Synology Chat: dmPolicy=\"open\" allows any user to message the bot. Consider \"allowlist\" for production use.", (account) => account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0 && "- Synology Chat: dmPolicy=\"allowlist\" with empty allowedUserIds blocks all senders. Add users or set dmPolicy=\"open\" with allowedUserIds=[\"*\"].");
const collectSynologyChatRoutingWarnings = projectAccountConfigWarningCollector((cfg) => cfg, ({ account, cfg }) => collectSynologyGatewayRoutingWarnings({
	account,
	cfg
}));
function resolveOutboundAccount(cfg, accountId) {
	return resolveAccount(cfg ?? {}, accountId);
}
function requireIncomingUrl(account) {
	if (!account.incomingUrl) throw new Error("Synology Chat incoming URL not configured");
	return account.incomingUrl;
}
function createSynologyChatSendResult(params) {
	return {
		channel: CHANNEL_ID,
		messageId: params.messageId,
		chatId: params.chatId,
		receipt: createMessageReceiptFromOutboundResults({
			results: [{
				channel: CHANNEL_ID,
				messageId: params.messageId,
				chatId: params.chatId,
				conversationId: params.chatId
			}],
			threadId: params.chatId,
			kind: params.kind
		})
	};
}
async function sendSynologyChatText(ctx) {
	const account = resolveOutboundAccount(ctx.cfg ?? {}, ctx.accountId);
	if (!await sendMessage(requireIncomingUrl(account), ctx.text, ctx.to, account.allowInsecureSsl)) throw new Error("Failed to send message to Synology Chat");
	return createSynologyChatSendResult({
		messageId: `sc-${Date.now()}`,
		chatId: ctx.to,
		kind: "text"
	});
}
async function sendSynologyChatMedia(ctx) {
	const account = resolveOutboundAccount(ctx.cfg ?? {}, ctx.accountId);
	if (!await sendFileUrl(requireIncomingUrl(account), ctx.mediaUrl, ctx.to, account.allowInsecureSsl)) throw new Error("Failed to send media to Synology Chat");
	return createSynologyChatSendResult({
		messageId: `sc-${Date.now()}`,
		chatId: ctx.to,
		kind: "media"
	});
}
const synologyChatMessageAdapter = defineChannelMessageAdapter({
	id: CHANNEL_ID,
	durableFinal: { capabilities: {
		text: true,
		media: true,
		messageSendingHooks: true
	} },
	send: {
		text: async (ctx) => await sendSynologyChatText(ctx),
		media: async (ctx) => await sendSynologyChatMedia(ctx)
	}
});
function createSynologyChatPlugin() {
	return createChatChannelPlugin({
		base: {
			id: CHANNEL_ID,
			meta: {
				id: CHANNEL_ID,
				label: "Synology Chat",
				selectionLabel: "Synology Chat (Webhook)",
				detailLabel: "Synology Chat (Webhook)",
				docsPath: "/channels/synology-chat",
				blurb: "Connect your Synology NAS Chat to OpenClaw",
				order: 90
			},
			capabilities: {
				chatTypes: ["direct"],
				media: true,
				threads: false,
				reactions: false,
				edit: false,
				unsend: false,
				reply: false,
				effects: false,
				blockStreaming: false
			},
			reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
			configSchema: SynologyChatChannelConfigSchema,
			setup: synologyChatSetupAdapter,
			setupWizard: synologyChatSetupWizard,
			config: { ...synologyChatConfigAdapter },
			approvalCapability: synologyChatApprovalAuth,
			messaging: {
				targetPrefixes: [
					"synology-chat",
					"synology_chat",
					"synology"
				],
				normalizeTarget: (target) => {
					const trimmed = target.trim();
					if (!trimmed) return;
					return trimmed.replace(/^synology(?:[-_]?chat)?:/i, "").trim();
				},
				targetResolver: {
					looksLikeId: (id) => {
						const trimmed = id?.trim();
						if (!trimmed) return false;
						return /^\d+$/.test(trimmed) || /^synology(?:[-_]?chat)?:/i.test(trimmed);
					},
					hint: "<userId>"
				}
			},
			directory: createEmptyChannelDirectoryAdapter(),
			gateway: {
				startAccount: async (ctx) => {
					const { cfg, accountId, log, abortSignal } = ctx;
					const account = resolveAccount(cfg, accountId);
					if (!validateSynologyGatewayAccountStartup({
						cfg,
						account,
						accountId,
						log
					}).ok) return waitUntilAbort(abortSignal);
					log?.info?.(`Starting Synology Chat channel (account: ${accountId}, path: ${account.webhookPath})`);
					const unregister = registerSynologyWebhookRoute({
						account,
						accountId,
						log
					});
					log?.info?.(`Registered HTTP route: ${account.webhookPath} for Synology Chat`);
					return waitUntilAbort(abortSignal, () => {
						log?.info?.(`Stopping Synology Chat channel (account: ${accountId})`);
						unregister();
					});
				},
				stopAccount: async (ctx) => {
					ctx.log?.info?.(`Synology Chat account ${ctx.accountId} stopped`);
				}
			},
			agentPrompt: { messageToolHints: () => [
				"",
				"### Synology Chat Formatting",
				"Synology Chat supports limited formatting. Use these patterns:",
				"",
				"**Links**: Use `<URL|display text>` to create clickable links.",
				"  Example: `<https://example.com|Click here>` renders as a clickable link.",
				"",
				"**File sharing**: Include a publicly accessible URL to share files or images.",
				"  The NAS will download and attach the file (max 32 MB).",
				"",
				"**Limitations**:",
				"- No markdown, bold, italic, or code blocks",
				"- No buttons, cards, or interactive elements",
				"- No message editing after send",
				"- Keep messages under 2000 characters for best readability",
				"",
				"**Best practices**:",
				"- Use short, clear responses (Synology Chat has a minimal UI)",
				"- Use line breaks to separate sections",
				"- Use numbered or bulleted lists for clarity",
				"- Wrap URLs with `<URL|label>` for user-friendly links"
			] },
			message: synologyChatMessageAdapter
		},
		pairing: { text: {
			idLabel: "synologyChatUserId",
			message: "OpenClaw: your access has been approved.",
			normalizeAllowEntry: (entry) => normalizeLowercaseStringOrEmpty(entry),
			notify: async ({ cfg, id, message }) => {
				const account = resolveAccount(cfg);
				if (!account.incomingUrl) return;
				await sendMessage(account.incomingUrl, message, id, account.allowInsecureSsl);
			}
		} },
		security: {
			resolveDmPolicy: resolveSynologyChatDmPolicy,
			collectWarnings: composeWarningCollectors(projectAccountWarningCollector(collectSynologyChatSecurityWarnings), collectSynologyChatRoutingWarnings),
			collectAuditFindings: collectSynologyChatSecurityAuditFindings
		},
		outbound: {
			deliveryMode: "gateway",
			textChunkLimit: 2e3,
			sendText: sendSynologyChatText,
			sendMedia: async (ctx) => {
				if (!ctx.mediaUrl) throw new Error("Synology Chat media send requires mediaUrl");
				return await sendSynologyChatMedia({
					...ctx,
					mediaUrl: ctx.mediaUrl
				});
			}
		}
	});
}
const synologyChatPlugin = createSynologyChatPlugin();
//#endregion
export { setSynologyRuntime as n, synologyChatPlugin as t };
