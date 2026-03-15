import { d as resolveThreadSessionKeys$1, g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { $t as createAccountListHelpers, Cn as BlockStreamingCoalesceSchema, D as createDedupeCache, En as DmPolicySchema, Fn as MarkdownConfigSchema, Mt as resolveDefaultGroupPolicy, Ot as evaluateSenderGroupAccessForPolicy, Pt as warnMissingProviderGroupPolicyFallbackOnce, Qn as requireOpenAllowFrom, _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, dr as applyAccountNameToChannelSection, fn as buildAccountScopedDmSecurityPolicy, fr as applySetupAccountConfigPatch, gn as deleteAccountFromConfigSection, jt as resolveAllowlistProviderRuntimeGroupPolicy, kn as GroupPolicySchema, pr as migrateBaseNameToDefaultAccount } from "./resolve-route-BZ4hHpx2.js";
import { c as normalizeSecretInputString, i as hasConfiguredSecretInput, s as normalizeResolvedSecretInputString } from "./types.secrets-apkw3WZr.js";
import { t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { $t as formatInboundFromLabel$1, $u as resolveChannelGroupRequireMention, Ao as createTypingCallbacks, At as resolveDmGroupAccessWithLists, Cl as formatDocsLink, Do as readRequestBodyWithLimit, Ds as loadSessionStore, Dt as DM_GROUP_ACCESS_REASON, Ed as rawDataToString, Io as logInboundDrop, It as registerPluginHttpRoute, Lo as logTypingFailure, Mo as createReplyPrefixOptions, Na as resolveChannelMediaMaxBytes, Ot as readStoreAllowFromForDmPolicy, Ps as parseStrictPositiveInteger, Ro as buildPendingHistoryContextFromMap, Su as getAgentScopedMediaLocalRoots, To as isRequestBodyLimitError, Vo as recordPendingHistoryEntryIfEnabled, Wt as resolveControlCommandGate, X as resolveStoredModelOverride, Xd as resolveClientIp, Yd as isTrustedProxyAddress, ao as createScopedPairingAccess, b as createPluginRuntimeStore, cn as buildModelsProviderData, co as buildAgentMediaPayload, dn as listSkillCommandsForAgents, jt as resolveEffectiveAllowFromLists, k as collectAllowlistProviderRestrictSendersWarnings, ko as buildSecretInputSchema, vp as createScopedAccountConfigAccessors, xt as formatNormalizedAllowFromEntries, zo as clearHistoryEntriesIfEnabled, zu as buildComputedAccountStatusSnapshot } from "./auth-profiles-CuJtivJK.js";
import { l as normalizeProviderId } from "./profiles-CV7WLKIX.js";
import { R as resolveStorePath } from "./query-expansion-txqQdNIf.js";
import { u as resolveAllowlistMatchSimple } from "./resolve-utils-BpDGEQsl.js";
import { a as loadOutboundMediaFromUrl } from "./compat-DDXNEdAm.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-CHxlFG8H.js";
import { n as buildPassiveProbedChannelStatusSummary } from "./channel-status-summary-C_aBM2lc.js";
import { t as requireChannelOpenAllowFrom } from "./config-schema-helpers-B9BKxgs0.js";
import { z } from "zod";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import WebSocket$1 from "ws";
//#region extensions/mattermost/src/config-schema.ts
const MattermostSlashCommandsSchema = z.object({
	native: z.union([z.boolean(), z.literal("auto")]).optional(),
	nativeSkills: z.union([z.boolean(), z.literal("auto")]).optional(),
	callbackPath: z.string().optional(),
	callbackUrl: z.string().optional()
}).strict().optional();
const MattermostAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	botToken: buildSecretInputSchema().optional(),
	baseUrl: z.string().optional(),
	chatmode: z.enum([
		"oncall",
		"onmessage",
		"onchar"
	]).optional(),
	oncharPrefixes: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	replyToMode: z.enum([
		"off",
		"first",
		"all"
	]).optional(),
	responsePrefix: z.string().optional(),
	actions: z.object({ reactions: z.boolean().optional() }).optional(),
	commands: MattermostSlashCommandsSchema,
	interactions: z.object({
		callbackBaseUrl: z.string().optional(),
		allowedSourceIps: z.array(z.string()).optional()
	}).optional()
}).strict();
const MattermostAccountSchema = MattermostAccountSchemaBase.superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "mattermost",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
const MattermostConfigSchema = MattermostAccountSchemaBase.extend({
	accounts: z.record(z.string(), MattermostAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "mattermost",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
//#endregion
//#region extensions/mattermost/src/mattermost/client.ts
function normalizeMattermostBaseUrl(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) {return;}
	return trimmed.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
}
function buildMattermostApiUrl(baseUrl, path) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) {throw new Error("Mattermost baseUrl is required");}
	return `${normalized}/api/v4${path.startsWith("/") ? path : `/${path}`}`;
}
async function readMattermostError(res) {
	if ((res.headers.get("content-type") ?? "").includes("application/json")) {
		const data = await res.json();
		if (data?.message) {return data.message;}
		return JSON.stringify(data);
	}
	return await res.text();
}
function createMattermostClient(params) {
	const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
	if (!baseUrl) {throw new Error("Mattermost baseUrl is required");}
	const apiBaseUrl = `${baseUrl}/api/v4`;
	const token = params.botToken.trim();
	const fetchImpl = params.fetchImpl ?? fetch;
	const request = async (path, init) => {
		const url = buildMattermostApiUrl(baseUrl, path);
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (typeof init?.body === "string" && !headers.has("Content-Type")) {headers.set("Content-Type", "application/json");}
		const res = await fetchImpl(url, {
			...init,
			headers
		});
		if (!res.ok) {
			const detail = await readMattermostError(res);
			throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
		}
		if (res.status === 204) {return;}
		if ((res.headers.get("content-type") ?? "").includes("application/json")) {return await res.json();}
		return await res.text();
	};
	return {
		baseUrl,
		apiBaseUrl,
		token,
		request
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
	if (parentId) {payload.parent_id = parentId;}
	await client.request("/users/me/typing", {
		method: "POST",
		body: JSON.stringify(payload)
	});
}
async function createMattermostDirectChannel(client, userIds) {
	return await client.request("/channels/direct", {
		method: "POST",
		body: JSON.stringify(userIds)
	});
}
async function createMattermostPost(client, params) {
	const payload = {
		channel_id: params.channelId,
		message: params.message
	};
	if (params.rootId) {payload.root_id = params.rootId;}
	if (params.fileIds?.length) {payload.file_ids = params.fileIds;}
	if (params.props) {payload.props = params.props;}
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
	if (params.message !== void 0) {payload.message = params.message;}
	if (params.props !== void 0) {payload.props = params.props;}
	return await client.request(`/posts/${postId}`, {
		method: "PUT",
		body: JSON.stringify(payload)
	});
}
async function uploadMattermostFile(client, params) {
	const form = new FormData();
	const fileName = params.fileName?.trim() || "upload";
	const bytes = Uint8Array.from(params.buffer);
	const blob = params.contentType ? new Blob([bytes], { type: params.contentType }) : new Blob([bytes]);
	form.append("files", blob, fileName);
	form.append("channel_id", params.channelId);
	const res = await fetch(`${client.apiBaseUrl}/files`, {
		method: "POST",
		headers: { Authorization: `Bearer ${client.token}` },
		body: form
	});
	if (!res.ok) {
		const detail = await readMattermostError(res);
		throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
	}
	const info = (await res.json()).file_infos?.[0];
	if (!info?.id) {throw new Error("Mattermost file upload failed");}
	return info;
}
//#endregion
//#region extensions/mattermost/src/mattermost/accounts.ts
const { listAccountIds: listMattermostAccountIds, resolveDefaultAccountId: resolveDefaultMattermostAccountId } = createAccountListHelpers("mattermost");
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.mattermost?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	return accounts[accountId];
}
function mergeMattermostAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = cfg.channels?.mattermost ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	const mergedCommands = {
		...base.commands,
		...account.commands
	};
	const merged = {
		...base,
		...account
	};
	if (Object.keys(mergedCommands).length > 0) {merged.commands = mergedCommands;}
	return merged;
}
function resolveMattermostRequireMention(config) {
	if (config.chatmode === "oncall") {return true;}
	if (config.chatmode === "onmessage") {return false;}
	if (config.chatmode === "onchar") {return true;}
	return config.requireMention;
}
function resolveMattermostAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
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
		name: merged.name?.trim() || void 0,
		botToken,
		baseUrl,
		botTokenSource,
		baseUrlSource,
		config: merged,
		chatmode: merged.chatmode,
		oncharPrefixes: merged.oncharPrefixes,
		requireMention,
		textChunkLimit: merged.textChunkLimit,
		blockStreaming: merged.blockStreaming,
		blockStreamingCoalesce: merged.blockStreamingCoalesce
	};
}
/**
* Resolve the effective replyToMode for a given chat type.
* Mattermost auto-threading only applies to channel and group messages.
*/
function resolveMattermostReplyToMode(account, kind) {
	if (kind === "direct") {return "off";}
	return account.config.replyToMode ?? "off";
}
//#endregion
//#region extensions/mattermost/src/group-mentions.ts
function resolveMattermostGroupRequireMention(params) {
	const account = resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const requireMentionOverride = typeof params.requireMentionOverride === "boolean" ? params.requireMentionOverride : account.requireMention;
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "mattermost",
		groupId: params.groupId,
		accountId: params.accountId,
		requireMentionOverride
	});
}
//#endregion
//#region extensions/mattermost/src/mattermost/directory.ts
function buildClient(params) {
	const account = resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.enabled || !account.botToken || !account.baseUrl) {return null;}
	return createMattermostClient({
		baseUrl: account.baseUrl,
		botToken: account.botToken
	});
}
/**
* Build clients from ALL enabled accounts (deduplicated by token).
*
* We always scan every account because:
* - Private channels are only visible to bots that are members
* - The requesting agent's account may have an expired/invalid token
*
* This means a single healthy bot token is enough for directory discovery.
*/
function buildClients(params) {
	const accountIds = listMattermostAccountIds(params.cfg);
	const seen = /* @__PURE__ */ new Set();
	const clients = [];
	for (const id of accountIds) {
		const client = buildClient({
			cfg: params.cfg,
			accountId: id
		});
		if (client && !seen.has(client.token)) {
			seen.add(client.token);
			clients.push(client);
		}
	}
	return clients;
}
/**
* List channels (public + private) visible to any configured bot account.
*
* NOTE: Uses per_page=200 which covers most instances. Mattermost does not
* return a "has more" indicator, so very large instances (200+ channels per bot)
* may see incomplete results. Pagination can be added if needed.
*/
async function listMattermostDirectoryGroups(params) {
	const clients = buildClients(params);
	if (!clients.length) {return [];}
	const q = params.query?.trim().toLowerCase() || "";
	const seenIds = /* @__PURE__ */ new Set();
	const entries = [];
	for (const client of clients) {try {
		const me = await fetchMattermostMe(client);
		const channels = await client.request(`/users/${me.id}/channels?per_page=200`);
		for (const ch of channels) {
			if (ch.type !== "O" && ch.type !== "P") continue;
			if (seenIds.has(ch.id)) continue;
			if (q) {
				const name = (ch.name ?? "").toLowerCase();
				const display = (ch.display_name ?? "").toLowerCase();
				if (!name.includes(q) && !display.includes(q)) continue;
			}
			seenIds.add(ch.id);
			entries.push({
				kind: "group",
				id: `channel:${ch.id}`,
				name: ch.name ?? void 0,
				handle: ch.display_name ?? void 0
			});
		}
	} catch (err) {
		console.debug?.("[mattermost-directory] listGroups: skipping account:", err?.message);
		continue;
	}}
	return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
}
/**
* List team members as peer directory entries.
*
* Uses only the first available client since all bots in a team see the same
* user list (unlike channels where membership varies). Uses the first team
* returned — multi-team setups will only see members from that team.
*
* NOTE: per_page=200 for member listing; same pagination caveat as groups.
*/
async function listMattermostDirectoryPeers(params) {
	const clients = buildClients(params);
	if (!clients.length) {return [];}
	const client = clients[0];
	try {
		const me = await fetchMattermostMe(client);
		const teams = await client.request("/users/me/teams");
		if (!teams.length) {return [];}
		const teamId = teams[0].id;
		const q = params.query?.trim().toLowerCase() || "";
		let users;
		if (q) {users = await client.request("/users/search", {
			method: "POST",
			body: JSON.stringify({
				term: q,
				team_id: teamId
			})
		});}
		else {
			const userIds = (await client.request(`/teams/${teamId}/members?per_page=200`)).map((m) => m.user_id).filter((id) => id !== me.id);
			if (!userIds.length) {return [];}
			users = await client.request("/users/ids", {
				method: "POST",
				body: JSON.stringify(userIds)
			});
		}
		const entries = users.filter((u) => u.id !== me.id).map((u) => ({
			kind: "user",
			id: `user:${u.id}`,
			name: u.username ?? void 0,
			handle: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.nickname || void 0
		}));
		return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
	} catch (err) {
		console.debug?.("[mattermost-directory] listPeers failed:", err?.message);
		return [];
	}
}
//#endregion
//#region extensions/mattermost/src/runtime.ts
const { setRuntime: setMattermostRuntime, getRuntime: getMattermostRuntime } = createPluginRuntimeStore("Mattermost runtime not initialized");
//#endregion
//#region extensions/mattermost/src/mattermost/interactions.ts
const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 1e4;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";
const callbackUrls = /* @__PURE__ */ new Map();
function setInteractionCallbackUrl(accountId, url) {
	callbackUrls.set(accountId, url);
}
function resolveInteractionCallbackPath(accountId) {
	return `/mattermost/interactions/${accountId}`;
}
function isWildcardBindHost(rawHost) {
	const trimmed = rawHost.trim();
	if (!trimmed) {return false;}
	const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
function normalizeCallbackBaseUrl(baseUrl) {
	return baseUrl.trim().replace(/\/+$/, "");
}
function headerValue(value) {
	if (Array.isArray(value)) {return value[0]?.trim() || void 0;}
	return value?.trim() || void 0;
}
function isAllowedInteractionSource(params) {
	const { allowedSourceIps } = params;
	if (!allowedSourceIps?.length) {return true;}
	return isTrustedProxyAddress(resolveClientIp({
		remoteAddr: params.req.socket?.remoteAddress,
		forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
		realIp: headerValue(params.req.headers["x-real-ip"]),
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback
	}), allowedSourceIps);
}
/**
* Resolve the interaction callback URL for an account.
* Falls back to computing it from interactions.callbackBaseUrl or gateway host config.
*/
function computeInteractionCallbackUrl(accountId, cfg) {
	const path = resolveInteractionCallbackPath(accountId);
	const callbackBaseUrl = cfg?.interactions?.callbackBaseUrl?.trim() ?? cfg?.channels?.mattermost?.interactions?.callbackBaseUrl?.trim();
	if (callbackBaseUrl) {return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;}
	const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
	let host = cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost) ? cfg.gateway.customBindHost.trim() : "localhost";
	if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {host = `[${host}]`;}
	return `http://${host}:${port}${path}`;
}
/**
* Resolve the interaction callback URL for an account.
* Prefers the in-memory registered URL (set by the gateway monitor) so callers outside the
* monitor lifecycle can reuse the runtime-validated callback destination.
*/
function resolveInteractionCallbackUrl(accountId, cfg) {
	const cached = callbackUrls.get(accountId);
	if (cached) {return cached;}
	return computeInteractionCallbackUrl(accountId, cfg);
}
const interactionSecrets = /* @__PURE__ */ new Map();
let defaultInteractionSecret;
function deriveInteractionSecret(botToken) {
	return createHmac("sha256", "openclaw-mattermost-interactions").update(botToken).digest("hex");
}
function setInteractionSecret(accountIdOrBotToken, botToken) {
	if (typeof botToken === "string") {
		interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
		return;
	}
	defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}
function getInteractionSecret(accountId) {
	const scoped = accountId ? interactionSecrets.get(accountId) : void 0;
	if (scoped) {return scoped;}
	if (defaultInteractionSecret) {return defaultInteractionSecret;}
	if (interactionSecrets.size === 1) {
		const first = interactionSecrets.values().next().value;
		if (typeof first === "string") {return first;}
	}
	throw new Error("Interaction secret not initialized — call setInteractionSecret(accountId, botToken) first");
}
function canonicalizeInteractionContext(value) {
	if (Array.isArray(value)) {return value.map((item) => canonicalizeInteractionContext(item));}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== void 0).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
		return Object.fromEntries(entries);
	}
	return value;
}
function generateInteractionToken(context, accountId) {
	const secret = getInteractionSecret(accountId);
	const payload = JSON.stringify(canonicalizeInteractionContext(context));
	return createHmac("sha256", secret).update(payload).digest("hex");
}
function verifyInteractionToken(context, token, accountId) {
	const expected = generateInteractionToken(context, accountId);
	if (expected.length !== token.length) {return false;}
	return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
/**
* Build Mattermost `props.attachments` with interactive buttons.
*
* Each button includes an HMAC token in its integration context so the
* callback handler can verify the request originated from a legitimate
* button click (Mattermost's recommended security pattern).
*/
/**
* Sanitize a button ID so Mattermost's action router can match it.
* Mattermost uses the action ID in the URL path `/api/v4/posts/{id}/actions/{actionId}`
* and IDs containing hyphens or underscores break the server-side routing.
* See: https://github.com/mattermost/mattermost/issues/25747
*/
function sanitizeActionId(id) {
	return id.replace(/[-_]/g, "");
}
function buildButtonAttachments(params) {
	const actions = params.buttons.map((btn) => {
		const safeId = sanitizeActionId(btn.id);
		const context = {
			action_id: safeId,
			...btn.context
		};
		const token = generateInteractionToken(context, params.accountId);
		return {
			id: safeId,
			type: "button",
			name: btn.name,
			style: btn.style,
			integration: {
				url: params.callbackUrl,
				context: {
					...context,
					_token: token
				}
			}
		};
	});
	return [{
		text: params.text ?? "",
		actions
	}];
}
function buildButtonProps(params) {
	const buttons = params.buttons.flatMap((item) => Array.isArray(item) ? item : [item]).map((btn) => ({
		id: String(btn.id ?? btn.callback_data ?? "").trim(),
		name: String(btn.text ?? btn.name ?? btn.label ?? "").trim(),
		style: btn.style ?? "default",
		context: typeof btn.context === "object" && btn.context !== null ? {
			...btn.context,
			[SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId
		} : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId }
	})).filter((btn) => btn.id && btn.name);
	if (buttons.length === 0) {return;}
	return { attachments: buildButtonAttachments({
		callbackUrl: params.callbackUrl,
		accountId: params.accountId,
		buttons,
		text: params.text
	}) };
}
function readInteractionBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalBytes = 0;
		const timer = setTimeout(() => {
			req.destroy();
			reject(/* @__PURE__ */ new Error("Request body read timeout"));
		}, INTERACTION_BODY_TIMEOUT_MS);
		req.on("data", (chunk) => {
			totalBytes += chunk.length;
			if (totalBytes > INTERACTION_MAX_BODY_BYTES) {
				req.destroy();
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("Request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			clearTimeout(timer);
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
function createMattermostInteractionHandler(params) {
	const { client, accountId, log } = params;
	const core = getMattermostRuntime();
	return async (req, res) => {
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Method Not Allowed" }));
			return;
		}
		if (!isAllowedInteractionSource({
			req,
			allowedSourceIps: params.allowedSourceIps,
			trustedProxies: params.trustedProxies,
			allowRealIpFallback: params.allowRealIpFallback
		})) {
			log?.(`mattermost interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`);
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Forbidden origin" }));
			return;
		}
		let payload;
		try {
			const raw = await readInteractionBody(req);
			payload = JSON.parse(raw);
		} catch (err) {
			log?.(`mattermost interaction: failed to parse body: ${String(err)}`);
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Invalid request body" }));
			return;
		}
		const context = payload.context;
		if (!context) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing context" }));
			return;
		}
		const token = context._token;
		if (typeof token !== "string") {
			log?.("mattermost interaction: missing _token in context");
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing token" }));
			return;
		}
		const { _token, ...contextWithoutToken } = context;
		if (!verifyInteractionToken(contextWithoutToken, token, accountId)) {
			log?.("mattermost interaction: invalid _token");
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Invalid token" }));
			return;
		}
		const actionId = context.action_id;
		if (typeof actionId !== "string") {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing action_id in context" }));
			return;
		}
		const signedChannelId = typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string" ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim() : "";
		if (signedChannelId && signedChannelId !== payload.channel_id) {
			log?.(`mattermost interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`);
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Channel mismatch" }));
			return;
		}
		const userName = payload.user_name ?? payload.user_id;
		let originalMessage = "";
		let originalPost = null;
		let clickedButtonName = null;
		try {
			originalPost = await client.request(`/posts/${payload.post_id}`);
			const postChannelId = originalPost.channel_id?.trim();
			if (!postChannelId || postChannelId !== payload.channel_id) {
				log?.(`mattermost interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`);
				res.statusCode = 403;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Post/channel mismatch" }));
				return;
			}
			originalMessage = originalPost.message ?? "";
			const postAttachments = Array.isArray(originalPost?.props?.attachments) ? originalPost.props.attachments : [];
			for (const att of postAttachments) {
				const match = att.actions?.find((a) => a.id === actionId);
				if (match?.name) {
					clickedButtonName = match.name;
					break;
				}
			}
			if (clickedButtonName === null) {
				log?.(`mattermost interaction: action ${actionId} not found in post ${payload.post_id}`);
				res.statusCode = 403;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Unknown action" }));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Failed to validate interaction" }));
			return;
		}
		if (!originalPost) {
			log?.(`mattermost interaction: missing fetched post ${payload.post_id}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Failed to load interaction post" }));
			return;
		}
		log?.(`mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} post=${payload.post_id} channel=${payload.channel_id}`);
		if (params.authorizeButtonClick) {try {
			const authorization = await params.authorizeButtonClick({
				payload,
				post: originalPost
			});
			if (!authorization.ok) {
				res.statusCode = authorization.statusCode ?? 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(authorization.response ?? { ephemeral_text: "You are not allowed to use this action here." }));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: authorization failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Interaction authorization failed" }));
			return;
		}}
		if (params.handleInteraction) {try {
			const response = await params.handleInteraction({
				payload,
				userName,
				actionId,
				actionName: clickedButtonName,
				originalMessage,
				context: contextWithoutToken,
				post: originalPost
			});
			if (response !== null) {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(response));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: custom handler failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Interaction handler failed" }));
			return;
		}}
		try {
			const eventLabel = `Mattermost button click: action="${actionId}" by ${payload.user_name ?? payload.user_id} in channel ${payload.channel_id}`;
			const sessionKey = params.resolveSessionKey ? await params.resolveSessionKey({
				channelId: payload.channel_id,
				userId: payload.user_id,
				post: originalPost
			}) : `agent:main:mattermost:${accountId}:${payload.channel_id}`;
			core.system.enqueueSystemEvent(eventLabel, {
				sessionKey,
				contextKey: `mattermost:interaction:${payload.post_id}:${actionId}`
			});
		} catch (err) {
			log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
		}
		try {
			await updateMattermostPost(client, payload.post_id, {
				message: originalMessage,
				props: { attachments: [{ text: `✓ **${clickedButtonName}** selected by @${userName}` }] }
			});
		} catch (err) {
			log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
		}
		res.statusCode = 200;
		res.setHeader("Content-Type", "application/json");
		res.end("{}");
		if (params.dispatchButtonClick) {try {
			await params.dispatchButtonClick({
				channelId: payload.channel_id,
				userId: payload.user_id,
				userName,
				actionId,
				actionName: clickedButtonName,
				postId: payload.post_id,
				post: originalPost
			});
		} catch (err) {
			log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
		}}
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/model-picker.ts
const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
	providers: "mdlprov",
	list: "mdllist",
	select: "mdlsel",
	back: "mdlback"
};
function splitModelRef(modelRef) {
	const match = (modelRef?.trim())?.match(/^([^/]+)\/(.+)$/u);
	if (!match) {return null;}
	const provider = normalizeProviderId(match[1]);
	const model = match[2].trim();
	if (!provider || !model) {return null;}
	return {
		provider,
		model
	};
}
function normalizePage(value) {
	if (!Number.isFinite(value)) {return 1;}
	return Math.max(1, Math.floor(value));
}
function paginateItems(items, page, pageSize = MODELS_PAGE_SIZE) {
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
	const start = (safePage - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		page: safePage,
		totalPages,
		hasPrev: safePage > 1,
		hasNext: safePage < totalPages,
		totalItems: items.length
	};
}
function buildContext(state) {
	return {
		[MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true,
		...state
	};
}
function buildButtonId(state) {
	const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
	return `${ACTION_IDS[state.action]}${digest}`;
}
function buildButton(params) {
	const baseState = params.action === "providers" || params.action === "back" ? {
		action: params.action,
		ownerUserId: params.ownerUserId
	} : params.action === "list" ? {
		action: "list",
		ownerUserId: params.ownerUserId,
		provider: normalizeProviderId(params.provider ?? ""),
		page: normalizePage(params.page)
	} : {
		action: "select",
		ownerUserId: params.ownerUserId,
		provider: normalizeProviderId(params.provider ?? ""),
		page: normalizePage(params.page),
		model: String(params.model ?? "").trim()
	};
	return {
		id: buildButtonId(baseState),
		text: params.text,
		...params.style ? { style: params.style } : {},
		context: buildContext(baseState)
	};
}
function getProviderModels(data, provider) {
	return [...data.byProvider.get(normalizeProviderId(provider)) ?? /* @__PURE__ */ new Set()].toSorted();
}
function formatCurrentModelLine(currentModel) {
	const parsed = splitModelRef(currentModel);
	if (!parsed) {return "Current: default";}
	return `Current: ${parsed.provider}/${parsed.model}`;
}
function resolveMattermostModelPickerEntry(commandText) {
	const normalized = commandText.trim().replace(/\s+/g, " ");
	if (/^\/model$/i.test(normalized)) {return { kind: "summary" };}
	if (/^\/models$/i.test(normalized)) {return { kind: "providers" };}
	const providerMatch = normalized.match(/^\/models\s+(\S+)$/i);
	if (!providerMatch?.[1]) {return null;}
	return {
		kind: "models",
		provider: normalizeProviderId(providerMatch[1])
	};
}
function parseMattermostModelPickerContext(context) {
	if (!context || context[MATTERMOST_MODEL_PICKER_CONTEXT_KEY] !== true) {return null;}
	const ownerUserId = String(context.ownerUserId ?? "").trim();
	const action = String(context.action ?? "").trim();
	if (!ownerUserId) {return null;}
	if (action === "providers" || action === "back") {return {
		action,
		ownerUserId
	};}
	const provider = normalizeProviderId(String(context.provider ?? ""));
	const page = Number.parseInt(String(context.page ?? "1"), 10);
	if (!provider) {return null;}
	if (action === "list") {return {
		action,
		ownerUserId,
		provider,
		page: normalizePage(page)
	};}
	if (action === "select") {
		const model = String(context.model ?? "").trim();
		if (!model) {return null;}
		return {
			action,
			ownerUserId,
			provider,
			page: normalizePage(page),
			model
		};
	}
	return null;
}
function buildMattermostAllowedModelRefs(data) {
	const refs = /* @__PURE__ */ new Set();
	for (const provider of data.providers) {for (const model of data.byProvider.get(provider) ?? []) refs.add(`${provider}/${model}`);}
	return refs;
}
function resolveMattermostModelPickerCurrentModel(params) {
	const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	try {
		const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
		const sessionStore = params.skipCache ? loadSessionStore(storePath, { skipCache: true }) : loadSessionStore(storePath);
		const sessionEntry = sessionStore[params.route.sessionKey];
		const override = resolveStoredModelOverride({
			sessionEntry,
			sessionStore,
			sessionKey: params.route.sessionKey
		});
		if (!override?.model) {return fallback;}
		const provider = (override.provider || params.data.resolvedDefault.provider).trim();
		return provider ? `${provider}/${override.model}` : fallback;
	} catch {
		return fallback;
	}
}
function renderMattermostModelSummaryView(params) {
	return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			"Tap below to browse models, or use:",
			"/oc_model <provider/model> to switch",
			"/oc_model status for details"
		].join("\n"),
		buttons: [[buildButton({
			action: "providers",
			ownerUserId: params.ownerUserId,
			text: "Browse providers",
			style: "primary"
		})]]
	};
}
function renderMattermostProviderPickerView(params) {
	const currentProvider = splitModelRef(params.currentModel)?.provider;
	const rows = params.data.providers.map((provider) => [buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
		provider,
		page: 1,
		style: provider === currentProvider ? "primary" : "default"
	})]);
	return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			"Select a provider:"
		].join("\n"),
		buttons: rows
	};
}
function renderMattermostModelsPickerView(params) {
	const provider = normalizeProviderId(params.provider);
	const models = getProviderModels(params.data, provider);
	const current = splitModelRef(params.currentModel);
	if (models.length === 0) {return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			`Unknown provider: ${provider}`
		].join("\n"),
		buttons: [[buildButton({
			action: "back",
			ownerUserId: params.ownerUserId,
			text: "Back to providers"
		})]]
	};}
	const page = paginateItems(models, params.page);
	const rows = page.items.map((model) => {
		const isCurrent = current?.provider === provider && current.model === model;
		return [buildButton({
			action: "select",
			ownerUserId: params.ownerUserId,
			text: isCurrent ? `${model} [current]` : model,
			provider,
			model,
			page: page.page,
			style: isCurrent ? "primary" : "default"
		})];
	});
	const navRow = [];
	if (page.hasPrev) {navRow.push(buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: "Prev",
		provider,
		page: page.page - 1
	}));}
	if (page.hasNext) {navRow.push(buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: "Next",
		provider,
		page: page.page + 1
	}));}
	if (navRow.length > 0) {rows.push(navRow);}
	rows.push([buildButton({
		action: "back",
		ownerUserId: params.ownerUserId,
		text: "Back to providers"
	})]);
	return {
		text: [
			`Models (${provider}) - ${page.totalItems} available`,
			formatCurrentModelLine(params.currentModel),
			`Page ${page.page}/${page.totalPages}`,
			"Select a model to switch immediately."
		].join("\n"),
		buttons: rows
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-auth.ts
function normalizeMattermostAllowEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed) {return "";}
	if (trimmed === "*") {return "*";}
	return trimmed.replace(/^(mattermost|user):/i, "").replace(/^@/, "").toLowerCase();
}
function normalizeMattermostAllowList(entries) {
	const normalized = entries.map((entry) => normalizeMattermostAllowEntry(String(entry))).filter(Boolean);
	return Array.from(new Set(normalized));
}
function resolveMattermostEffectiveAllowFromLists(params) {
	return resolveEffectiveAllowFromLists({
		allowFrom: normalizeMattermostAllowList(params.allowFrom ?? []),
		groupAllowFrom: normalizeMattermostAllowList(params.groupAllowFrom ?? []),
		storeAllowFrom: normalizeMattermostAllowList(params.storeAllowFrom ?? []),
		dmPolicy: params.dmPolicy
	});
}
function isMattermostSenderAllowed(params) {
	const allowFrom = normalizeMattermostAllowList(params.allowFrom);
	if (allowFrom.length === 0) {return false;}
	return resolveAllowlistMatchSimple({
		allowFrom,
		senderId: normalizeMattermostAllowEntry(params.senderId),
		senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : void 0,
		allowNameMatching: params.allowNameMatching
	}).allowed;
}
function mapMattermostChannelKind(channelType) {
	const normalized = channelType?.trim().toUpperCase();
	if (normalized === "D") {return "direct";}
	if (normalized === "G" || normalized === "P") {return "group";}
	return "channel";
}
function authorizeMattermostCommandInvocation(params) {
	const { account, cfg, senderId, senderName, channelId, channelInfo, storeAllowFrom, allowTextCommands, hasControlCommand } = params;
	if (!channelInfo) {return {
		ok: false,
		denyReason: "unknown-channel",
		commandAuthorized: false,
		channelInfo: null,
		kind: "channel",
		chatType: "channel",
		channelName: "",
		channelDisplay: "",
		roomLabel: `#${channelId}`
	};}
	const kind = mapMattermostChannelKind(channelInfo.type);
	const chatType = kind;
	const channelName = channelInfo.name ?? "";
	const channelDisplay = channelInfo.display_name ?? channelName;
	const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
	const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const configAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
	const configGroupAllowFrom = normalizeMattermostAllowList(account.config.groupAllowFrom ?? []);
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveMattermostEffectiveAllowFromLists({
		allowFrom: configAllowFrom,
		groupAllowFrom: configGroupAllowFrom,
		storeAllowFrom: normalizeMattermostAllowList(storeAllowFrom ?? []),
		dmPolicy
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : configAllowFrom;
	const commandGroupAllowFrom = kind === "direct" ? effectiveGroupAllowFrom : configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;
	const senderAllowedForCommands = isMattermostSenderAllowed({
		senderId,
		senderName,
		allowFrom: commandDmAllowFrom,
		allowNameMatching
	});
	const groupAllowedForCommands = isMattermostSenderAllowed({
		senderId,
		senderName,
		allowFrom: commandGroupAllowFrom,
		allowNameMatching
	});
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: senderAllowedForCommands
		}, {
			configured: commandGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands,
		hasControlCommand: allowTextCommands && hasControlCommand
	});
	const commandAuthorized = kind === "direct" ? dmPolicy === "open" || senderAllowedForCommands : commandGate.commandAuthorized;
	if (kind === "direct") {
		if (dmPolicy === "disabled") {return {
			ok: false,
			denyReason: "dm-disabled",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
		if (dmPolicy !== "open" && !senderAllowedForCommands) {return {
			ok: false,
			denyReason: dmPolicy === "pairing" ? "dm-pairing" : "unauthorized",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
	} else {
		const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
			groupPolicy,
			groupAllowFrom: effectiveGroupAllowFrom,
			senderId,
			isSenderAllowed: (_senderId, allowFrom) => isMattermostSenderAllowed({
				senderId,
				senderName,
				allowFrom,
				allowNameMatching
			})
		});
		if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {return {
			ok: false,
			denyReason: "channels-disabled",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
		if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {return {
			ok: false,
			denyReason: "channel-no-allowlist",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
		if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {return {
			ok: false,
			denyReason: "unauthorized",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
		if (commandGate.shouldBlock) {return {
			ok: false,
			denyReason: "unauthorized",
			commandAuthorized: false,
			channelInfo,
			kind,
			chatType,
			channelName,
			channelDisplay,
			roomLabel
		};}
	}
	return {
		ok: true,
		commandAuthorized,
		channelInfo,
		kind,
		chatType,
		channelName,
		channelDisplay,
		roomLabel
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-helpers.ts
const formatInboundFromLabel = formatInboundFromLabel$1;
function resolveThreadSessionKeys(params) {
	return resolveThreadSessionKeys$1({
		...params,
		normalizeThreadId: (threadId) => threadId
	});
}
/**
* Strip bot mention from message text while preserving newlines and
* block-level Markdown formatting (headings, lists, blockquotes).
*/
function normalizeMention(text, mention) {
	if (!mention) {return text.trim();}
	const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const hasMentionRe = new RegExp(`@${escaped}\\b`, "i");
	const leadingMentionRe = new RegExp(`^([\\t ]*)@${escaped}\\b[\\t ]*`, "i");
	const trailingMentionRe = new RegExp(`[\\t ]*@${escaped}\\b[\\t ]*$`, "i");
	const normalizedLines = text.split("\n").map((line) => {
		const hadMention = hasMentionRe.test(line);
		const normalizedLine = line.replace(leadingMentionRe, "$1").replace(trailingMentionRe, "").replace(new RegExp(`@${escaped}\\b`, "gi"), "").replace(/(\S)[ \t]{2,}/g, "$1 ");
		return {
			text: normalizedLine,
			mentionOnlyBlank: hadMention && normalizedLine.trim() === ""
		};
	});
	while (normalizedLines[0]?.mentionOnlyBlank) {normalizedLines.shift();}
	while (normalizedLines.at(-1)?.text.trim() === "") {normalizedLines.pop();}
	return normalizedLines.map((line) => line.text).join("\n");
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-onchar.ts
const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
function resolveOncharPrefixes(prefixes) {
	const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
	return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}
function stripOncharPrefix(text, prefixes) {
	const trimmed = text.trimStart();
	for (const prefix of prefixes) {
		if (!prefix) {continue;}
		if (trimmed.startsWith(prefix)) {return {
			triggered: true,
			stripped: trimmed.slice(prefix.length).trimStart()
		};}
	}
	return {
		triggered: false,
		stripped: text
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-websocket.ts
var WebSocketClosedBeforeOpenError = class extends Error {
	constructor(code, reason) {
		super(`websocket closed before open (code ${code})`);
		this.code = code;
		this.reason = reason;
		this.name = "WebSocketClosedBeforeOpenError";
	}
};
const defaultMattermostWebSocketFactory = (url) => new WebSocket$1(url);
function parsePostedPayload(payload) {
	if (payload.event !== "posted") {return null;}
	const postData = payload.data?.post;
	if (!postData) {return null;}
	let post = null;
	if (typeof postData === "string") {try {
		post = JSON.parse(postData);
	} catch {
		return null;
	}}
	else if (typeof postData === "object") {post = postData;}
	if (!post) {return null;}
	return {
		payload,
		post
	};
}
function createMattermostConnectOnce(opts) {
	const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
	return async () => {
		const ws = webSocketFactory(opts.wsUrl);
		const onAbort = () => ws.terminate();
		opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await new Promise((resolve, reject) => {
				let opened = false;
				let settled = false;
				const resolveOnce = () => {
					if (settled) {return;}
					settled = true;
					resolve();
				};
				const rejectOnce = (error) => {
					if (settled) {return;}
					settled = true;
					reject(error);
				};
				ws.on("open", () => {
					opened = true;
					opts.statusSink?.({
						connected: true,
						lastConnectedAt: Date.now(),
						lastError: null
					});
					ws.send(JSON.stringify({
						seq: opts.nextSeq(),
						action: "authentication_challenge",
						data: { token: opts.botToken }
					}));
				});
				ws.on("message", async (data) => {
					const raw = rawDataToString(data);
					let payload;
					try {
						payload = JSON.parse(raw);
					} catch {
						return;
					}
					if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
						if (!opts.onReaction) {return;}
						try {
							await opts.onReaction(payload);
						} catch (err) {
							opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
						}
						return;
					}
					if (payload.event !== "posted") {return;}
					const parsed = parsePostedPayload(payload);
					if (!parsed) {return;}
					try {
						await opts.onPosted(parsed.post, parsed.payload);
					} catch (err) {
						opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
					}
				});
				ws.on("close", (code, reason) => {
					const message = reasonToString(reason);
					opts.statusSink?.({
						connected: false,
						lastDisconnect: {
							at: Date.now(),
							status: code,
							error: message || void 0
						}
					});
					if (opened) {
						resolveOnce();
						return;
					}
					rejectOnce(new WebSocketClosedBeforeOpenError(code, message || void 0));
				});
				ws.on("error", (err) => {
					opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
					opts.statusSink?.({ lastError: String(err) });
					try {
						ws.close();
					} catch {}
				});
			});
		} finally {
			opts.abortSignal?.removeEventListener("abort", onAbort);
		}
	};
}
function reasonToString(reason) {
	if (!reason) {return "";}
	if (typeof reason === "string") {return reason;}
	return reason.length > 0 ? reason.toString("utf8") : "";
}
//#endregion
//#region extensions/mattermost/src/mattermost/reconnect.ts
/**
* Reconnection loop with exponential backoff.
*
* Calls `connectFn` in a while loop. On normal resolve (connection closed),
* the backoff resets. On thrown error (connection failed), the current delay is
* used, then doubled for the next retry.
* The loop exits when `abortSignal` fires.
*/
async function runWithReconnect(connectFn, opts = {}) {
	const { initialDelayMs = 2e3, maxDelayMs = 6e4 } = opts;
	const jitterRatio = Math.max(0, opts.jitterRatio ?? 0);
	const random = opts.random ?? Math.random;
	let retryDelay = initialDelayMs;
	let attempt = 0;
	while (!opts.abortSignal?.aborted) {
		let shouldIncreaseDelay = false;
		let outcome = "resolved";
		let error;
		try {
			await connectFn();
			retryDelay = initialDelayMs;
		} catch (err) {
			if (opts.abortSignal?.aborted) {return;}
			outcome = "rejected";
			error = err;
			opts.onError?.(err);
			shouldIncreaseDelay = true;
		}
		if (opts.abortSignal?.aborted) {return;}
		const delayMs = withJitter(retryDelay, jitterRatio, random);
		if (!(opts.shouldReconnect?.({
			attempt,
			delayMs,
			outcome,
			error
		}) ?? true)) {return;}
		opts.onReconnect?.(delayMs);
		await sleepAbortable(delayMs, opts.abortSignal);
		if (shouldIncreaseDelay) {retryDelay = Math.min(retryDelay * 2, maxDelayMs);}
		attempt++;
	}
}
function withJitter(baseMs, jitterRatio, random) {
	if (jitterRatio <= 0) {return baseMs;}
	const normalized = Math.max(0, Math.min(1, random()));
	const spread = baseMs * jitterRatio;
	return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}
function sleepAbortable(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region extensions/mattermost/src/mattermost/reply-delivery.ts
async function deliverMattermostReplyPayload(params) {
	const mediaUrls = params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []);
	const text = params.core.channel.text.convertMarkdownTables(params.payload.text ?? "", params.tableMode);
	if (mediaUrls.length === 0) {
		const chunkMode = params.core.channel.text.resolveChunkMode(params.cfg, "mattermost", params.accountId);
		const chunks = params.core.channel.text.chunkMarkdownTextWithMode(text, params.textLimit, chunkMode);
		for (const chunk of chunks.length > 0 ? chunks : [text]) {
			if (!chunk) {continue;}
			await params.sendMessage(params.to, chunk, {
				accountId: params.accountId,
				replyToId: params.replyToId
			});
		}
		return;
	}
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
	let first = true;
	for (const mediaUrl of mediaUrls) {
		const caption = first ? text : "";
		first = false;
		await params.sendMessage(params.to, caption, {
			accountId: params.accountId,
			mediaUrl,
			mediaLocalRoots,
			replyToId: params.replyToId
		});
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/target-resolution.ts
const mattermostOpaqueTargetCache = /* @__PURE__ */ new Map();
function cacheKey$1(baseUrl, token, id) {
	return `${baseUrl}::${token}::${id}`;
}
/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
function isMattermostId(value) {
	return /^[a-z0-9]{26}$/.test(value);
}
function isExplicitMattermostTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return false;}
	return /^(channel|user|mattermost):/i.test(trimmed) || trimmed.startsWith("@") || trimmed.startsWith("#");
}
function parseMattermostApiStatus(err) {
	if (!err || typeof err !== "object") {return;}
	const msg = "message" in err ? String(err.message ?? "") : "";
	const match = /Mattermost API (\d{3})\b/.exec(msg);
	if (!match) {return;}
	const code = Number(match[1]);
	return Number.isFinite(code) ? code : void 0;
}
async function resolveMattermostOpaqueTarget(params) {
	const input = params.input.trim();
	if (!input || isExplicitMattermostTarget(input) || !isMattermostId(input)) {return null;}
	const account = params.cfg && (!params.token || !params.baseUrl) ? resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}) : null;
	const token = params.token?.trim() || account?.botToken?.trim();
	const baseUrl = normalizeMattermostBaseUrl(params.baseUrl ?? account?.baseUrl);
	if (!token || !baseUrl) {return null;}
	const key = cacheKey$1(baseUrl, token, input);
	const cached = mattermostOpaqueTargetCache.get(key);
	if (cached === true) {return {
		kind: "user",
		id: input,
		to: `user:${input}`
	};}
	if (cached === false) {return {
		kind: "channel",
		id: input,
		to: `channel:${input}`
	};}
	const client = createMattermostClient({
		baseUrl,
		botToken: token
	});
	try {
		await fetchMattermostUser(client, input);
		mattermostOpaqueTargetCache.set(key, true);
		return {
			kind: "user",
			id: input,
			to: `user:${input}`
		};
	} catch (err) {
		if (parseMattermostApiStatus(err) === 404) {mattermostOpaqueTargetCache.set(key, false);}
		return {
			kind: "channel",
			id: input,
			to: `channel:${input}`
		};
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/send.ts
const botUserCache = /* @__PURE__ */ new Map();
const userByNameCache = /* @__PURE__ */ new Map();
const channelByNameCache = /* @__PURE__ */ new Map();
const dmChannelCache = /* @__PURE__ */ new Map();
const getCore = () => getMattermostRuntime();
function cacheKey(baseUrl, token) {
	return `${baseUrl}::${token}`;
}
function normalizeMessage(text, mediaUrl) {
	return [text.trim(), mediaUrl?.trim()].filter(Boolean).join("\n");
}
function isHttpUrl(value) {
	return /^https?:\/\//i.test(value);
}
function parseMattermostTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {throw new Error("Recipient is required for Mattermost sends");}
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("channel:")) {
		const id = trimmed.slice(8).trim();
		if (!id) {throw new Error("Channel id is required for Mattermost sends");}
		if (id.startsWith("#")) {
			const name = id.slice(1).trim();
			if (!name) {throw new Error("Channel name is required for Mattermost sends");}
			return {
				kind: "channel-name",
				name
			};
		}
		if (!isMattermostId(id)) {return {
			kind: "channel-name",
			name: id
		};}
		return {
			kind: "channel",
			id
		};
	}
	if (lower.startsWith("user:")) {
		const id = trimmed.slice(5).trim();
		if (!id) {throw new Error("User id is required for Mattermost sends");}
		return {
			kind: "user",
			id
		};
	}
	if (lower.startsWith("mattermost:")) {
		const id = trimmed.slice(11).trim();
		if (!id) {throw new Error("User id is required for Mattermost sends");}
		return {
			kind: "user",
			id
		};
	}
	if (trimmed.startsWith("@")) {
		const username = trimmed.slice(1).trim();
		if (!username) {throw new Error("Username is required for Mattermost sends");}
		return {
			kind: "user",
			username
		};
	}
	if (trimmed.startsWith("#")) {
		const name = trimmed.slice(1).trim();
		if (!name) {throw new Error("Channel name is required for Mattermost sends");}
		return {
			kind: "channel-name",
			name
		};
	}
	if (!isMattermostId(trimmed)) {return {
		kind: "channel-name",
		name: trimmed
	};}
	return {
		kind: "channel",
		id: trimmed
	};
}
async function resolveBotUser(baseUrl, token) {
	const key = cacheKey(baseUrl, token);
	const cached = botUserCache.get(key);
	if (cached) {return cached;}
	const user = await fetchMattermostMe(createMattermostClient({
		baseUrl,
		botToken: token
	}));
	botUserCache.set(key, user);
	return user;
}
async function resolveUserIdByUsername(params) {
	const { baseUrl, token, username } = params;
	const key = `${cacheKey(baseUrl, token)}::${username.toLowerCase()}`;
	const cached = userByNameCache.get(key);
	if (cached?.id) {return cached.id;}
	const user = await fetchMattermostUserByUsername(createMattermostClient({
		baseUrl,
		botToken: token
	}), username);
	userByNameCache.set(key, user);
	return user.id;
}
async function resolveChannelIdByName(params) {
	const { baseUrl, token, name } = params;
	const key = `${cacheKey(baseUrl, token)}::channel::${name.toLowerCase()}`;
	const cached = channelByNameCache.get(key);
	if (cached) {return cached;}
	const client = createMattermostClient({
		baseUrl,
		botToken: token
	});
	const teams = await fetchMattermostUserTeams(client, (await fetchMattermostMe(client)).id);
	for (const team of teams) {try {
		const channel = await fetchMattermostChannelByName(client, team.id, name);
		if (channel?.id) {
			channelByNameCache.set(key, channel.id);
			return channel.id;
		}
	} catch {}}
	throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}
async function resolveTargetChannelId(params) {
	if (params.target.kind === "channel") {return params.target.id;}
	if (params.target.kind === "channel-name") {return await resolveChannelIdByName({
		baseUrl: params.baseUrl,
		token: params.token,
		name: params.target.name
	});}
	const userId = params.target.id ? params.target.id : await resolveUserIdByUsername({
		baseUrl: params.baseUrl,
		token: params.token,
		username: params.target.username ?? ""
	});
	const dmKey = `${cacheKey(params.baseUrl, params.token)}::dm::${userId}`;
	const cachedDm = dmChannelCache.get(dmKey);
	if (cachedDm) {return cachedDm;}
	const botUser = await resolveBotUser(params.baseUrl, params.token);
	const channel = await createMattermostDirectChannel(createMattermostClient({
		baseUrl: params.baseUrl,
		botToken: params.token
	}), [botUser.id, userId]);
	dmChannelCache.set(dmKey, channel.id);
	return channel.id;
}
async function resolveMattermostSendContext(to, opts = {}) {
	const core = getCore();
	const cfg = opts.cfg ?? core.config.loadConfig();
	const account = resolveMattermostAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = opts.botToken?.trim() || account.botToken?.trim();
	if (!token) {throw new Error(`Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`);}
	const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
	if (!baseUrl) {throw new Error(`Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`);}
	const trimmedTo = to?.trim() ?? "";
	const opaqueTarget = await resolveMattermostOpaqueTarget({
		input: trimmedTo,
		token,
		baseUrl
	});
	const channelId = await resolveTargetChannelId({
		target: opaqueTarget?.kind === "user" ? {
			kind: "user",
			id: opaqueTarget.id
		} : opaqueTarget?.kind === "channel" ? {
			kind: "channel",
			id: opaqueTarget.id
		} : parseMattermostTarget(trimmedTo),
		baseUrl,
		token
	});
	return {
		cfg,
		accountId: account.accountId,
		token,
		baseUrl,
		channelId
	};
}
async function sendMessageMattermost(to, text, opts = {}) {
	const core = getCore();
	const logger = core.logging.getChildLogger({ module: "mattermost" });
	const { cfg, accountId, token, baseUrl, channelId } = await resolveMattermostSendContext(to, opts);
	const client = createMattermostClient({
		baseUrl,
		botToken: token
	});
	let props = opts.props;
	if (!props && Array.isArray(opts.buttons) && opts.buttons.length > 0) {
		setInteractionSecret(accountId, token);
		props = buildButtonProps({
			callbackUrl: resolveInteractionCallbackUrl(accountId, {
				gateway: cfg.gateway,
				interactions: resolveMattermostAccount({
					cfg,
					accountId
				}).config?.interactions
			}),
			accountId,
			channelId,
			buttons: opts.buttons,
			text: opts.attachmentText
		});
	}
	let message = text?.trim() ?? "";
	let fileIds;
	let uploadError;
	const mediaUrl = opts.mediaUrl?.trim();
	if (mediaUrl) {try {
		const media = await loadOutboundMediaFromUrl(mediaUrl, { mediaLocalRoots: opts.mediaLocalRoots });
		fileIds = [(await uploadMattermostFile(client, {
			channelId,
			buffer: media.buffer,
			fileName: media.fileName ?? "upload",
			contentType: media.contentType ?? void 0
		})).id];
	} catch (err) {
		uploadError = err instanceof Error ? err : new Error(String(err));
		if (core.logging.shouldLogVerbose()) logger.debug?.(`mattermost send: media upload failed, falling back to URL text: ${String(err)}`);
		message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
	}}
	if (message) {
		const tableMode = core.channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "mattermost",
			accountId
		});
		message = core.channel.text.convertMarkdownTables(message, tableMode);
	}
	if (!message && (!fileIds || fileIds.length === 0)) {
		if (uploadError) {throw new Error(`Mattermost media upload failed: ${uploadError.message}`);}
		throw new Error("Mattermost message is empty");
	}
	const post = await createMattermostPost(client, {
		channelId,
		message,
		rootId: opts.replyToId,
		fileIds,
		props
	});
	core.channel.activity.record({
		channel: "mattermost",
		accountId,
		direction: "outbound"
	});
	return {
		messageId: post.id ?? "unknown",
		channelId
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/slash-commands.ts
/**
* Built-in OpenClaw commands to register as native slash commands.
* These mirror the text-based commands already handled by the gateway.
*/
const DEFAULT_COMMAND_SPECS = [
	{
		trigger: "oc_status",
		originalName: "status",
		description: "Show session status (model, usage, uptime)",
		autoComplete: true
	},
	{
		trigger: "oc_model",
		originalName: "model",
		description: "View or change the current model",
		autoComplete: true,
		autoCompleteHint: "[model-name]"
	},
	{
		trigger: "oc_models",
		originalName: "models",
		description: "Browse available models",
		autoComplete: true,
		autoCompleteHint: "[provider]"
	},
	{
		trigger: "oc_new",
		originalName: "new",
		description: "Start a new conversation session",
		autoComplete: true
	},
	{
		trigger: "oc_help",
		originalName: "help",
		description: "Show available commands",
		autoComplete: true
	},
	{
		trigger: "oc_think",
		originalName: "think",
		description: "Set thinking/reasoning level",
		autoComplete: true,
		autoCompleteHint: "[off|low|medium|high]"
	},
	{
		trigger: "oc_reasoning",
		originalName: "reasoning",
		description: "Toggle reasoning mode",
		autoComplete: true,
		autoCompleteHint: "[on|off]"
	},
	{
		trigger: "oc_verbose",
		originalName: "verbose",
		description: "Toggle verbose mode",
		autoComplete: true,
		autoCompleteHint: "[on|off]"
	}
];
/**
* List existing custom slash commands for a team.
*/
async function listMattermostCommands(client, teamId) {
	return await client.request(`/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`);
}
/**
* Create a custom slash command on a Mattermost team.
*/
async function createMattermostCommand(client, params) {
	return await client.request("/commands", {
		method: "POST",
		body: JSON.stringify(params)
	});
}
/**
* Delete a custom slash command.
*/
async function deleteMattermostCommand(client, commandId) {
	await client.request(`/commands/${encodeURIComponent(commandId)}`, { method: "DELETE" });
}
/**
* Update an existing custom slash command.
*/
async function updateMattermostCommand(client, params) {
	return await client.request(`/commands/${encodeURIComponent(params.id)}`, {
		method: "PUT",
		body: JSON.stringify(params)
	});
}
/**
* Register all OpenClaw slash commands for a given team.
* Skips commands that are already registered with the same trigger + callback URL.
* Returns the list of newly created command IDs.
*/
async function registerSlashCommands(params) {
	const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
	const normalizedCreatorUserId = creatorUserId.trim();
	if (!normalizedCreatorUserId) {throw new Error("creatorUserId is required for slash command reconciliation");}
	let existing = [];
	try {
		existing = await listMattermostCommands(client, teamId);
	} catch (err) {
		log?.(`mattermost: failed to list existing commands: ${String(err)}`);
		throw err;
	}
	const existingByTrigger = /* @__PURE__ */ new Map();
	for (const cmd of existing) {
		const list = existingByTrigger.get(cmd.trigger) ?? [];
		list.push(cmd);
		existingByTrigger.set(cmd.trigger, list);
	}
	const registered = [];
	for (const spec of commands) {
		const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
		const ownedCommands = existingForTrigger.filter((cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId);
		const foreignCommands = existingForTrigger.filter((cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId);
		if (ownedCommands.length === 0 && foreignCommands.length > 0) {
			log?.(`mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`);
			continue;
		}
		if (ownedCommands.length > 1) {log?.(`mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`);}
		const existingCmd = ownedCommands[0];
		if (existingCmd && existingCmd.url === callbackUrl) {
			log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
			registered.push({
				id: existingCmd.id,
				trigger: spec.trigger,
				teamId,
				token: existingCmd.token,
				managed: false
			});
			continue;
		}
		if (existingCmd && existingCmd.url !== callbackUrl) {
			log?.(`mattermost: command /${spec.trigger} exists with different callback URL; updating (id=${existingCmd.id})`);
			try {
				const updated = await updateMattermostCommand(client, {
					id: existingCmd.id,
					team_id: teamId,
					trigger: spec.trigger,
					method: "P",
					url: callbackUrl,
					description: spec.description,
					auto_complete: spec.autoComplete,
					auto_complete_desc: spec.description,
					auto_complete_hint: spec.autoCompleteHint
				});
				registered.push({
					id: updated.id,
					trigger: spec.trigger,
					teamId,
					token: updated.token,
					managed: false
				});
				continue;
			} catch (err) {
				log?.(`mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(err)}`);
				try {
					await deleteMattermostCommand(client, existingCmd.id);
					log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
				} catch (deleteErr) {
					log?.(`mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(deleteErr)}`);
					continue;
				}
			}
		}
		try {
			const created = await createMattermostCommand(client, {
				team_id: teamId,
				trigger: spec.trigger,
				method: "P",
				url: callbackUrl,
				description: spec.description,
				auto_complete: spec.autoComplete,
				auto_complete_desc: spec.description,
				auto_complete_hint: spec.autoCompleteHint
			});
			log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
			registered.push({
				id: created.id,
				trigger: spec.trigger,
				teamId,
				token: created.token,
				managed: true
			});
		} catch (err) {
			log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
		}
	}
	return registered;
}
/**
* Clean up all registered slash commands.
*/
async function cleanupSlashCommands(params) {
	const { client, commands, log } = params;
	for (const cmd of commands) {
		if (!cmd.managed) {continue;}
		try {
			await deleteMattermostCommand(client, cmd.id);
			log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
		} catch (err) {
			log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
		}
	}
}
/**
* Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
*/
function parseSlashCommandPayload(body, contentType) {
	if (!body) {return null;}
	try {
		if (contentType?.includes("application/json")) {
			const parsed = JSON.parse(body);
			const token = typeof parsed.token === "string" ? parsed.token : "";
			const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
			const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
			const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
			const command = typeof parsed.command === "string" ? parsed.command : "";
			if (!token || !teamId || !channelId || !userId || !command) {return null;}
			return {
				token,
				team_id: teamId,
				team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : void 0,
				channel_id: channelId,
				channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : void 0,
				user_id: userId,
				user_name: typeof parsed.user_name === "string" ? parsed.user_name : void 0,
				command,
				text: typeof parsed.text === "string" ? parsed.text : "",
				trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : void 0,
				response_url: typeof parsed.response_url === "string" ? parsed.response_url : void 0
			};
		}
		const params = new URLSearchParams(body);
		const token = params.get("token");
		const teamId = params.get("team_id");
		const channelId = params.get("channel_id");
		const userId = params.get("user_id");
		const command = params.get("command");
		if (!token || !teamId || !channelId || !userId || !command) {return null;}
		return {
			token,
			team_id: teamId,
			team_domain: params.get("team_domain") ?? void 0,
			channel_id: channelId,
			channel_name: params.get("channel_name") ?? void 0,
			user_id: userId,
			user_name: params.get("user_name") ?? void 0,
			command,
			text: params.get("text") ?? "",
			trigger_id: params.get("trigger_id") ?? void 0,
			response_url: params.get("response_url") ?? void 0
		};
	} catch {
		return null;
	}
}
/**
* Map the trigger word back to the original OpenClaw command name.
* e.g. "oc_status" -> "/status", "oc_model" -> "/model"
*/
function resolveCommandText(trigger, text, triggerMap) {
	const commandName = triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
	const args = text.trim();
	return args ? `/${commandName} ${args}` : `/${commandName}`;
}
const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";
/**
* Ensure the callback path starts with a leading `/` to prevent
* malformed URLs like `http://host:portapi/...`.
*/
function normalizeCallbackPath(path) {
	const trimmed = path.trim();
	if (!trimmed) {return DEFAULT_CALLBACK_PATH;}
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function resolveSlashCommandConfig(raw) {
	return {
		native: raw?.native ?? "auto",
		nativeSkills: raw?.nativeSkills ?? "auto",
		callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
		callbackUrl: raw?.callbackUrl?.trim() || void 0
	};
}
function isSlashCommandsEnabled(config) {
	if (config.native === true) {return true;}
	if (config.native === false) {return false;}
	return false;
}
/**
* Build the callback URL that Mattermost will POST to when a command is invoked.
*/
function resolveCallbackUrl(params) {
	if (params.config.callbackUrl) {return params.config.callbackUrl;}
	const isWildcardBindHost = (rawHost) => {
		const trimmed = rawHost.trim();
		if (!trimmed) {return false;}
		const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
		return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
	};
	let host = params.gatewayHost && !isWildcardBindHost(params.gatewayHost) ? params.gatewayHost : "localhost";
	const path = normalizeCallbackPath(params.config.callbackPath);
	if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {host = `[${host}]`;}
	return `http://${host}:${params.gatewayPort}${path}`;
}
//#endregion
//#region extensions/mattermost/src/mattermost/slash-http.ts
const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5e3;
/**
* Read the full request body as a string.
*/
function readBody(req, maxBytes) {
	return readRequestBodyWithLimit(req, {
		maxBytes,
		timeoutMs: BODY_READ_TIMEOUT_MS
	});
}
function sendJsonResponse(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
async function authorizeSlashInvocation(params) {
	const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
	const core = getMattermostRuntime();
	let channelInfo = null;
	try {
		channelInfo = await fetchMattermostChannel(client, channelId);
	} catch (err) {
		log?.(`mattermost: slash channel lookup failed for ${channelId}: ${String(err)}`);
	}
	if (!channelInfo) {return {
		ok: false,
		denyResponse: {
			response_type: "ephemeral",
			text: "Temporary error: unable to determine channel type. Please try again."
		},
		commandAuthorized: false,
		channelInfo: null,
		kind: "channel",
		chatType: "channel",
		channelName: "",
		channelDisplay: "",
		roomLabel: `#${channelId}`
	};}
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg,
		surface: "mattermost"
	});
	const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
	const storeAllowFrom = normalizeMattermostAllowList(await core.channel.pairing.readAllowFromStore({
		channel: "mattermost",
		accountId: account.accountId
	}).catch(() => []));
	const decision = authorizeMattermostCommandInvocation({
		account,
		cfg,
		senderId,
		senderName,
		channelId,
		channelInfo,
		storeAllowFrom,
		allowTextCommands,
		hasControlCommand
	});
	if (!decision.ok) {
		if (decision.denyReason === "dm-pairing") {
			const { code } = await core.channel.pairing.upsertPairingRequest({
				channel: "mattermost",
				accountId: account.accountId,
				id: senderId,
				meta: { name: senderName }
			});
			return {
				...decision,
				denyResponse: {
					response_type: "ephemeral",
					text: core.channel.pairing.buildPairingReply({
						channel: "mattermost",
						idLine: `Your Mattermost user id: ${senderId}`,
						code
					})
				}
			};
		}
		const denyText = decision.denyReason === "unknown-channel" ? "Temporary error: unable to determine channel type. Please try again." : decision.denyReason === "dm-disabled" ? "This bot is not accepting direct messages." : decision.denyReason === "channels-disabled" ? "Slash commands are disabled in channels." : decision.denyReason === "channel-no-allowlist" ? "Slash commands are not configured for this channel (no allowlist)." : "Unauthorized.";
		return {
			...decision,
			denyResponse: {
				response_type: "ephemeral",
				text: denyText
			}
		};
	}
	return {
		...decision,
		denyResponse: void 0
	};
}
/**
* Create the HTTP request handler for Mattermost slash command callbacks.
*
* This handler is registered as a plugin HTTP route and receives POSTs
* from the Mattermost server when a user invokes a registered slash command.
*/
function createSlashCommandHttpHandler(params) {
	const { account, cfg, runtime, commandTokens, triggerMap, log } = params;
	return async (req, res) => {
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.end("Method Not Allowed");
			return;
		}
		let body;
		try {
			body = await readBody(req, MAX_BODY_BYTES);
		} catch (error) {
			if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
				res.statusCode = 408;
				res.end("Request body timeout");
				return;
			}
			res.statusCode = 413;
			res.end("Payload Too Large");
			return;
		}
		const contentType = req.headers["content-type"] ?? "";
		const payload = parseSlashCommandPayload(body, contentType);
		if (!payload) {
			sendJsonResponse(res, 400, {
				response_type: "ephemeral",
				text: "Invalid slash command payload."
			});
			return;
		}
		if (commandTokens.size === 0 || !commandTokens.has(payload.token)) {
			sendJsonResponse(res, 401, {
				response_type: "ephemeral",
				text: "Unauthorized: invalid command token."
			});
			return;
		}
		const trigger = payload.command.replace(/^\//, "").trim();
		const commandText = resolveCommandText(trigger, payload.text, triggerMap);
		const channelId = payload.channel_id;
		const senderId = payload.user_id;
		const senderName = payload.user_name ?? senderId;
		const client = createMattermostClient({
			baseUrl: account.baseUrl ?? "",
			botToken: account.botToken ?? ""
		});
		const auth = await authorizeSlashInvocation({
			account,
			cfg,
			client,
			commandText,
			channelId,
			senderId,
			senderName,
			log
		});
		if (!auth.ok) {
			sendJsonResponse(res, 200, auth.denyResponse ?? {
				response_type: "ephemeral",
				text: "Unauthorized."
			});
			return;
		}
		log?.(`mattermost: slash command /${trigger} from ${senderName} in ${channelId}`);
		sendJsonResponse(res, 200, {
			response_type: "ephemeral",
			text: "Processing..."
		});
		try {
			await handleSlashCommandAsync({
				account,
				cfg,
				runtime,
				client,
				commandText,
				channelId,
				senderId,
				senderName,
				teamId: payload.team_id,
				triggerId: payload.trigger_id,
				kind: auth.kind,
				chatType: auth.chatType,
				channelName: auth.channelName,
				channelDisplay: auth.channelDisplay,
				roomLabel: auth.roomLabel,
				commandAuthorized: auth.commandAuthorized,
				log
			});
		} catch (err) {
			log?.(`mattermost: slash command handler error: ${String(err)}`);
			try {
				await sendMessageMattermost(`channel:${channelId}`, "Sorry, something went wrong processing that command.", { accountId: account.accountId });
			} catch {}
		}
	};
}
async function handleSlashCommandAsync(params) {
	const { account, cfg, runtime, client, commandText, channelId, senderId, senderName, teamId, kind, chatType, channelName, channelDisplay, roomLabel, commandAuthorized, triggerId, log } = params;
	const core = getMattermostRuntime();
	const route = core.channel.routing.resolveAgentRoute({
		cfg,
		channel: "mattermost",
		accountId: account.accountId,
		teamId,
		peer: {
			kind,
			id: kind === "direct" ? senderId : channelId
		}
	});
	const fromLabel = kind === "direct" ? `Mattermost DM from ${senderName}` : `Mattermost message in ${roomLabel} from ${senderName}`;
	const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
	const pickerEntry = resolveMattermostModelPickerEntry(commandText);
	if (pickerEntry) {
		const data = await buildModelsProviderData(cfg, route.agentId);
		if (data.providers.length === 0) {
			await sendMessageMattermost(to, "No models available.", { accountId: account.accountId });
			return;
		}
		const currentModel = resolveMattermostModelPickerCurrentModel({
			cfg,
			route,
			data
		});
		const view = pickerEntry.kind === "summary" ? renderMattermostModelSummaryView({
			ownerUserId: senderId,
			currentModel
		}) : pickerEntry.kind === "providers" ? renderMattermostProviderPickerView({
			ownerUserId: senderId,
			data,
			currentModel
		}) : renderMattermostModelsPickerView({
			ownerUserId: senderId,
			data,
			provider: pickerEntry.provider,
			page: 1,
			currentModel
		});
		await sendMessageMattermost(to, view.text, {
			accountId: account.accountId,
			buttons: view.buttons
		});
		runtime.log?.(`delivered model picker to ${to}`);
		return;
	}
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: commandText,
		BodyForAgent: commandText,
		RawBody: commandText,
		CommandBody: commandText,
		From: kind === "direct" ? `mattermost:${senderId}` : kind === "group" ? `mattermost:group:${channelId}` : `mattermost:channel:${channelId}`,
		To: to,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: chatType,
		ConversationLabel: fromLabel,
		GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : void 0,
		SenderName: senderName,
		SenderId: senderId,
		Provider: "mattermost",
		Surface: "mattermost",
		MessageSid: triggerId ?? `slash-${Date.now()}`,
		Timestamp: Date.now(),
		WasMentioned: true,
		CommandAuthorized: commandAuthorized,
		CommandSource: "native",
		OriginatingChannel: "mattermost",
		OriginatingTo: to
	});
	const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "mattermost",
		accountId: account.accountId
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: route.agentId,
		channel: "mattermost",
		accountId: account.accountId
	});
	const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
	const typingCallbacks = createTypingCallbacks({
		start: () => sendMattermostTyping(client, { channelId }),
		onStartError: (err) => {
			logTypingFailure({
				log: (message) => log?.(message),
				channel: "mattermost",
				target: channelId,
				error: err
			});
		}
	});
	const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
		...prefixOptions,
		humanDelay,
		deliver: async (payload) => {
			await deliverMattermostReplyPayload({
				core,
				cfg,
				payload,
				to,
				accountId: account.accountId,
				agentId: route.agentId,
				textLimit,
				tableMode,
				sendMessage: sendMessageMattermost
			});
			runtime.log?.(`delivered slash reply to ${to}`);
		},
		onError: (err, info) => {
			runtime.error?.(`mattermost slash ${info.kind} reply failed: ${String(err)}`);
		},
		onReplyStart: typingCallbacks.onReplyStart
	});
	await core.channel.reply.withReplyDispatcher({
		dispatcher,
		onSettled: () => {
			markDispatchIdle();
		},
		run: () => core.channel.reply.dispatchReplyFromConfig({
			ctx: ctxPayload,
			cfg,
			dispatcher,
			replyOptions: {
				...replyOptions,
				disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
				onModelSelected
			}
		})
	});
}
//#endregion
//#region extensions/mattermost/src/mattermost/slash-state.ts
/** Map from accountId → per-account slash command state. */
const accountStates = /* @__PURE__ */ new Map();
function resolveSlashHandlerForToken(token) {
	const matches = [];
	for (const [accountId, state] of accountStates) {if (state.commandTokens.has(token) && state.handler) matches.push({
		accountId,
		handler: state.handler
	});}
	if (matches.length === 0) {return { kind: "none" };}
	if (matches.length === 1) {return {
		kind: "single",
		handler: matches[0].handler,
		accountIds: [matches[0].accountId]
	};}
	return {
		kind: "ambiguous",
		accountIds: matches.map((entry) => entry.accountId)
	};
}
/**
* Get the slash command state for a specific account, or null if not activated.
*/
function getSlashCommandState(accountId) {
	return accountStates.get(accountId) ?? null;
}
/**
* Activate slash commands for a specific account.
* Called from the monitor after bot connects.
*/
function activateSlashCommands(params) {
	const { account, commandTokens, registeredCommands, triggerMap, api, log } = params;
	const accountId = account.accountId;
	const tokenSet = new Set(commandTokens);
	const handler = createSlashCommandHttpHandler({
		account,
		cfg: api.cfg,
		runtime: api.runtime,
		commandTokens: tokenSet,
		triggerMap,
		log
	});
	accountStates.set(accountId, {
		commandTokens: tokenSet,
		registeredCommands,
		handler,
		account,
		triggerMap: triggerMap ?? /* @__PURE__ */ new Map()
	});
	log?.(`mattermost: slash commands activated for account ${accountId} (${registeredCommands.length} commands)`);
}
/**
* Deactivate slash commands for a specific account (on shutdown/disconnect).
*/
function deactivateSlashCommands(accountId) {
	if (accountId) {
		const state = accountStates.get(accountId);
		if (state) {
			state.commandTokens.clear();
			state.registeredCommands = [];
			state.handler = null;
			accountStates.delete(accountId);
		}
	} else {
		for (const [, state] of accountStates) {
			state.commandTokens.clear();
			state.registeredCommands = [];
			state.handler = null;
		}
		accountStates.clear();
	}
}
/**
* Register the HTTP route for slash command callbacks.
* Called during plugin registration.
*
* The single HTTP route dispatches to the correct per-account handler
* by matching the inbound token against each account's registered tokens.
*/
function registerSlashCommandRoute(api) {
	const mmConfig = api.config.channels?.mattermost;
	const callbackPaths = /* @__PURE__ */ new Set();
	const addCallbackPaths = (raw) => {
		const resolved = resolveSlashCommandConfig(raw);
		callbackPaths.add(resolved.callbackPath);
		if (resolved.callbackUrl) {try {
			const urlPath = new URL(resolved.callbackUrl).pathname;
			if (urlPath && urlPath !== resolved.callbackPath) callbackPaths.add(urlPath);
		} catch {}}
	};
	const commandsRaw = mmConfig?.commands;
	addCallbackPaths(commandsRaw);
	const accountsRaw = mmConfig?.accounts ?? {};
	for (const accountId of Object.keys(accountsRaw)) {
		const accountCommandsRaw = accountsRaw[accountId]?.commands;
		addCallbackPaths(accountCommandsRaw);
	}
	const routeHandler = async (req, res) => {
		if (accountStates.size === 0) {
			res.statusCode = 503;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: "Slash commands are not yet initialized. Please try again in a moment."
			}));
			return;
		}
		if (accountStates.size === 1) {
			const [, state] = [...accountStates.entries()][0];
			if (!state.handler) {
				res.statusCode = 503;
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify({
					response_type: "ephemeral",
					text: "Slash commands are not yet initialized. Please try again in a moment."
				}));
				return;
			}
			await state.handler(req, res);
			return;
		}
		const chunks = [];
		const MAX_BODY = 64 * 1024;
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY) {
				res.statusCode = 413;
				res.end("Payload Too Large");
				return;
			}
			chunks.push(chunk);
		}
		const bodyStr = Buffer.concat(chunks).toString("utf8");
		let token = null;
		const ct = req.headers["content-type"] ?? "";
		try {
			if (ct.includes("application/json")) {token = JSON.parse(bodyStr).token ?? null;}
			else {token = new URLSearchParams(bodyStr).get("token");}
		} catch {}
		const match = token ? resolveSlashHandlerForToken(token) : { kind: "none" };
		if (match.kind === "none") {
			res.statusCode = 401;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: "Unauthorized: invalid command token."
			}));
			return;
		}
		if (match.kind === "ambiguous") {
			api.logger.warn?.(`mattermost: slash callback token matched multiple accounts (${match.accountIds?.join(", ")})`);
			res.statusCode = 409;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: "Conflict: command token is not unique across accounts."
			}));
			return;
		}
		const matchedHandler = match.handler;
		const { Readable } = await import("node:stream");
		const syntheticReq = new Readable({ read() {
			this.push(Buffer.from(bodyStr, "utf8"));
			this.push(null);
		} });
		syntheticReq.method = req.method;
		syntheticReq.url = req.url;
		syntheticReq.headers = req.headers;
		await matchedHandler(syntheticReq, res);
	};
	for (const callbackPath of callbackPaths) {
		api.registerHttpRoute({
			path: callbackPath,
			auth: "plugin",
			handler: routeHandler
		});
		api.logger.info?.(`mattermost: registered slash command callback at ${callbackPath}`);
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor.ts
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 6e4;
const RECENT_MATTERMOST_MESSAGE_MAX = 2e3;
const CHANNEL_CACHE_TTL_MS = 5 * 6e4;
const USER_CACHE_TTL_MS = 10 * 6e4;
function isLoopbackHost(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function normalizeInteractionSourceIps(values) {
	return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
const recentInboundMessages = createDedupeCache({
	ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
	maxSize: RECENT_MATTERMOST_MESSAGE_MAX
});
function resolveRuntime(opts) {
	return opts.runtime ?? {
		log: console.log,
		error: console.error,
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}
function isSystemPost(post) {
	const type = post.type?.trim();
	return Boolean(type);
}
function mapMattermostChannelTypeToChatType(channelType) {
	if (!channelType) {return "channel";}
	const normalized = channelType.trim().toUpperCase();
	if (normalized === "D") {return "direct";}
	if (normalized === "G") {return "group";}
	if (normalized === "P") {return "group";}
	return "channel";
}
function channelChatType(kind) {
	if (kind === "direct") {return "direct";}
	if (kind === "group") {return "group";}
	return "channel";
}
function evaluateMattermostMentionGate(params) {
	const shouldRequireMention = params.kind !== "direct" && params.resolveRequireMention({
		cfg: params.cfg,
		channel: "mattermost",
		accountId: params.accountId,
		groupId: params.channelId,
		requireMentionOverride: params.requireMentionOverride
	});
	const shouldBypassMention = params.isControlCommand && shouldRequireMention && !params.wasMentioned && params.commandAuthorized;
	const effectiveWasMentioned = params.wasMentioned || shouldBypassMention || params.oncharTriggered;
	if (params.oncharEnabled && !params.oncharTriggered && !params.wasMentioned && !params.isControlCommand) {return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: "onchar-not-triggered"
	};}
	if (params.kind !== "direct" && shouldRequireMention && params.canDetectMention && !effectiveWasMentioned) {return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: "missing-mention"
	};}
	return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: null
	};
}
function resolveMattermostReplyRootId(params) {
	const threadRootId = params.threadRootId?.trim();
	if (threadRootId) {return threadRootId;}
	return params.replyToId?.trim() || void 0;
}
function resolveMattermostEffectiveReplyToId(params) {
	const threadRootId = params.threadRootId?.trim();
	if (threadRootId) {return threadRootId;}
	if (params.kind === "direct") {return;}
	const postId = params.postId?.trim();
	if (!postId) {return;}
	return params.replyToMode === "all" || params.replyToMode === "first" ? postId : void 0;
}
function resolveMattermostThreadSessionContext(params) {
	const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
		kind: params.kind,
		postId: params.postId,
		replyToMode: params.replyToMode,
		threadRootId: params.threadRootId
	});
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey: params.baseSessionKey,
		threadId: effectiveReplyToId,
		parentSessionKey: effectiveReplyToId ? params.baseSessionKey : void 0
	});
	return {
		effectiveReplyToId,
		sessionKey: threadKeys.sessionKey,
		parentSessionKey: threadKeys.parentSessionKey
	};
}
function buildMattermostAttachmentPlaceholder(mediaList) {
	if (mediaList.length === 0) {return "";}
	if (mediaList.length === 1) {return `<media:${mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind}>`;}
	const allImages = mediaList.every((media) => media.kind === "image");
	const label = allImages ? "image" : "file";
	const suffix = mediaList.length === 1 ? label : `${label}s`;
	return `${allImages ? "<media:image>" : "<media:document>"} (${mediaList.length} ${suffix})`;
}
function buildMattermostWsUrl(baseUrl) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) {throw new Error("Mattermost baseUrl is required");}
	return `${normalized.replace(/^http/i, "ws")}/api/v4/websocket`;
}
async function monitorMattermostProvider(opts = {}) {
	const core = getMattermostRuntime();
	const runtime = resolveRuntime(opts);
	const cfg = opts.config ?? core.config.loadConfig();
	const account = resolveMattermostAccount({
		cfg,
		accountId: opts.accountId
	});
	const pairing = createScopedPairingAccess({
		core,
		channel: "mattermost",
		accountId: account.accountId
	});
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const botToken = opts.botToken?.trim() || account.botToken?.trim();
	if (!botToken) {throw new Error(`Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`);}
	const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
	if (!baseUrl) {throw new Error(`Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`);}
	const client = createMattermostClient({
		baseUrl,
		botToken
	});
	const botUser = await fetchMattermostMe(client);
	const botUserId = botUser.id;
	const botUsername = botUser.username?.trim() || void 0;
	runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);
	const commandsRaw = account.config.commands;
	const slashConfig = resolveSlashCommandConfig(commandsRaw);
	const slashEnabled = isSlashCommandsEnabled(slashConfig);
	if (slashEnabled) {try {
		const teams = await fetchMattermostUserTeams(client, botUserId);
		const envPortRaw = process.env.OPENCLAW_GATEWAY_PORT?.trim();
		const slashCallbackUrl = resolveCallbackUrl({
			config: slashConfig,
			gatewayPort: parseStrictPositiveInteger(envPortRaw) ?? cfg.gateway?.port ?? 18789,
			gatewayHost: cfg.gateway?.customBindHost ?? void 0
		});
		try {
			const mmHost = new URL(baseUrl).hostname;
			const callbackHost = new URL(slashCallbackUrl).hostname;
			if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) runtime.error?.(`mattermost: slash commands callbackUrl resolved to ${slashCallbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`);
		} catch {}
		const commandsToRegister = [...DEFAULT_COMMAND_SPECS];
		if (slashConfig.nativeSkills === true) try {
			const skillCommands = listSkillCommandsForAgents({ cfg });
			for (const spec of skillCommands) {
				const name = typeof spec.name === "string" ? spec.name.trim() : "";
				if (!name) continue;
				const trigger = name.startsWith("oc_") ? name : `oc_${name}`;
				commandsToRegister.push({
					trigger,
					description: spec.description || `Run skill ${name}`,
					autoComplete: true,
					autoCompleteHint: "[args]",
					originalName: name
				});
			}
		} catch (err) {
			runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
		}
		const seen = /* @__PURE__ */ new Set();
		const dedupedCommands = commandsToRegister.filter((cmd) => {
			const key = cmd.trigger.trim();
			if (!key) return false;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		const allRegistered = [];
		let teamRegistrationFailures = 0;
		for (const team of teams) try {
			const registered = await registerSlashCommands({
				client,
				teamId: team.id,
				creatorUserId: botUserId,
				callbackUrl: slashCallbackUrl,
				commands: dedupedCommands,
				log: (msg) => runtime.log?.(msg)
			});
			allRegistered.push(...registered);
		} catch (err) {
			teamRegistrationFailures += 1;
			runtime.error?.(`mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`);
		}
		if (allRegistered.length === 0) runtime.error?.("mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive");
		else {
			if (teamRegistrationFailures > 0) runtime.error?.(`mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`);
			const triggerMap = /* @__PURE__ */ new Map();
			for (const cmd of dedupedCommands) if (cmd.originalName) triggerMap.set(cmd.trigger, cmd.originalName);
			activateSlashCommands({
				account,
				commandTokens: allRegistered.map((cmd) => cmd.token).filter(Boolean),
				registeredCommands: allRegistered,
				triggerMap,
				api: {
					cfg,
					runtime
				},
				log: (msg) => runtime.log?.(msg)
			});
			runtime.log?.(`mattermost: slash commands registered (${allRegistered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`);
		}
	} catch (err) {
		runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
	}}
	setInteractionSecret(account.accountId, botToken);
	const interactionPath = resolveInteractionCallbackPath(account.accountId);
	const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
		gateway: cfg.gateway,
		interactions: account.config.interactions
	});
	setInteractionCallbackUrl(account.accountId, callbackUrl);
	const allowedInteractionSourceIps = normalizeInteractionSourceIps(account.config.interactions?.allowedSourceIps);
	try {
		const mmHost = new URL(baseUrl).hostname;
		const callbackHost = new URL(callbackUrl).hostname;
		if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {runtime.error?.(`mattermost: interactions callbackUrl resolved to ${callbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If button clicks don't work, set channels.mattermost.interactions.callbackBaseUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`);}
		if (!isLoopbackHost(callbackHost) && allowedInteractionSourceIps.length === 0) {runtime.error?.(`mattermost: interactions callbackUrl resolved to ${callbackUrl} without channels.mattermost.interactions.allowedSourceIps. For safety, non-loopback callback sources will be rejected until you allowlist the Mattermost server or trusted ingress IPs.`);}
	} catch {}
	const effectiveInteractionSourceIps = allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"];
	const unregisterInteractions = registerPluginHttpRoute({
		path: interactionPath,
		fallbackPath: "/mattermost/interactions/default",
		auth: "plugin",
		handler: createMattermostInteractionHandler({
			client,
			botUserId,
			accountId: account.accountId,
			allowedSourceIps: effectiveInteractionSourceIps,
			trustedProxies: cfg.gateway?.trustedProxies,
			allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
			handleInteraction: handleModelPickerInteraction,
			authorizeButtonClick: async ({ payload, post }) => {
				const channelInfo = await resolveChannelInfo(payload.channel_id);
				const isDirect = channelInfo?.type?.trim().toUpperCase() === "D";
				const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
					cfg,
					surface: "mattermost"
				});
				const decision = authorizeMattermostCommandInvocation({
					account,
					cfg,
					senderId: payload.user_id,
					senderName: payload.user_name ?? "",
					channelId: payload.channel_id,
					channelInfo,
					storeAllowFrom: isDirect ? await readStoreAllowFromForDmPolicy({
						provider: "mattermost",
						accountId: account.accountId,
						dmPolicy: account.config.dmPolicy ?? "pairing",
						readStore: pairing.readStoreForDmPolicy
					}) : void 0,
					allowTextCommands,
					hasControlCommand: false
				});
				if (decision.ok) {return { ok: true };}
				return {
					ok: false,
					response: {
						update: {
							message: post.message ?? "",
							props: post.props
						},
						ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`
					}
				};
			},
			resolveSessionKey: async ({ channelId, userId, post }) => {
				const channelInfo = await resolveChannelInfo(channelId);
				const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
				const teamId = channelInfo?.team_id ?? void 0;
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "mattermost",
					accountId: account.accountId,
					teamId,
					peer: {
						kind,
						id: kind === "direct" ? userId : channelId
					}
				});
				const replyToMode = resolveMattermostReplyToMode(account, kind);
				return resolveMattermostThreadSessionContext({
					baseSessionKey: route.sessionKey,
					kind,
					postId: post.id || void 0,
					replyToMode,
					threadRootId: post.root_id
				}).sessionKey;
			},
			dispatchButtonClick: async (opts) => {
				const channelInfo = await resolveChannelInfo(opts.channelId);
				const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
				const chatType = channelChatType(kind);
				const teamId = channelInfo?.team_id ?? void 0;
				const channelName = channelInfo?.name ?? void 0;
				const channelDisplay = channelInfo?.display_name ?? channelName ?? opts.channelId;
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "mattermost",
					accountId: account.accountId,
					teamId,
					peer: {
						kind,
						id: kind === "direct" ? opts.userId : opts.channelId
					}
				});
				const replyToMode = resolveMattermostReplyToMode(account, kind);
				const threadContext = resolveMattermostThreadSessionContext({
					baseSessionKey: route.sessionKey,
					kind,
					postId: opts.post.id || opts.postId,
					replyToMode,
					threadRootId: opts.post.root_id
				});
				const to = kind === "direct" ? `user:${opts.userId}` : `channel:${opts.channelId}`;
				const bodyText = `[Button click: user @${opts.userName} selected "${opts.actionName}"]`;
				const ctxPayload = core.channel.reply.finalizeInboundContext({
					Body: bodyText,
					BodyForAgent: bodyText,
					RawBody: bodyText,
					CommandBody: bodyText,
					From: kind === "direct" ? `mattermost:${opts.userId}` : kind === "group" ? `mattermost:group:${opts.channelId}` : `mattermost:channel:${opts.channelId}`,
					To: to,
					SessionKey: threadContext.sessionKey,
					ParentSessionKey: threadContext.parentSessionKey,
					AccountId: route.accountId,
					ChatType: chatType,
					ConversationLabel: `mattermost:${opts.userName}`,
					GroupSubject: kind !== "direct" ? channelDisplay : void 0,
					GroupChannel: channelName ? `#${channelName}` : void 0,
					GroupSpace: teamId,
					SenderName: opts.userName,
					SenderId: opts.userId,
					Provider: "mattermost",
					Surface: "mattermost",
					MessageSid: `interaction:${opts.postId}:${opts.actionId}`,
					ReplyToId: threadContext.effectiveReplyToId,
					MessageThreadId: threadContext.effectiveReplyToId,
					WasMentioned: true,
					CommandAuthorized: false,
					OriginatingChannel: "mattermost",
					OriginatingTo: to
				});
				const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
				const tableMode = core.channel.text.resolveMarkdownTableMode({
					cfg,
					channel: "mattermost",
					accountId: account.accountId
				});
				const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
					cfg,
					agentId: route.agentId,
					channel: "mattermost",
					accountId: account.accountId
				});
				const typingCallbacks = createTypingCallbacks({
					start: () => sendTypingIndicator(opts.channelId, threadContext.effectiveReplyToId),
					onStartError: (err) => {
						logTypingFailure({
							log: (message) => logger.debug?.(message),
							channel: "mattermost",
							target: opts.channelId,
							error: err
						});
					}
				});
				const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
					...prefixOptions,
					humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
					deliver: async (payload) => {
						await deliverMattermostReplyPayload({
							core,
							cfg,
							payload,
							to,
							accountId: account.accountId,
							agentId: route.agentId,
							replyToId: resolveMattermostReplyRootId({
								threadRootId: threadContext.effectiveReplyToId,
								replyToId: payload.replyToId
							}),
							textLimit,
							tableMode,
							sendMessage: sendMessageMattermost
						});
						runtime.log?.(`delivered button-click reply to ${to}`);
					},
					onError: (err, info) => {
						runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
					},
					onReplyStart: typingCallbacks.onReplyStart
				});
				await core.channel.reply.dispatchReplyFromConfig({
					ctx: ctxPayload,
					cfg,
					dispatcher,
					replyOptions: {
						...replyOptions,
						disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
						onModelSelected
					}
				});
				markDispatchIdle();
			},
			log: (msg) => runtime.log?.(msg)
		}),
		pluginId: "mattermost",
		source: "mattermost-interactions",
		accountId: account.accountId,
		log: (msg) => runtime.log?.(msg)
	});
	const channelCache = /* @__PURE__ */ new Map();
	const userCache = /* @__PURE__ */ new Map();
	const logger = core.logging.getChildLogger({ module: "mattermost" });
	const logVerboseMessage = (message) => {
		if (!core.logging.shouldLogVerbose()) {return;}
		logger.debug?.(message);
	};
	const mediaMaxBytes = resolveChannelMediaMaxBytes({
		cfg,
		resolveChannelLimitMb: () => void 0,
		accountId: account.accountId
	}) ?? 8 * 1024 * 1024;
	const historyLimit = Math.max(0, cfg.messages?.groupChat?.historyLimit ?? 50);
	const channelHistories = /* @__PURE__ */ new Map();
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.mattermost !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "mattermost",
		accountId: account.accountId,
		log: (message) => logVerboseMessage(message)
	});
	const resolveMattermostMedia = async (fileIds) => {
		const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
		if (ids.length === 0) {return [];}
		const out = [];
		for (const fileId of ids) {try {
			const fetched = await core.channel.media.fetchRemoteMedia({
				url: `${client.apiBaseUrl}/files/${fileId}`,
				requestInit: { headers: { Authorization: `Bearer ${client.token}` } },
				filePathHint: fileId,
				maxBytes: mediaMaxBytes,
				ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] }
			});
			const saved = await core.channel.media.saveMediaBuffer(fetched.buffer, fetched.contentType ?? void 0, "inbound", mediaMaxBytes);
			const contentType = saved.contentType ?? fetched.contentType ?? void 0;
			out.push({
				path: saved.path,
				contentType,
				kind: core.media.mediaKindFromMime(contentType) ?? "unknown"
			});
		} catch (err) {
			logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
		}}
		return out;
	};
	const sendTypingIndicator = async (channelId, parentId) => {
		await sendMattermostTyping(client, {
			channelId,
			parentId
		});
	};
	const resolveChannelInfo = async (channelId) => {
		const cached = channelCache.get(channelId);
		if (cached && cached.expiresAt > Date.now()) {return cached.value;}
		try {
			const info = await fetchMattermostChannel(client, channelId);
			channelCache.set(channelId, {
				value: info,
				expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
			});
			return info;
		} catch (err) {
			logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
			channelCache.set(channelId, {
				value: null,
				expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
			});
			return null;
		}
	};
	const resolveUserInfo = async (userId) => {
		const cached = userCache.get(userId);
		if (cached && cached.expiresAt > Date.now()) {return cached.value;}
		try {
			const info = await fetchMattermostUser(client, userId);
			userCache.set(userId, {
				value: info,
				expiresAt: Date.now() + USER_CACHE_TTL_MS
			});
			return info;
		} catch (err) {
			logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
			userCache.set(userId, {
				value: null,
				expiresAt: Date.now() + USER_CACHE_TTL_MS
			});
			return null;
		}
	};
	const buildModelPickerProps = (channelId, buttons) => buildButtonProps({
		callbackUrl,
		accountId: account.accountId,
		channelId,
		buttons
	});
	const updateModelPickerPost = async (params) => {
		const props = buildModelPickerProps(params.channelId, params.buttons ?? []) ?? { attachments: [] };
		await updateMattermostPost(client, params.postId, {
			message: params.message,
			props
		});
		return {};
	};
	const runModelPickerCommand = async (params) => {
		const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
		const fromLabel = params.kind === "direct" ? `Mattermost DM from ${params.senderName}` : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: params.commandText,
			BodyForAgent: params.commandText,
			RawBody: params.commandText,
			CommandBody: params.commandText,
			From: params.kind === "direct" ? `mattermost:${params.senderId}` : params.kind === "group" ? `mattermost:group:${params.channelId}` : `mattermost:channel:${params.channelId}`,
			To: to,
			SessionKey: params.sessionKey,
			ParentSessionKey: params.parentSessionKey,
			AccountId: params.route.accountId,
			ChatType: params.chatType,
			ConversationLabel: fromLabel,
			GroupSubject: params.kind !== "direct" ? params.channelDisplay || params.roomLabel : void 0,
			GroupChannel: params.channelName ? `#${params.channelName}` : void 0,
			GroupSpace: params.teamId,
			SenderName: params.senderName,
			SenderId: params.senderId,
			Provider: "mattermost",
			Surface: "mattermost",
			MessageSid: `interaction:${params.postId}:${Date.now()}`,
			ReplyToId: params.effectiveReplyToId,
			MessageThreadId: params.effectiveReplyToId,
			Timestamp: Date.now(),
			WasMentioned: true,
			CommandAuthorized: params.commandAuthorized,
			CommandSource: "native",
			OriginatingChannel: "mattermost",
			OriginatingTo: to
		});
		const tableMode = core.channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "mattermost",
			accountId: account.accountId
		});
		const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
		const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
			cfg,
			agentId: params.route.agentId,
			channel: "mattermost",
			accountId: account.accountId
		});
		const shouldDeliverReplies = params.deliverReplies === true;
		const capturedTexts = [];
		const typingCallbacks = shouldDeliverReplies ? createTypingCallbacks({
			start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
			onStartError: (err) => {
				logTypingFailure({
					log: (message) => logger.debug?.(message),
					channel: "mattermost",
					target: params.channelId,
					error: err
				});
			}
		}) : void 0;
		const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
			...prefixOptions,
			deliver: async (payload) => {
				const trimmedPayload = {
					...payload,
					text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim()
				};
				if (!shouldDeliverReplies) {
					if (trimmedPayload.text) {capturedTexts.push(trimmedPayload.text);}
					return;
				}
				await deliverMattermostReplyPayload({
					core,
					cfg,
					payload: trimmedPayload,
					to,
					accountId: account.accountId,
					agentId: params.route.agentId,
					replyToId: resolveMattermostReplyRootId({
						threadRootId: params.effectiveReplyToId,
						replyToId: trimmedPayload.replyToId
					}),
					textLimit,
					tableMode: "off",
					sendMessage: sendMessageMattermost
				});
			},
			onError: (err, info) => {
				runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
			},
			onReplyStart: typingCallbacks?.onReplyStart
		});
		await core.channel.reply.withReplyDispatcher({
			dispatcher,
			onSettled: () => {
				markDispatchIdle();
			},
			run: () => core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher,
				replyOptions: {
					...replyOptions,
					disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
					onModelSelected
				}
			})
		});
		return capturedTexts.join("\n\n").trim();
	};
	async function handleModelPickerInteraction(params) {
		const pickerState = parseMattermostModelPickerContext(params.context);
		if (!pickerState) {return null;}
		if (pickerState.ownerUserId !== params.payload.user_id) {return { ephemeral_text: "Only the person who opened this picker can use it." };}
		const channelInfo = await resolveChannelInfo(params.payload.channel_id);
		const pickerCommandText = pickerState.action === "select" ? `/model ${pickerState.provider}/${pickerState.model}` : pickerState.action === "list" ? `/models ${pickerState.provider}` : "/models";
		const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
			cfg,
			surface: "mattermost"
		});
		const hasControlCommand = core.channel.text.hasControlCommand(pickerCommandText, cfg);
		const dmPolicy = account.config.dmPolicy ?? "pairing";
		const storeAllowFrom = normalizeMattermostAllowList(await readStoreAllowFromForDmPolicy({
			provider: "mattermost",
			accountId: account.accountId,
			dmPolicy,
			readStore: pairing.readStoreForDmPolicy
		}));
		const auth = authorizeMattermostCommandInvocation({
			account,
			cfg,
			senderId: params.payload.user_id,
			senderName: params.userName,
			channelId: params.payload.channel_id,
			channelInfo,
			storeAllowFrom,
			allowTextCommands,
			hasControlCommand
		});
		if (!auth.ok) {
			if (auth.denyReason === "dm-pairing") {
				const { code } = await pairing.upsertPairingRequest({
					id: params.payload.user_id,
					meta: { name: params.userName }
				});
				return { ephemeral_text: core.channel.pairing.buildPairingReply({
					channel: "mattermost",
					idLine: `Your Mattermost user id: ${params.payload.user_id}`,
					code
				}) };
			}
			return { ephemeral_text: auth.denyReason === "unknown-channel" ? "Temporary error: unable to determine channel type. Please try again." : auth.denyReason === "dm-disabled" ? "This bot is not accepting direct messages." : auth.denyReason === "channels-disabled" ? "Model picker actions are disabled in channels." : auth.denyReason === "channel-no-allowlist" ? "Model picker actions are not configured for this channel." : "Unauthorized." };
		}
		const kind = auth.kind;
		const chatType = auth.chatType;
		const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? void 0;
		const channelName = auth.channelName || void 0;
		const channelDisplay = auth.channelDisplay || auth.channelName || params.payload.channel_id;
		const roomLabel = auth.roomLabel;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "mattermost",
			accountId: account.accountId,
			teamId,
			peer: {
				kind,
				id: kind === "direct" ? params.payload.user_id : params.payload.channel_id
			}
		});
		const replyToMode = resolveMattermostReplyToMode(account, kind);
		const threadContext = resolveMattermostThreadSessionContext({
			baseSessionKey: route.sessionKey,
			kind,
			postId: params.post.id || params.payload.post_id,
			replyToMode,
			threadRootId: params.post.root_id
		});
		const modelSessionRoute = {
			agentId: route.agentId,
			sessionKey: threadContext.sessionKey
		};
		const data = await buildModelsProviderData(cfg, route.agentId);
		if (data.providers.length === 0) {return await updateModelPickerPost({
			channelId: params.payload.channel_id,
			postId: params.payload.post_id,
			message: "No models available."
		});}
		if (pickerState.action === "providers" || pickerState.action === "back") {
			const currentModel = resolveMattermostModelPickerCurrentModel({
				cfg,
				route: modelSessionRoute,
				data
			});
			const view = renderMattermostProviderPickerView({
				ownerUserId: pickerState.ownerUserId,
				data,
				currentModel
			});
			return await updateModelPickerPost({
				channelId: params.payload.channel_id,
				postId: params.payload.post_id,
				message: view.text,
				buttons: view.buttons
			});
		}
		if (pickerState.action === "list") {
			const currentModel = resolveMattermostModelPickerCurrentModel({
				cfg,
				route: modelSessionRoute,
				data
			});
			const view = renderMattermostModelsPickerView({
				ownerUserId: pickerState.ownerUserId,
				data,
				provider: pickerState.provider,
				page: pickerState.page,
				currentModel
			});
			return await updateModelPickerPost({
				channelId: params.payload.channel_id,
				postId: params.payload.post_id,
				message: view.text,
				buttons: view.buttons
			});
		}
		const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
		if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {return { ephemeral_text: `That model is no longer available: ${targetModelRef}` };}
		(async () => {
			try {
				await runModelPickerCommand({
					commandText: `/model ${targetModelRef}`,
					commandAuthorized: auth.commandAuthorized,
					route,
					sessionKey: threadContext.sessionKey,
					parentSessionKey: threadContext.parentSessionKey,
					channelId: params.payload.channel_id,
					senderId: params.payload.user_id,
					senderName: params.userName,
					kind,
					chatType,
					channelName,
					channelDisplay,
					roomLabel,
					teamId,
					postId: params.payload.post_id,
					effectiveReplyToId: threadContext.effectiveReplyToId,
					deliverReplies: true
				});
				const updatedModel = resolveMattermostModelPickerCurrentModel({
					cfg,
					route: modelSessionRoute,
					data,
					skipCache: true
				});
				const view = renderMattermostModelsPickerView({
					ownerUserId: pickerState.ownerUserId,
					data,
					provider: pickerState.provider,
					page: pickerState.page,
					currentModel: updatedModel
				});
				await updateModelPickerPost({
					channelId: params.payload.channel_id,
					postId: params.payload.post_id,
					message: view.text,
					buttons: view.buttons
				});
			} catch (err) {
				runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
			}
		})();
		return {};
	}
	const handlePost = async (post, payload, messageIds) => {
		const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
		if (!channelId) {
			logVerboseMessage("mattermost: drop post (missing channel id)");
			return;
		}
		const allMessageIds = messageIds?.length ? messageIds : post.id ? [post.id] : [];
		if (allMessageIds.length === 0) {
			logVerboseMessage("mattermost: drop post (missing message id)");
			return;
		}
		const dedupeEntries = allMessageIds.map((id) => recentInboundMessages.check(`${account.accountId}:${id}`));
		if (dedupeEntries.length > 0 && dedupeEntries.every(Boolean)) {
			logVerboseMessage(`mattermost: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`);
			return;
		}
		const senderId = post.user_id ?? payload.broadcast?.user_id;
		if (!senderId) {
			logVerboseMessage("mattermost: drop post (missing sender id)");
			return;
		}
		if (senderId === botUserId) {
			logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
			return;
		}
		if (isSystemPost(post)) {
			logVerboseMessage(`mattermost: drop post (system post type=${post.type ?? "unknown"})`);
			return;
		}
		const channelInfo = await resolveChannelInfo(channelId);
		const kind = mapMattermostChannelTypeToChatType(payload.data?.channel_type ?? channelInfo?.type ?? void 0);
		const chatType = channelChatType(kind);
		const senderName = payload.data?.sender_name?.trim() || (await resolveUserInfo(senderId))?.username?.trim() || senderId;
		const rawText = post.message?.trim() || "";
		const dmPolicy = account.config.dmPolicy ?? "pairing";
		const normalizedAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
		const normalizedGroupAllowFrom = normalizeMattermostAllowList(account.config.groupAllowFrom ?? []);
		const storeAllowFrom = normalizeMattermostAllowList(await readStoreAllowFromForDmPolicy({
			provider: "mattermost",
			accountId: account.accountId,
			dmPolicy,
			readStore: pairing.readStoreForDmPolicy
		}));
		const accessDecision = resolveDmGroupAccessWithLists({
			isGroup: kind !== "direct",
			dmPolicy,
			groupPolicy,
			allowFrom: normalizedAllowFrom,
			groupAllowFrom: normalizedGroupAllowFrom,
			storeAllowFrom,
			isSenderAllowed: (allowFrom) => isMattermostSenderAllowed({
				senderId,
				senderName,
				allowFrom,
				allowNameMatching
			})
		});
		const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
		const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
		const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
			cfg,
			surface: "mattermost"
		});
		const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
		const isControlCommand = allowTextCommands && hasControlCommand;
		const useAccessGroups = cfg.commands?.useAccessGroups !== false;
		const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
		const senderAllowedForCommands = isMattermostSenderAllowed({
			senderId,
			senderName,
			allowFrom: commandDmAllowFrom,
			allowNameMatching
		});
		const groupAllowedForCommands = isMattermostSenderAllowed({
			senderId,
			senderName,
			allowFrom: effectiveGroupAllowFrom,
			allowNameMatching
		});
		const commandGate = resolveControlCommandGate({
			useAccessGroups,
			authorizers: [{
				configured: commandDmAllowFrom.length > 0,
				allowed: senderAllowedForCommands
			}, {
				configured: effectiveGroupAllowFrom.length > 0,
				allowed: groupAllowedForCommands
			}],
			allowTextCommands,
			hasControlCommand
		});
		const commandAuthorized = commandGate.commandAuthorized;
		if (accessDecision.decision !== "allow") {
			if (kind === "direct") {
				if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
					logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
					return;
				}
				if (accessDecision.decision === "pairing") {
					const { code, created } = await pairing.upsertPairingRequest({
						id: senderId,
						meta: { name: senderName }
					});
					logVerboseMessage(`mattermost: pairing request sender=${senderId} created=${created}`);
					if (created) {try {
						await sendMessageMattermost(`user:${senderId}`, core.channel.pairing.buildPairingReply({
							channel: "mattermost",
							idLine: `Your Mattermost user id: ${senderId}`,
							code
						}), { accountId: account.accountId });
						opts.statusSink?.({ lastOutboundAt: Date.now() });
					} catch (err) {
						logVerboseMessage(`mattermost: pairing reply failed for ${senderId}: ${String(err)}`);
					}}
					return;
				}
				logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
				logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
				logVerboseMessage("mattermost: drop group message (no group allowlist)");
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
				logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
				return;
			}
			logVerboseMessage(`mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`);
			return;
		}
		if (kind !== "direct" && commandGate.shouldBlock) {
			logInboundDrop({
				log: logVerboseMessage,
				channel: "mattermost",
				reason: "control command (unauthorized)",
				target: senderId
			});
			return;
		}
		const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? void 0;
		const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
		const channelDisplay = payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
		const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "mattermost",
			accountId: account.accountId,
			teamId,
			peer: {
				kind,
				id: kind === "direct" ? senderId : channelId
			}
		});
		const baseSessionKey = route.sessionKey;
		const threadRootId = post.root_id?.trim() || void 0;
		const replyToMode = resolveMattermostReplyToMode(account, kind);
		const { effectiveReplyToId, sessionKey, parentSessionKey } = resolveMattermostThreadSessionContext({
			baseSessionKey,
			kind,
			postId: post.id,
			replyToMode,
			threadRootId
		});
		const historyKey = kind === "direct" ? null : sessionKey;
		const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
		const wasMentioned = kind !== "direct" && ((botUsername ? rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) : false) || core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
		const pendingBody = rawText || (post.file_ids?.length ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]` : "");
		const pendingSender = senderName;
		const recordPendingHistory = () => {
			const trimmed = pendingBody.trim();
			recordPendingHistoryEntryIfEnabled({
				historyMap: channelHistories,
				limit: historyLimit,
				historyKey: historyKey ?? "",
				entry: historyKey && trimmed ? {
					sender: pendingSender,
					body: trimmed,
					timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
					messageId: post.id ?? void 0
				} : null
			});
		};
		const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
		const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
		const oncharResult = oncharEnabled ? stripOncharPrefix(rawText, oncharPrefixes) : {
			triggered: false,
			stripped: rawText
		};
		const oncharTriggered = oncharResult.triggered;
		const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
		const mentionDecision = evaluateMattermostMentionGate({
			kind,
			cfg,
			accountId: account.accountId,
			channelId,
			threadRootId,
			requireMentionOverride: account.requireMention,
			resolveRequireMention: core.channel.groups.resolveRequireMention,
			wasMentioned,
			isControlCommand,
			commandAuthorized,
			oncharEnabled,
			oncharTriggered,
			canDetectMention
		});
		const { shouldRequireMention, shouldBypassMention } = mentionDecision;
		if (mentionDecision.dropReason === "onchar-not-triggered") {
			logVerboseMessage(`mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`);
			recordPendingHistory();
			return;
		}
		if (mentionDecision.dropReason === "missing-mention") {
			logVerboseMessage(`mattermost: drop group message (missing mention channel=${channelId} sender=${senderId} requireMention=${shouldRequireMention} bypass=${shouldBypassMention} canDetectMention=${canDetectMention})`);
			recordPendingHistory();
			return;
		}
		const mediaList = await resolveMattermostMedia(post.file_ids);
		const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
		const bodyText = normalizeMention([oncharTriggered ? oncharResult.stripped : rawText, mediaPlaceholder].filter(Boolean).join("\n").trim(), botUsername);
		if (!bodyText) {
			logVerboseMessage(`mattermost: drop group message (empty body after normalization channel=${channelId} sender=${senderId})`);
			return;
		}
		core.channel.activity.record({
			channel: "mattermost",
			accountId: account.accountId,
			direction: "inbound"
		});
		const fromLabel = formatInboundFromLabel({
			isGroup: kind !== "direct",
			groupLabel: channelDisplay || roomLabel,
			groupId: channelId,
			groupFallback: roomLabel || "Channel",
			directLabel: senderName,
			directId: senderId
		});
		const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
		const inboundLabel = kind === "direct" ? `Mattermost DM from ${senderName}` : `Mattermost message in ${roomLabel} from ${senderName}`;
		core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
			sessionKey,
			contextKey: `mattermost:message:${channelId}:${post.id ?? "unknown"}`
		});
		const textWithId = `${bodyText}\n[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
		let combinedBody = core.channel.reply.formatInboundEnvelope({
			channel: "Mattermost",
			from: fromLabel,
			timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
			body: textWithId,
			chatType,
			sender: {
				name: senderName,
				id: senderId
			}
		});
		if (historyKey) {combinedBody = buildPendingHistoryContextFromMap({
			historyMap: channelHistories,
			historyKey,
			limit: historyLimit,
			currentMessage: combinedBody,
			formatEntry: (entry) => core.channel.reply.formatInboundEnvelope({
				channel: "Mattermost",
				from: fromLabel,
				timestamp: entry.timestamp,
				body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""}`,
				chatType,
				senderLabel: entry.sender
			})
		});}
		const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
		const mediaPayload = buildAgentMediaPayload(mediaList);
		const commandBody = rawText.trim();
		const inboundHistory = historyKey && historyLimit > 0 ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
			sender: entry.sender,
			body: entry.body,
			timestamp: entry.timestamp
		})) : void 0;
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: combinedBody,
			BodyForAgent: bodyText,
			InboundHistory: inboundHistory,
			RawBody: bodyText,
			CommandBody: commandBody,
			BodyForCommands: commandBody,
			From: kind === "direct" ? `mattermost:${senderId}` : kind === "group" ? `mattermost:group:${channelId}` : `mattermost:channel:${channelId}`,
			To: to,
			SessionKey: sessionKey,
			ParentSessionKey: parentSessionKey,
			AccountId: route.accountId,
			ChatType: chatType,
			ConversationLabel: fromLabel,
			GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : void 0,
			GroupChannel: channelName ? `#${channelName}` : void 0,
			GroupSpace: teamId,
			SenderName: senderName,
			SenderId: senderId,
			Provider: "mattermost",
			Surface: "mattermost",
			MessageSid: post.id ?? void 0,
			MessageSids: allMessageIds.length > 1 ? allMessageIds : void 0,
			MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : void 0,
			MessageSidLast: allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : void 0,
			ReplyToId: effectiveReplyToId,
			MessageThreadId: effectiveReplyToId,
			Timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
			WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : void 0,
			CommandAuthorized: commandAuthorized,
			OriginatingChannel: "mattermost",
			OriginatingTo: to,
			...mediaPayload
		});
		if (kind === "direct") {
			const sessionCfg = cfg.session;
			const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, { agentId: route.agentId });
			await core.channel.session.updateLastRoute({
				storePath,
				sessionKey: route.mainSessionKey,
				deliveryContext: {
					channel: "mattermost",
					to,
					accountId: route.accountId
				}
			});
		}
		const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
		logVerboseMessage(`mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`);
		const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
		const tableMode = core.channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "mattermost",
			accountId: account.accountId
		});
		const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
			cfg,
			agentId: route.agentId,
			channel: "mattermost",
			accountId: account.accountId
		});
		const typingCallbacks = createTypingCallbacks({
			start: () => sendTypingIndicator(channelId, effectiveReplyToId),
			onStartError: (err) => {
				logTypingFailure({
					log: (message) => logger.debug?.(message),
					channel: "mattermost",
					target: channelId,
					error: err
				});
			}
		});
		const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
			...prefixOptions,
			humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
			typingCallbacks,
			deliver: async (payload) => {
				await deliverMattermostReplyPayload({
					core,
					cfg,
					payload,
					to,
					accountId: account.accountId,
					agentId: route.agentId,
					replyToId: resolveMattermostReplyRootId({
						threadRootId: effectiveReplyToId,
						replyToId: payload.replyToId
					}),
					textLimit,
					tableMode,
					sendMessage: sendMessageMattermost
				});
				runtime.log?.(`delivered reply to ${to}`);
			},
			onError: (err, info) => {
				runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
			}
		});
		await core.channel.reply.withReplyDispatcher({
			dispatcher,
			onSettled: () => {
				markDispatchIdle();
			},
			run: () => core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher,
				replyOptions: {
					...replyOptions,
					disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
					onModelSelected
				}
			})
		});
		if (historyKey) {clearHistoryEntriesIfEnabled({
			historyMap: channelHistories,
			historyKey,
			limit: historyLimit
		});}
	};
	const handleReactionEvent = async (payload) => {
		const reactionData = payload.data?.reaction;
		if (!reactionData) {return;}
		let reaction = null;
		if (typeof reactionData === "string") {try {
			reaction = JSON.parse(reactionData);
		} catch {
			return;
		}}
		else if (typeof reactionData === "object") {reaction = reactionData;}
		if (!reaction) {return;}
		const userId = reaction.user_id?.trim();
		const postId = reaction.post_id?.trim();
		const emojiName = reaction.emoji_name?.trim();
		if (!userId || !postId || !emojiName) {return;}
		if (userId === botUserId) {return;}
		const action = payload.event === "reaction_removed" ? "removed" : "added";
		const senderName = (await resolveUserInfo(userId))?.username?.trim() || userId;
		const channelId = payload.broadcast?.channel_id;
		if (!channelId) {
			logVerboseMessage(`mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`);
			return;
		}
		const channelInfo = await resolveChannelInfo(channelId);
		if (!channelInfo?.type) {
			logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
			return;
		}
		const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
		const dmPolicy = account.config.dmPolicy ?? "pairing";
		const storeAllowFrom = normalizeMattermostAllowList(await readStoreAllowFromForDmPolicy({
			provider: "mattermost",
			accountId: account.accountId,
			dmPolicy,
			readStore: pairing.readStoreForDmPolicy
		}));
		const reactionAccess = resolveDmGroupAccessWithLists({
			isGroup: kind !== "direct",
			dmPolicy,
			groupPolicy,
			allowFrom: normalizeMattermostAllowList(account.config.allowFrom ?? []),
			groupAllowFrom: normalizeMattermostAllowList(account.config.groupAllowFrom ?? []),
			storeAllowFrom,
			isSenderAllowed: (allowFrom) => isMattermostSenderAllowed({
				senderId: userId,
				senderName,
				allowFrom,
				allowNameMatching
			})
		});
		if (reactionAccess.decision !== "allow") {
			if (kind === "direct") {logVerboseMessage(`mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.reason})`);}
			else {logVerboseMessage(`mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.reason} channel=${channelId})`);}
			return;
		}
		const teamId = channelInfo?.team_id ?? void 0;
		const sessionKey = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "mattermost",
			accountId: account.accountId,
			teamId,
			peer: {
				kind,
				id: kind === "direct" ? userId : channelId
			}
		}).sessionKey;
		const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;
		core.system.enqueueSystemEvent(eventText, {
			sessionKey,
			contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`
		});
		logVerboseMessage(`mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`);
	};
	const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
		cfg,
		channel: "mattermost"
	});
	const debouncer = core.channel.debounce.createInboundDebouncer({
		debounceMs: inboundDebounceMs,
		buildKey: (entry) => {
			const channelId = entry.post.channel_id ?? entry.payload.data?.channel_id ?? entry.payload.broadcast?.channel_id;
			if (!channelId) {return null;}
			const threadId = entry.post.root_id?.trim();
			const threadKey = threadId ? `thread:${threadId}` : "channel";
			return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
		},
		shouldDebounce: (entry) => {
			if (entry.post.file_ids && entry.post.file_ids.length > 0) {return false;}
			const text = entry.post.message?.trim() ?? "";
			if (!text) {return false;}
			return !core.channel.text.hasControlCommand(text, cfg);
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) {return;}
			if (entries.length === 1) {
				await handlePost(last.post, last.payload);
				return;
			}
			const combinedText = entries.map((entry) => entry.post.message?.trim() ?? "").filter(Boolean).join("\n");
			const mergedPost = {
				...last.post,
				message: combinedText,
				file_ids: []
			};
			const ids = entries.map((entry) => entry.post.id).filter(Boolean);
			await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : void 0);
		},
		onError: (err) => {
			runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
		}
	});
	const wsUrl = buildMattermostWsUrl(baseUrl);
	let seq = 1;
	const connectOnce = createMattermostConnectOnce({
		wsUrl,
		botToken,
		abortSignal: opts.abortSignal,
		statusSink: opts.statusSink,
		runtime,
		webSocketFactory: opts.webSocketFactory,
		nextSeq: () => seq++,
		onPosted: async (post, payload) => {
			await debouncer.enqueue({
				post,
				payload
			});
		},
		onReaction: async (payload) => {
			await handleReactionEvent(payload);
		}
	});
	let slashShutdownCleanup = null;
	if (slashEnabled) {
		const runAbortCleanup = () => {
			if (slashShutdownCleanup) {return;}
			const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
			deactivateSlashCommands(account.accountId);
			slashShutdownCleanup = cleanupSlashCommands({
				client,
				commands,
				log: (msg) => runtime.log?.(msg)
			}).catch((err) => {
				runtime.error?.(`mattermost: slash cleanup failed: ${String(err)}`);
			});
		};
		if (opts.abortSignal?.aborted) {runAbortCleanup();}
		else {opts.abortSignal?.addEventListener("abort", runAbortCleanup, { once: true });}
	}
	try {
		await runWithReconnect(connectOnce, {
			abortSignal: opts.abortSignal,
			jitterRatio: .2,
			onError: (err) => {
				runtime.error?.(`mattermost connection failed: ${String(err)}`);
				opts.statusSink?.({
					lastError: String(err),
					connected: false
				});
			},
			onReconnect: (delayMs) => {
				runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1e3)}s`);
			}
		});
	} finally {
		unregisterInteractions?.();
	}
	if (slashShutdownCleanup) {await slashShutdownCleanup;}
}
//#endregion
//#region extensions/mattermost/src/mattermost/probe.ts
async function probeMattermost(baseUrl, botToken, timeoutMs = 2500) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) {return {
		ok: false,
		error: "baseUrl missing"
	};}
	const url = `${normalized}/api/v4/users/me`;
	const start = Date.now();
	const controller = timeoutMs > 0 ? new AbortController() : void 0;
	let timer = null;
	if (controller) {timer = setTimeout(() => controller.abort(), timeoutMs);}
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${botToken}` },
			signal: controller?.signal
		});
		const elapsedMs = Date.now() - start;
		if (!res.ok) {
			const detail = await readMattermostError(res);
			return {
				ok: false,
				status: res.status,
				error: detail || res.statusText,
				elapsedMs
			};
		}
		const bot = await res.json();
		return {
			ok: true,
			status: res.status,
			elapsedMs,
			bot
		};
	} catch (err) {
		return {
			ok: false,
			status: null,
			error: err instanceof Error ? err.message : String(err),
			elapsedMs: Date.now() - start
		};
	} finally {
		if (timer) {clearTimeout(timer);}
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/reactions.ts
const BOT_USER_CACHE_TTL_MS = 10 * 6e4;
const botUserIdCache = /* @__PURE__ */ new Map();
async function resolveBotUserId(client, cacheKey) {
	const cached = botUserIdCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {return cached.userId;}
	const userId = (await fetchMattermostMe(client))?.id?.trim();
	if (!userId) {return null;}
	botUserIdCache.set(cacheKey, {
		userId,
		expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS
	});
	return userId;
}
async function addMattermostReaction(params) {
	return runMattermostReaction(params, {
		action: "add",
		mutation: createReaction
	});
}
async function removeMattermostReaction(params) {
	return runMattermostReaction(params, {
		action: "remove",
		mutation: deleteReaction
	});
}
async function runMattermostReaction(params, options) {
	const resolved = resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const baseUrl = resolved.baseUrl?.trim();
	const botToken = resolved.botToken?.trim();
	if (!baseUrl || !botToken) {return {
		ok: false,
		error: "Mattermost botToken/baseUrl missing."
	};}
	const client = createMattermostClient({
		baseUrl,
		botToken,
		fetchImpl: params.fetchImpl
	});
	const userId = await resolveBotUserId(client, `${baseUrl}:${botToken}`);
	if (!userId) {return {
		ok: false,
		error: "Mattermost reactions failed: could not resolve bot user id."
	};}
	try {
		await options.mutation(client, {
			userId,
			postId: params.postId,
			emojiName: params.emojiName
		});
	} catch (err) {
		return {
			ok: false,
			error: `Mattermost ${options.action} reaction failed: ${String(err)}`
		};
	}
	return { ok: true };
}
async function createReaction(client, params) {
	await client.request("/reactions", {
		method: "POST",
		body: JSON.stringify({
			user_id: params.userId,
			post_id: params.postId,
			emoji_name: params.emojiName
		})
	});
}
async function deleteReaction(client, params) {
	const emoji = encodeURIComponent(params.emojiName);
	await client.request(`/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`, { method: "DELETE" });
}
//#endregion
//#region extensions/mattermost/src/normalize.ts
function normalizeMattermostMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return;}
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("channel:")) {
		const id = trimmed.slice(8).trim();
		return id ? `channel:${id}` : void 0;
	}
	if (lower.startsWith("group:")) {
		const id = trimmed.slice(6).trim();
		return id ? `channel:${id}` : void 0;
	}
	if (lower.startsWith("user:")) {
		const id = trimmed.slice(5).trim();
		return id ? `user:${id}` : void 0;
	}
	if (lower.startsWith("mattermost:")) {
		const id = trimmed.slice(11).trim();
		return id ? `user:${id}` : void 0;
	}
	if (trimmed.startsWith("@")) {
		const id = trimmed.slice(1).trim();
		return id ? `@${id}` : void 0;
	}
	if (trimmed.startsWith("#")) {return;}
}
function looksLikeMattermostTargetId(raw, normalized) {
	const trimmed = raw.trim();
	if (!trimmed) {return false;}
	if (/^(user|channel|group|mattermost):/i.test(trimmed)) {return true;}
	if (trimmed.startsWith("@")) {return true;}
	return /^[a-z0-9]{26}$/i.test(trimmed) || /^[a-z0-9]{26}__[a-z0-9]{26}$/i.test(trimmed);
}
//#endregion
//#region extensions/mattermost/src/setup-core.ts
const channel$1 = "mattermost";
function isMattermostConfigured(account) {
	return (Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken)) && Boolean(account.baseUrl);
}
function resolveMattermostAccountWithSecrets(cfg, accountId) {
	return resolveMattermostAccount({
		cfg,
		accountId,
		allowUnresolvedSecretRef: true
	});
}
const mattermostSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => {
		const token = input.botToken ?? input.token;
		const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
		if (input.useEnv && accountId !== "default") {return "Mattermost env vars can only be used for the default account.";}
		if (!input.useEnv && (!token || !baseUrl)) {return "Mattermost requires --bot-token and --http-url (or --use-env).";}
		if (input.httpUrl && !baseUrl) {return "Mattermost --http-url must include a valid base URL.";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const token = input.botToken ?? input.token;
		const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		return applySetupAccountConfigPatch({
			cfg: accountId !== "default" ? migrateBaseNameToDefaultAccount({
				cfg: namedConfig,
				channelKey: channel$1
			}) : namedConfig,
			channelKey: channel$1,
			accountId,
			patch: input.useEnv ? {} : {
				...token ? { botToken: token } : {},
				...baseUrl ? { baseUrl } : {}
			}
		});
	}
};
//#endregion
//#region extensions/mattermost/src/setup-surface.ts
const channel = "mattermost";
const mattermostSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs token + url",
		configuredHint: "configured",
		unconfiguredHint: "needs setup",
		configuredScore: 2,
		unconfiguredScore: 1,
		resolveConfigured: ({ cfg }) => listMattermostAccountIds(cfg).some((accountId) => isMattermostConfigured(resolveMattermostAccountWithSecrets(cfg, accountId)))
	},
	introNote: {
		title: "Mattermost bot token",
		lines: [
			"1) Mattermost System Console -> Integrations -> Bot Accounts",
			"2) Create a bot + copy its token",
			"3) Use your server base URL (e.g., https://chat.example.com)",
			"Tip: the bot must be a member of any channel you want it to monitor.",
			`Docs: ${formatDocsLink("/mattermost", "mattermost")}`
		],
		shouldShow: ({ cfg, accountId }) => !isMattermostConfigured(resolveMattermostAccountWithSecrets(cfg, accountId))
	},
	envShortcut: {
		prompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
		preferredEnvVar: "MATTERMOST_BOT_TOKEN",
		isAvailable: ({ cfg, accountId }) => {
			if (accountId !== "default") {return false;}
			const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
			const hasConfigValues = hasConfiguredSecretInput(resolvedAccount.config.botToken) || Boolean(resolvedAccount.config.baseUrl?.trim());
			return Boolean(process.env.MATTERMOST_BOT_TOKEN?.trim() && process.env.MATTERMOST_URL?.trim() && !hasConfigValues);
		},
		apply: ({ cfg, accountId }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: {}
		})
	},
	credentials: [{
		inputKey: "botToken",
		providerHint: channel,
		credentialLabel: "bot token",
		preferredEnvVar: "MATTERMOST_BOT_TOKEN",
		envPrompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
		keepPrompt: "Mattermost bot token already configured. Keep it?",
		inputPrompt: "Enter Mattermost bot token",
		inspect: ({ cfg, accountId }) => {
			const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
			return {
				accountConfigured: isMattermostConfigured(resolvedAccount),
				hasConfiguredValue: hasConfiguredSecretInput(resolvedAccount.config.botToken)
			};
		}
	}],
	textInputs: [{
		inputKey: "httpUrl",
		message: "Enter Mattermost base URL",
		confirmCurrentValue: false,
		currentValue: ({ cfg, accountId }) => resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ?? process.env.MATTERMOST_URL?.trim(),
		initialValue: ({ cfg, accountId }) => resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ?? process.env.MATTERMOST_URL?.trim(),
		shouldPrompt: ({ cfg, accountId, credentialValues, currentValue }) => {
			const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
			const tokenConfigured = Boolean(resolvedAccount.botToken?.trim()) || hasConfiguredSecretInput(resolvedAccount.config.botToken);
			return Boolean(credentialValues.botToken) || !tokenConfigured || !currentValue;
		},
		validate: ({ value }) => normalizeMattermostBaseUrl(value) ? void 0 : "Mattermost base URL must include a valid base URL.",
		normalizeValue: ({ value }) => normalizeMattermostBaseUrl(value) ?? value.trim()
	}],
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			mattermost: {
				...cfg.channels?.mattermost,
				enabled: false
			}
		}
	})
};
//#endregion
//#region extensions/mattermost/src/channel.ts
const mattermostMessageActions = {
	listActions: ({ cfg }) => {
		const enabledAccounts = listMattermostAccountIds(cfg).map((accountId) => resolveMattermostAccount({
			cfg,
			accountId
		})).filter((account) => account.enabled).filter((account) => Boolean(account.botToken?.trim() && account.baseUrl?.trim()));
		const actions = [];
		if (enabledAccounts.length > 0) {actions.push("send");}
		const baseReactions = (cfg.channels?.mattermost?.actions)?.reactions;
		if (enabledAccounts.some((account) => {
			return (account.config.actions?.reactions ?? baseReactions ?? true) !== false;
		})) {actions.push("react");}
		return actions;
	},
	supportsAction: ({ action }) => {
		return action === "send" || action === "react";
	},
	getCapabilities: ({ cfg }) => {
		return listMattermostAccountIds(cfg).map((id) => resolveMattermostAccount({
			cfg,
			accountId: id
		})).filter((a) => a.enabled && a.botToken?.trim() && a.baseUrl?.trim()).length > 0 ? ["buttons"] : [];
	},
	handleAction: async ({ action, params, cfg, accountId }) => {
		if (action === "react") {
			const mmBase = cfg?.channels?.mattermost;
			const accounts = mmBase?.accounts;
			const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
			const acctActions = (accounts?.[resolvedAccountId])?.actions;
			const baseActions = mmBase?.actions;
			if (!(acctActions?.reactions ?? baseActions?.reactions ?? true)) {throw new Error("Mattermost reactions are disabled in config");}
			const postId = (typeof params?.messageId === "string" ? params.messageId : typeof params?.postId === "string" ? params.postId : "").trim();
			if (!postId) {throw new Error("Mattermost react requires messageId (post id)");}
			const emojiName = (typeof params?.emoji === "string" ? params.emoji : "").trim().replace(/^:+|:+$/g, "");
			if (!emojiName) {throw new Error("Mattermost react requires emoji");}
			if (params?.remove === true) {
				const result = await removeMattermostReaction({
					cfg,
					postId,
					emojiName,
					accountId: resolvedAccountId
				});
				if (!result.ok) {throw new Error(result.error);}
				return {
					content: [{
						type: "text",
						text: `Removed reaction :${emojiName}: from ${postId}`
					}],
					details: {}
				};
			}
			const result = await addMattermostReaction({
				cfg,
				postId,
				emojiName,
				accountId: resolvedAccountId
			});
			if (!result.ok) {throw new Error(result.error);}
			return {
				content: [{
					type: "text",
					text: `Reacted with :${emojiName}: on ${postId}`
				}],
				details: {}
			};
		}
		if (action !== "send") {throw new Error(`Unsupported Mattermost action: ${action}`);}
		const to = typeof params.to === "string" ? params.to.trim() : typeof params.target === "string" ? params.target.trim() : "";
		if (!to) {throw new Error("Mattermost send requires a target (to).");}
		const message = typeof params.message === "string" ? params.message : "";
		const replyToId = readMattermostReplyToId(params);
		const resolvedAccountId = accountId || void 0;
		const mediaUrl = typeof params.media === "string" ? params.media.trim() || void 0 : void 0;
		const result = await sendMessageMattermost(to, message, {
			accountId: resolvedAccountId,
			replyToId,
			buttons: Array.isArray(params.buttons) ? params.buttons : void 0,
			attachmentText: typeof params.attachmentText === "string" ? params.attachmentText : void 0,
			mediaUrl
		});
		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					ok: true,
					channel: "mattermost",
					messageId: result.messageId,
					channelId: result.channelId
				})
			}],
			details: {}
		};
	}
};
const meta = {
	id: "mattermost",
	label: "Mattermost",
	selectionLabel: "Mattermost (plugin)",
	detailLabel: "Mattermost Bot",
	docsPath: "/channels/mattermost",
	docsLabel: "mattermost",
	blurb: "self-hosted Slack-style chat; install the plugin to enable.",
	systemImage: "bubble.left.and.bubble.right",
	order: 65,
	quickstartAllowFrom: true
};
function readMattermostReplyToId(params) {
	const readNormalizedValue = (value) => {
		if (typeof value !== "string") {return;}
		return value.trim() || void 0;
	};
	return readNormalizedValue(params.replyToId) ?? readNormalizedValue(params.replyTo);
}
function normalizeAllowEntry(entry) {
	return entry.trim().replace(/^(mattermost|user):/i, "").replace(/^@/, "").toLowerCase();
}
function formatAllowEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed) {return "";}
	if (trimmed.startsWith("@")) {
		const username = trimmed.slice(1).trim();
		return username ? `@${username.toLowerCase()}` : "";
	}
	return trimmed.replace(/^(mattermost|user):/i, "").toLowerCase();
}
const mattermostConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveMattermostAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
		allowFrom,
		normalizeEntry: formatAllowEntry
	})
});
const mattermostPlugin = {
	id: "mattermost",
	meta: { ...meta },
	setup: mattermostSetupAdapter,
	setupWizard: mattermostSetupWizard,
	pairing: {
		idLabel: "mattermostUserId",
		normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
		notifyApproval: async ({ id }) => {
			console.log(`[mattermost] User ${id} approved for pairing`);
		}
	},
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"group",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: true
	},
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	threading: { resolveReplyToMode: ({ cfg, accountId, chatType }) => {
		return resolveMattermostReplyToMode(resolveMattermostAccount({
			cfg,
			accountId: accountId ?? "default"
		}), chatType === "direct" || chatType === "group" || chatType === "channel" ? chatType : "channel");
	} },
	reload: { configPrefixes: ["channels.mattermost"] },
	configSchema: buildChannelConfigSchema(MattermostConfigSchema),
	config: {
		listAccountIds: (cfg) => listMattermostAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveMattermostAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultMattermostAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "mattermost",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "mattermost",
			accountId,
			clearBaseFields: [
				"botToken",
				"baseUrl",
				"name"
			]
		}),
		isConfigured: (account) => Boolean(account.botToken && account.baseUrl),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.botToken && account.baseUrl),
			botTokenSource: account.botTokenSource,
			baseUrl: account.baseUrl
		}),
		...mattermostConfigAccessors
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "mattermost",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => normalizeAllowEntry(raw)
			});
		},
		collectWarnings: ({ account, cfg }) => {
			return collectAllowlistProviderRestrictSendersWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.mattermost !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				surface: "Mattermost channels",
				openScope: "any member",
				groupPolicyPath: "channels.mattermost.groupPolicy",
				groupAllowFromPath: "channels.mattermost.groupAllowFrom"
			});
		}
	},
	groups: { resolveRequireMention: resolveMattermostGroupRequireMention },
	actions: mattermostMessageActions,
	directory: {
		listGroups: async (params) => listMattermostDirectoryGroups(params),
		listGroupsLive: async (params) => listMattermostDirectoryGroups(params),
		listPeers: async (params) => listMattermostDirectoryPeers(params),
		listPeersLive: async (params) => listMattermostDirectoryPeers(params)
	},
	messaging: {
		normalizeTarget: normalizeMattermostMessagingTarget,
		targetResolver: {
			looksLikeId: looksLikeMattermostTargetId,
			hint: "<channelId|user:ID|channel:ID>",
			resolveTarget: async ({ cfg, accountId, input }) => {
				const resolved = await resolveMattermostOpaqueTarget({
					input,
					cfg,
					accountId
				});
				if (!resolved) {return null;}
				return {
					to: resolved.to,
					kind: resolved.kind,
					source: "directory"
				};
			}
		}
	},
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getMattermostRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		resolveTarget: ({ to }) => {
			const trimmed = to?.trim();
			if (!trimmed) {return {
				ok: false,
				error: /* @__PURE__ */ new Error("Delivering to Mattermost requires --to <channelId|@username|user:ID|channel:ID>")
			};}
			return {
				ok: true,
				to: trimmed
			};
		},
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
			return {
				channel: "mattermost",
				...await sendMessageMattermost(to, text, {
					cfg,
					accountId: accountId ?? void 0,
					replyToId: replyToId ?? (threadId != null ? String(threadId) : void 0)
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, threadId }) => {
			return {
				channel: "mattermost",
				...await sendMessageMattermost(to, text, {
					cfg,
					accountId: accountId ?? void 0,
					mediaUrl,
					mediaLocalRoots,
					replyToId: replyToId ?? (threadId != null ? String(threadId) : void 0)
				})
			};
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			connected: false,
			lastConnectedAt: null,
			lastDisconnect: null,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
			botTokenSource: snapshot.botTokenSource ?? "none",
			connected: snapshot.connected ?? false,
			baseUrl: snapshot.baseUrl ?? null
		}),
		probeAccount: async ({ account, timeoutMs }) => {
			const token = account.botToken?.trim();
			const baseUrl = account.baseUrl?.trim();
			if (!token || !baseUrl) {return {
				ok: false,
				error: "bot token or baseUrl missing"
			};}
			return await probeMattermost(baseUrl, token, timeoutMs);
		},
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured: Boolean(account.botToken && account.baseUrl),
					runtime,
					probe
				}),
				botTokenSource: account.botTokenSource,
				baseUrl: account.baseUrl,
				connected: runtime?.connected ?? false,
				lastConnectedAt: runtime?.lastConnectedAt ?? null,
				lastDisconnect: runtime?.lastDisconnect ?? null
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const statusSink = createAccountStatusSink({
			accountId: ctx.accountId,
			setStatus: ctx.setStatus
		});
		statusSink({
			baseUrl: account.baseUrl,
			botTokenSource: account.botTokenSource
		});
		ctx.log?.info(`[${account.accountId}] starting channel`);
		return monitorMattermostProvider({
			botToken: account.botToken ?? void 0,
			baseUrl: account.baseUrl ?? void 0,
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			statusSink
		});
	} }
};
//#endregion
export { registerSlashCommandRoute as n, setMattermostRuntime as r, mattermostPlugin as t };
