import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema } from "./resolve-route-BZ4hHpx2.js";
import { Bl as splitSetupEntries, Cl as formatDocsLink, Do as readRequestBodyWithLimit, El as mergeAllowFromEntries, Il as setSetupChannelEnabled, It as registerPluginHttpRoute, Oo as requestBodyErrorToText, Qa as createFixedWindowRateLimiter, To as isRequestBodyLimitError, b as createPluginRuntimeStore } from "./auth-profiles-CuJtivJK.js";
import { z } from "zod";
import * as crypto$1 from "node:crypto";
import * as http$1 from "node:http";
import * as https$1 from "node:https";
import * as querystring from "node:querystring";
//#region extensions/synology-chat/src/accounts.ts
/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig$1(cfg) {
	return cfg?.channels?.["synology-chat"];
}
/** Parse allowedUserIds from string or array to string[]. */
function parseAllowedUserIds(raw) {
	if (!raw) {return [];}
	if (Array.isArray(raw)) {return raw.filter(Boolean);}
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function parseRateLimitPerMinute(raw) {
	if (raw == null) {return 30;}
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) {return 30;}
	return Number.parseInt(trimmed, 10);
}
/**
* List all configured account IDs for this channel.
* Returns ["default"] if there's a base config, plus any named accounts.
*/
function listAccountIds(cfg) {
	const channelCfg = getChannelConfig$1(cfg);
	if (!channelCfg) {return [];}
	const ids = /* @__PURE__ */ new Set();
	if (channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN) {ids.add("default");}
	if (channelCfg.accounts) {for (const id of Object.keys(channelCfg.accounts)) ids.add(id);}
	return Array.from(ids);
}
/**
* Resolve a specific account by ID with full defaults applied.
* Falls back to env vars for the "default" account.
*/
function resolveAccount(cfg, accountId) {
	const channelCfg = getChannelConfig$1(cfg) ?? {};
	const id = accountId || "default";
	const accountOverride = channelCfg.accounts?.[id] ?? {};
	const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
	const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
	const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
	const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
	const envRateLimitValue = parseRateLimitPerMinute(process.env.SYNOLOGY_RATE_LIMIT);
	const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";
	return {
		accountId: id,
		enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
		token: accountOverride.token ?? channelCfg.token ?? envToken,
		incomingUrl: accountOverride.incomingUrl ?? channelCfg.incomingUrl ?? envIncomingUrl,
		nasHost: accountOverride.nasHost ?? channelCfg.nasHost ?? envNasHost,
		webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/synology",
		dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "allowlist",
		allowedUserIds: parseAllowedUserIds(accountOverride.allowedUserIds ?? channelCfg.allowedUserIds ?? envAllowedUserIds),
		rateLimitPerMinute: accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? envRateLimitValue,
		botName: accountOverride.botName ?? channelCfg.botName ?? envBotName,
		allowInsecureSsl: accountOverride.allowInsecureSsl ?? channelCfg.allowInsecureSsl ?? false
	};
}
//#endregion
//#region extensions/synology-chat/src/setup-surface.ts
const channel = "synology-chat";
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";
const SYNOLOGY_SETUP_HELP_LINES = [
	"1) Create an incoming webhook in Synology Chat and copy its URL",
	"2) Create an outgoing webhook and copy its secret token",
	`3) Point the outgoing webhook to https://<gateway-host>${DEFAULT_WEBHOOK_PATH}`,
	"4) Keep allowed user IDs handy for DM allowlisting",
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
const SYNOLOGY_ALLOW_FROM_HELP_LINES = [
	"Allowlist Synology Chat DMs by numeric user id.",
	"Examples:",
	"- 123456",
	"- synology-chat:123456",
	"Multiple entries: comma-separated.",
	`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
];
function getChannelConfig(cfg) {
	return cfg.channels?.[channel] ?? {};
}
function getRawAccountConfig(cfg, accountId) {
	const channelConfig = getChannelConfig(cfg);
	if (accountId === "default") {return channelConfig;}
	return channelConfig.accounts?.[accountId] ?? {};
}
function patchSynologyChatAccountConfig(params) {
	const channelConfig = getChannelConfig(params.cfg);
	if (params.accountId === "default") {
		const nextChannelConfig = { ...channelConfig };
		for (const field of params.clearFields ?? []) {delete nextChannelConfig[field];}
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[channel]: {
					...nextChannelConfig,
					...params.enabled ? { enabled: true } : {},
					...params.patch
				}
			}
		};
	}
	const nextAccounts = { ...channelConfig.accounts };
	const nextAccountConfig = { ...nextAccounts[params.accountId] };
	for (const field of params.clearFields ?? []) {delete nextAccountConfig[field];}
	nextAccounts[params.accountId] = {
		...nextAccountConfig,
		...params.enabled ? { enabled: true } : {},
		...params.patch
	};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[channel]: {
				...channelConfig,
				...params.enabled ? { enabled: true } : {},
				accounts: nextAccounts
			}
		}
	};
}
function isSynologyChatConfigured(cfg, accountId) {
	const account = resolveAccount(cfg, accountId);
	return Boolean(account.token.trim() && account.incomingUrl.trim());
}
function validateWebhookUrl(value) {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {return "Incoming webhook must use http:// or https://.";}
	} catch {
		return "Incoming webhook must be a valid URL.";
	}
}
function validateWebhookPath(value) {
	const trimmed = value.trim();
	if (!trimmed) {return;}
	return trimmed.startsWith("/") ? void 0 : "Webhook path must start with /.";
}
function parseSynologyUserId(value) {
	const cleaned = value.replace(/^synology-chat:/i, "").trim();
	return /^\d+$/.test(cleaned) ? cleaned : null;
}
function resolveExistingAllowedUserIds(cfg, accountId) {
	const raw = getRawAccountConfig(cfg, accountId).allowedUserIds;
	if (Array.isArray(raw)) {return raw.map((value) => String(value).trim()).filter(Boolean);}
	return String(raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}
const synologyChatSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? "default",
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") {return "Synology Chat env credentials only support the default account.";}
		if (!input.useEnv && !input.token?.trim()) {return "Synology Chat requires --token or --use-env.";}
		if (!input.url?.trim()) {return "Synology Chat requires --url for the incoming webhook.";}
		const urlError = validateWebhookUrl(input.url.trim());
		if (urlError) {return urlError;}
		if (input.webhookPath?.trim()) {return validateWebhookPath(input.webhookPath.trim()) ?? null;}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => patchSynologyChatAccountConfig({
		cfg,
		accountId,
		enabled: true,
		clearFields: input.useEnv ? ["token"] : void 0,
		patch: {
			...input.useEnv ? {} : { token: input.token?.trim() },
			incomingUrl: input.url?.trim(),
			...input.webhookPath?.trim() ? { webhookPath: input.webhookPath.trim() } : {}
		}
	})
};
const synologyChatSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs token + incoming webhook",
		configuredHint: "configured",
		unconfiguredHint: "needs token + incoming webhook",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => listAccountIds(cfg).some((accountId) => isSynologyChatConfigured(cfg, accountId)),
		resolveStatusLines: ({ cfg, configured }) => [`Synology Chat: ${configured ? "configured" : "needs token + incoming webhook"}`, `Accounts: ${listAccountIds(cfg).length || 0}`]
	},
	introNote: {
		title: "Synology Chat webhook setup",
		lines: SYNOLOGY_SETUP_HELP_LINES
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: "outgoing webhook token",
		preferredEnvVar: "SYNOLOGY_CHAT_TOKEN",
		helpTitle: "Synology Chat webhook token",
		helpLines: SYNOLOGY_SETUP_HELP_LINES,
		envPrompt: "SYNOLOGY_CHAT_TOKEN detected. Use env var?",
		keepPrompt: "Synology Chat webhook token already configured. Keep it?",
		inputPrompt: "Enter Synology Chat outgoing webhook token",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const account = resolveAccount(cfg, accountId);
			const raw = getRawAccountConfig(cfg, accountId);
			return {
				accountConfigured: isSynologyChatConfigured(cfg, accountId),
				hasConfiguredValue: Boolean(raw.token?.trim()),
				resolvedValue: account.token.trim() || void 0,
				envValue: accountId === "default" ? process.env.SYNOLOGY_CHAT_TOKEN?.trim() || void 0 : void 0
			};
		},
		applyUseEnv: async ({ cfg, accountId }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["token"],
			patch: {}
		}),
		applySet: async ({ cfg, accountId, resolvedValue }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: { token: resolvedValue }
		})
	}],
	textInputs: [{
		inputKey: "url",
		message: "Incoming webhook URL",
		placeholder: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming...",
		helpTitle: "Synology Chat incoming webhook",
		helpLines: ["Use the incoming webhook URL from Synology Chat integrations.", "This is the URL OpenClaw uses to send replies back to Chat."],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).incomingUrl?.trim(),
		keepPrompt: (value) => `Incoming webhook URL set (${value}). Keep it?`,
		validate: ({ value }) => validateWebhookUrl(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: { incomingUrl: value.trim() }
		})
	}, {
		inputKey: "webhookPath",
		message: "Outgoing webhook path (optional)",
		placeholder: DEFAULT_WEBHOOK_PATH,
		required: false,
		applyEmptyValue: true,
		helpTitle: "Synology Chat outgoing webhook path",
		helpLines: [`Default path: ${DEFAULT_WEBHOOK_PATH}`, "Change this only if you need multiple Synology Chat webhook routes."],
		currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).webhookPath?.trim(),
		keepPrompt: (value) => `Outgoing webhook path set (${value}). Keep it?`,
		validate: ({ value }) => validateWebhookPath(value),
		applySet: async ({ cfg, accountId, value }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: value.trim() ? void 0 : ["webhookPath"],
			patch: value.trim() ? { webhookPath: value.trim() } : {}
		})
	}],
	allowFrom: {
		helpTitle: "Synology Chat allowlist",
		helpLines: SYNOLOGY_ALLOW_FROM_HELP_LINES,
		message: "Allowed Synology Chat user ids",
		placeholder: "123456, 987654",
		invalidWithoutCredentialNote: "Synology Chat user ids must be numeric.",
		parseInputs: splitSetupEntries,
		parseId: parseSynologyUserId,
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const id = parseSynologyUserId(entry);
			return {
				input: entry,
				resolved: Boolean(id),
				id
			};
		}),
		apply: async ({ cfg, accountId, allowFrom }) => patchSynologyChatAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: {
				dmPolicy: "allowlist",
				allowedUserIds: mergeAllowFromEntries(resolveExistingAllowedUserIds(cfg, accountId), allowFrom)
			}
		})
	},
	completionNote: {
		title: "Synology Chat access control",
		lines: [
			`Default outgoing webhook path: ${DEFAULT_WEBHOOK_PATH}`,
			"Set allowed user IDs, or manually switch `channels.synology-chat.dmPolicy` to `\"open\"` for public DMs.",
			"With `dmPolicy=\"allowlist\"`, an empty allowedUserIds list blocks the route from starting.",
			`Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
//#region extensions/synology-chat/src/client.ts
/**
* Synology Chat HTTP client.
* Sends messages TO Synology Chat via the incoming webhook URL.
*/
const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;
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
async function sendMessage(incomingUrl, text, userId, allowInsecureSsl = true) {
	const body = buildWebhookBody({ text }, userId);
	const elapsed = Date.now() - lastSendTime;
	if (elapsed < MIN_SEND_INTERVAL_MS) {await sleep(MIN_SEND_INTERVAL_MS - elapsed);}
	const maxRetries = 3;
	const baseDelay = 300;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const ok = await doPost(incomingUrl, body, allowInsecureSsl);
			lastSendTime = Date.now();
			if (ok) {return true;}
		} catch {}
		if (attempt < maxRetries - 1) {await sleep(baseDelay * Math.pow(2, attempt));}
	}
	return false;
}
/**
* Send a file URL to Synology Chat.
*/
async function sendFileUrl(incomingUrl, fileUrl, userId, allowInsecureSsl = true) {
	const body = buildWebhookBody({ file_url: fileUrl }, userId);
	try {
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
async function fetchChatUsers(incomingUrl, allowInsecureSsl = true, log) {
	const now = Date.now();
	const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
	const cached = chatUserCache.get(listUrl);
	if (cached && now - cached.cachedAt < CACHE_TTL_MS) {return cached.users;}
	return new Promise((resolve) => {
		let parsedUrl;
		try {
			parsedUrl = new URL(listUrl);
		} catch {
			log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
			resolve(cached?.users ?? []);
			return;
		}
		(parsedUrl.protocol === "https:" ? https$1 : http$1).get(listUrl, { rejectUnauthorized: !allowInsecureSsl }, (res) => {
			let data = "";
			res.on("data", (c) => {
				data += c.toString();
			});
			res.on("end", () => {
				try {
					const result = JSON.parse(data);
					if (result.success && result.data?.users) {
						const users = result.data.users.map((u) => ({
							user_id: u.user_id,
							username: u.username || "",
							nickname: u.nickname || ""
						}));
						chatUserCache.set(listUrl, {
							users,
							cachedAt: now
						});
						resolve(users);
					} else {
						log?.warn(`fetchChatUsers: API returned success=${result.success}, using cached data`);
						resolve(cached?.users ?? []);
					}
				} catch {
					log?.warn("fetchChatUsers: failed to parse user_list response");
					resolve(cached?.users ?? []);
				}
			});
		}).on("error", (err) => {
			log?.warn(`fetchChatUsers: HTTP error — ${err instanceof Error ? err.message : err}`);
			resolve(cached?.users ?? []);
		});
	});
}
/**
* Resolve a webhook username to the correct Chat API user_id.
*
* Synology Chat outgoing webhooks send a user_id that may NOT match the
* Chat-internal user_id needed by the chatbot API (method=chatbot).
* The webhook's "username" field corresponds to the Chat user's "nickname".
*
* @param incomingUrl - Bot incoming webhook URL (used to derive user_list URL)
* @param webhookUsername - The username from the outgoing webhook payload
* @param allowInsecureSsl - Skip TLS verification
* @returns The correct Chat user_id, or undefined if not found
*/
async function resolveChatUserId(incomingUrl, webhookUsername, allowInsecureSsl = true, log) {
	const users = await fetchChatUsers(incomingUrl, allowInsecureSsl, log);
	const lower = webhookUsername.toLowerCase();
	const byNickname = users.find((u) => u.nickname.toLowerCase() === lower);
	if (byNickname) {return byNickname.user_id;}
	const byUsername = users.find((u) => u.username.toLowerCase() === lower);
	if (byUsername) {return byUsername.user_id;}
}
function buildWebhookBody(payload, userId) {
	const numericId = parseNumericUserId(userId);
	if (numericId !== void 0) {payload.user_ids = [numericId];}
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}
function parseNumericUserId(userId) {
	if (userId === void 0) {return;}
	const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
	return Number.isNaN(numericId) ? void 0 : numericId;
}
function doPost(url, body, allowInsecureSsl = true) {
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
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region extensions/synology-chat/src/runtime.ts
const { setRuntime: setSynologyRuntime, getRuntime: getSynologyRuntime } = createPluginRuntimeStore("Synology Chat runtime not initialized - plugin not registered");
//#endregion
//#region extensions/synology-chat/src/security.ts
/**
* Security module: token validation, rate limiting, input sanitization, user allowlist.
*/
/**
* Validate webhook token using constant-time comparison.
* Prevents timing attacks that could leak token bytes.
*/
function validateToken(received, expected) {
	if (!received || !expected) {return false;}
	const key = "openclaw-token-cmp";
	const a = crypto$1.createHmac("sha256", key).update(received).digest();
	const b = crypto$1.createHmac("sha256", key).update(expected).digest();
	return crypto$1.timingSafeEqual(a, b);
}
/**
* Check if a user ID is in the allowed list.
* Allowlist mode must be explicit; empty lists should not match any user.
*/
function checkUserAllowed(userId, allowedUserIds) {
	if (allowedUserIds.length === 0) {return false;}
	return allowedUserIds.includes(userId);
}
/**
* Resolve DM authorization for a sender across all DM policy modes.
* Keeps policy semantics in one place so webhook/startup behavior stays consistent.
*/
function authorizeUserForDm(userId, dmPolicy, allowedUserIds) {
	if (dmPolicy === "disabled") {return {
		allowed: false,
		reason: "disabled"
	};}
	if (dmPolicy === "open") {return { allowed: true };}
	if (allowedUserIds.length === 0) {return {
		allowed: false,
		reason: "allowlist-empty"
	};}
	if (!checkUserAllowed(userId, allowedUserIds)) {return {
		allowed: false,
		reason: "not-allowlisted"
	};}
	return { allowed: true };
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
	for (const pattern of dangerousPatterns) {sanitized = sanitized.replace(pattern, "[FILTERED]");}
	const maxLength = 4e3;
	if (sanitized.length > maxLength) {sanitized = sanitized.slice(0, maxLength) + "... [truncated]";}
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
const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5e3;
function getRateLimiter(account) {
	let rl = rateLimiters.get(account.accountId);
	if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
		rl?.clear();
		rl = new RateLimiter(account.rateLimitPerMinute);
		rateLimiters.set(account.accountId, rl);
	}
	return rl;
}
/** Read the full request body as a string. */
async function readBody(req) {
	try {
		return {
			ok: true,
			body: await readRequestBodyWithLimit(req, {
				maxBytes: PREAUTH_MAX_BODY_BYTES,
				timeoutMs: PREAUTH_BODY_TIMEOUT_MS
			})
		};
	} catch (err) {
		if (isRequestBodyLimitError(err)) {return {
			ok: false,
			statusCode: err.statusCode,
			error: requestBodyErrorToText(err.code)
		};}
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
			if (normalized) {return normalized;}
		}
		return;
	}
	if (value === null || value === void 0) {return void 0;}
	const str = String(value).trim();
	return str.length > 0 ? str : void 0;
}
function pickAlias(record, aliases) {
	for (const alias of aliases) {
		const normalized = firstNonEmptyString(record[alias]);
		if (normalized) {return normalized;}
	}
}
function parseQueryParams(req) {
	try {
		const url = new URL(req.url ?? "", "http://localhost");
		const out = {};
		for (const [key, value] of url.searchParams.entries()) {out[key] = value;}
		return out;
	} catch {
		return {};
	}
}
function parseFormBody(body) {
	return querystring.parse(body);
}
function parseJsonBody(body) {
	if (!body.trim()) {return {};}
	const parsed = JSON.parse(body);
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {throw new Error("Invalid JSON body");}
	return parsed;
}
function headerValue(header) {
	return firstNonEmptyString(header);
}
function extractTokenFromHeaders(req) {
	const explicit = headerValue(req.headers["x-synology-token"]) ?? headerValue(req.headers["x-webhook-token"]) ?? headerValue(req.headers["x-openclaw-token"]);
	if (explicit) {return explicit;}
	const auth = headerValue(req.headers.authorization);
	if (!auth) {return void 0;}
	const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
	if (bearerMatch?.[1]) {return bearerMatch[1].trim();}
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
	const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
	let bodyFields = {};
	if (contentType.includes("application/json")) {bodyFields = parseJsonBody(body);}
	else if (contentType.includes("application/x-www-form-urlencoded")) {bodyFields = parseFormBody(body);}
	else {try {
		bodyFields = parseJsonBody(body);
	} catch {
		bodyFields = parseFormBody(body);
	}}
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
	if (!token || !userId || !text) {return null;}
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
/**
* Create an HTTP request handler for Synology Chat outgoing webhooks.
*
* This handler:
* 1. Parses form-urlencoded/JSON payload
* 2. Validates token (constant-time)
* 3. Checks user allowlist
* 4. Checks rate limit
* 5. Sanitizes input
* 6. Immediately ACKs request (204)
* 7. Delivers to the agent asynchronously and sends final reply via incomingUrl
*/
function createWebhookHandler(deps) {
	const { account, deliver, log } = deps;
	const rateLimiter = getRateLimiter(account);
	return async (req, res) => {
		if (req.method !== "POST") {
			respondJson(res, 405, { error: "Method not allowed" });
			return;
		}
		const bodyResult = await readBody(req);
		if (!bodyResult.ok) {
			log?.error("Failed to read request body", bodyResult.error);
			respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
			return;
		}
		let payload = null;
		try {
			payload = parsePayload(req, bodyResult.body);
		} catch (err) {
			log?.warn("Failed to parse webhook payload", err);
			respondJson(res, 400, { error: "Invalid request body" });
			return;
		}
		if (!payload) {
			respondJson(res, 400, { error: "Missing required fields (token, user_id, text)" });
			return;
		}
		if (!validateToken(payload.token, account.token)) {
			log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
			respondJson(res, 401, { error: "Invalid token" });
			return;
		}
		const auth = authorizeUserForDm(payload.user_id, account.dmPolicy, account.allowedUserIds);
		if (!auth.allowed) {
			if (auth.reason === "disabled") {
				respondJson(res, 403, { error: "DMs are disabled" });
				return;
			}
			if (auth.reason === "allowlist-empty") {
				log?.warn("Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message");
				respondJson(res, 403, { error: "Allowlist is empty. Configure allowedUserIds or use dmPolicy=open." });
				return;
			}
			log?.warn(`Unauthorized user: ${payload.user_id}`);
			respondJson(res, 403, { error: "User not authorized" });
			return;
		}
		if (!rateLimiter.check(payload.user_id)) {
			log?.warn(`Rate limit exceeded for user: ${payload.user_id}`);
			respondJson(res, 429, { error: "Rate limit exceeded" });
			return;
		}
		let cleanText = sanitizeInput(payload.text);
		if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) {cleanText = cleanText.slice(payload.trigger_word.length).trim();}
		if (!cleanText) {
			respondNoContent(res);
			return;
		}
		const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
		log?.info(`Message from ${payload.username} (${payload.user_id}): ${preview}`);
		respondNoContent(res);
		let replyUserId = payload.user_id;
		try {
			const chatUserId = await resolveChatUserId(account.incomingUrl, payload.username, account.allowInsecureSsl, log);
			if (chatUserId !== void 0) {replyUserId = String(chatUserId);}
			else {log?.warn(`Could not resolve Chat API user_id for "${payload.username}" — falling back to webhook user_id ${payload.user_id}. Reply delivery may fail.`);}
			const sessionKey = `synology-chat-${payload.user_id}`;
			const deliverPromise = deliver({
				body: cleanText,
				from: payload.user_id,
				senderName: payload.username,
				provider: "synology-chat",
				chatType: "direct",
				sessionKey,
				accountId: account.accountId,
				commandAuthorized: auth.allowed,
				chatUserId: replyUserId
			});
			const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("Agent response timeout (120s)")), 12e4));
			const reply = await Promise.race([deliverPromise, timeoutPromise]);
			if (reply) {
				await sendMessage(account.incomingUrl, reply, replyUserId, account.allowInsecureSsl);
				const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
				log?.info(`Reply sent to ${payload.username} (${replyUserId}): ${replyPreview}`);
			}
		} catch (err) {
			const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
			log?.error(`Failed to process message from ${payload.username}: ${errMsg}`);
			await sendMessage(account.incomingUrl, "Sorry, an error occurred while processing your message.", replyUserId, account.allowInsecureSsl);
		}
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
const SynologyChatConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());
const activeRouteUnregisters = /* @__PURE__ */ new Map();
function waitUntilAbort(signal, onAbort) {
	return new Promise((resolve) => {
		const complete = () => {
			onAbort?.();
			resolve();
		};
		if (!signal) {return;}
		if (signal.aborted) {
			complete();
			return;
		}
		signal.addEventListener("abort", complete, { once: true });
	});
}
function createSynologyChatPlugin() {
	return {
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
		configSchema: SynologyChatConfigSchema,
		setup: synologyChatSetupAdapter,
		setupWizard: synologyChatSetupWizard,
		config: {
			listAccountIds: (cfg) => listAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
			defaultAccountId: (_cfg) => DEFAULT_ACCOUNT_ID,
			setAccountEnabled: ({ cfg, accountId, enabled }) => {
				const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
				if (accountId === "default") {return {
					...cfg,
					channels: {
						...cfg.channels,
						[CHANNEL_ID]: {
							...channelConfig,
							enabled
						}
					}
				};}
				return setAccountEnabledInConfigSection({
					cfg,
					sectionKey: `channels.${CHANNEL_ID}`,
					accountId,
					enabled
				});
			}
		},
		pairing: {
			idLabel: "synologyChatUserId",
			normalizeAllowEntry: (entry) => entry.toLowerCase().trim(),
			notifyApproval: async ({ cfg, id }) => {
				const account = resolveAccount(cfg);
				if (!account.incomingUrl) {return;}
				await sendMessage(account.incomingUrl, "OpenClaw: your access has been approved.", id, account.allowInsecureSsl);
			}
		},
		security: {
			resolveDmPolicy: ({ cfg, accountId, account }) => {
				const resolvedAccountId = accountId ?? account.accountId ?? "default";
				const channelCfg = cfg.channels?.["synology-chat"];
				const basePath = channelCfg?.accounts?.[resolvedAccountId] ? `channels.synology-chat.accounts.${resolvedAccountId}.` : "channels.synology-chat.";
				return {
					policy: account.dmPolicy ?? "allowlist",
					allowFrom: account.allowedUserIds ?? [],
					policyPath: `${basePath}dmPolicy`,
					allowFromPath: basePath,
					approveHint: "openclaw pairing approve synology-chat <code>",
					normalizeEntry: (raw) => raw.toLowerCase().trim()
				};
			},
			collectWarnings: ({ account }) => {
				const warnings = [];
				if (!account.token) {warnings.push("- Synology Chat: token is not configured. The webhook will reject all requests.");}
				if (!account.incomingUrl) {warnings.push("- Synology Chat: incomingUrl is not configured. The bot cannot send replies.");}
				if (account.allowInsecureSsl) {warnings.push("- Synology Chat: SSL verification is disabled (allowInsecureSsl=true). Only use this for local NAS with self-signed certificates.");}
				if (account.dmPolicy === "open") {warnings.push("- Synology Chat: dmPolicy=\"open\" allows any user to message the bot. Consider \"allowlist\" for production use.");}
				if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {warnings.push("- Synology Chat: dmPolicy=\"allowlist\" with empty allowedUserIds blocks all senders. Add users or set dmPolicy=\"open\".");}
				return warnings;
			}
		},
		messaging: {
			normalizeTarget: (target) => {
				const trimmed = target.trim();
				if (!trimmed) {return void 0;}
				return trimmed.replace(/^synology[-_]?chat:/i, "").trim();
			},
			targetResolver: {
				looksLikeId: (id) => {
					const trimmed = id?.trim();
					if (!trimmed) {return false;}
					return /^\d+$/.test(trimmed) || /^synology[-_]?chat:/i.test(trimmed);
				},
				hint: "<userId>"
			}
		},
		directory: {
			self: async () => null,
			listPeers: async () => [],
			listGroups: async () => []
		},
		outbound: {
			deliveryMode: "gateway",
			textChunkLimit: 2e3,
			sendText: async ({ to, text, accountId, cfg }) => {
				const account = resolveAccount(cfg ?? {}, accountId);
				if (!account.incomingUrl) {throw new Error("Synology Chat incoming URL not configured");}
				if (!await sendMessage(account.incomingUrl, text, to, account.allowInsecureSsl)) {throw new Error("Failed to send message to Synology Chat");}
				return {
					channel: CHANNEL_ID,
					messageId: `sc-${Date.now()}`,
					chatId: to
				};
			},
			sendMedia: async ({ to, mediaUrl, accountId, cfg }) => {
				const account = resolveAccount(cfg ?? {}, accountId);
				if (!account.incomingUrl) {throw new Error("Synology Chat incoming URL not configured");}
				if (!mediaUrl) {throw new Error("No media URL provided");}
				if (!await sendFileUrl(account.incomingUrl, mediaUrl, to, account.allowInsecureSsl)) {throw new Error("Failed to send media to Synology Chat");}
				return {
					channel: CHANNEL_ID,
					messageId: `sc-${Date.now()}`,
					chatId: to
				};
			}
		},
		gateway: {
			startAccount: async (ctx) => {
				const { cfg, accountId, log } = ctx;
				const account = resolveAccount(cfg, accountId);
				if (!account.enabled) {
					log?.info?.(`Synology Chat account ${accountId} is disabled, skipping`);
					return waitUntilAbort(ctx.abortSignal);
				}
				if (!account.token || !account.incomingUrl) {
					log?.warn?.(`Synology Chat account ${accountId} not fully configured (missing token or incomingUrl)`);
					return waitUntilAbort(ctx.abortSignal);
				}
				if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
					log?.warn?.(`Synology Chat account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`);
					return waitUntilAbort(ctx.abortSignal);
				}
				log?.info?.(`Starting Synology Chat channel (account: ${accountId}, path: ${account.webhookPath})`);
				const handler = createWebhookHandler({
					account,
					deliver: async (msg) => {
						const rt = getSynologyRuntime();
						const currentCfg = await rt.config.loadConfig();
						const sendUserId = msg.chatUserId ?? msg.from;
						const msgCtx = rt.channel.reply.finalizeInboundContext({
							Body: msg.body,
							RawBody: msg.body,
							CommandBody: msg.body,
							From: `synology-chat:${msg.from}`,
							To: `synology-chat:${msg.from}`,
							SessionKey: msg.sessionKey,
							AccountId: account.accountId,
							OriginatingChannel: CHANNEL_ID,
							OriginatingTo: `synology-chat:${msg.from}`,
							ChatType: msg.chatType,
							SenderName: msg.senderName,
							SenderId: msg.from,
							Provider: CHANNEL_ID,
							Surface: CHANNEL_ID,
							ConversationLabel: msg.senderName || msg.from,
							Timestamp: Date.now(),
							CommandAuthorized: msg.commandAuthorized
						});
						await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
							ctx: msgCtx,
							cfg: currentCfg,
							dispatcherOptions: {
								deliver: async (payload) => {
									const text = payload?.text ?? payload?.body;
									if (text) {await sendMessage(account.incomingUrl, text, sendUserId, account.allowInsecureSsl);}
								},
								onReplyStart: () => {
									log?.info?.(`Agent reply started for ${msg.from}`);
								}
							}
						});
						return null;
					},
					log
				});
				const routeKey = `${accountId}:${account.webhookPath}`;
				const prevUnregister = activeRouteUnregisters.get(routeKey);
				if (prevUnregister) {
					log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
					prevUnregister();
					activeRouteUnregisters.delete(routeKey);
				}
				const unregister = registerPluginHttpRoute({
					path: account.webhookPath,
					auth: "plugin",
					replaceExisting: true,
					pluginId: CHANNEL_ID,
					accountId: account.accountId,
					log: (msg) => log?.info?.(msg),
					handler
				});
				activeRouteUnregisters.set(routeKey, unregister);
				log?.info?.(`Registered HTTP route: ${account.webhookPath} for Synology Chat`);
				return waitUntilAbort(ctx.abortSignal, () => {
					log?.info?.(`Stopping Synology Chat channel (account: ${accountId})`);
					if (typeof unregister === "function") {unregister();}
					activeRouteUnregisters.delete(routeKey);
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
		] }
	};
}
const synologyChatPlugin = createSynologyChatPlugin();
//#endregion
export { setSynologyRuntime as n, synologyChatPlugin as t };
