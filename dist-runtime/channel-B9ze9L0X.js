import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { $t as createAccountListHelpers, At as GROUP_POLICY_BLOCKED_LABEL, Bn as ReplyRuntimeConfigSchemaShape, Bt as resolveNestedAllowlistDecision, En as DmPolicySchema, Et as evaluateMatchedGroupAccessForPolicy, Fn as MarkdownConfigSchema, It as buildChannelKeyCandidates, Lt as normalizeChannelSlug, Mt as resolveDefaultGroupPolicy, Pt as warnMissingProviderGroupPolicyFallbackOnce, Qn as requireOpenAllowFrom, _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, d as tryReadSecretFileSync, dr as applyAccountNameToChannelSection, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, hn as clearAccountEntryFields, hr as patchScopedAccountConfig, jt as resolveAllowlistProviderRuntimeGroupPolicy, kn as GroupPolicySchema, zt as resolveChannelEntryMatchWithFallback } from "./resolve-route-BZ4hHpx2.js";
import { i as hasConfiguredSecretInput, s as normalizeResolvedSecretInputString } from "./types.secrets-apkw3WZr.js";
import { t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { Cl as formatDocsLink, Cp as mapAllowFromEntries, Do as readRequestBodyWithLimit, El as mergeAllowFromEntries, Ft as resolveMentionGatingWithBypass, Il as setSetupChannelEnabled, Io as logInboundDrop, M as collectOpenGroupPolicyRouteAllowlistWarnings, Nl as resolveSetupAccountId, O as collectAllowlistProviderGroupPolicyWarnings, Oo as requestBodyErrorToText, Ot as readStoreAllowFromForDmPolicy, Rl as setTopLevelChannelDmPolicyWithAllowFrom, Ru as buildBaseChannelStatusSummary, Sf as ToolPolicySchema, To as isRequestBodyLimitError, Vu as buildRuntimeAccountStatusSnapshot, ao as createScopedPairingAccess, b as createPluginRuntimeStore, bt as formatAllowFromLowercase, ko as buildSecretInputSchema, kt as resolveDmGroupAccessWithCommandGate, no as createPersistentDedupe, ro as issuePairingChallenge, xa as resolveAccountWithDefaultFallback } from "./auth-profiles-CuJtivJK.js";
import { f as fetchWithSsrFGuard } from "./external-content-vZzOHxnd.js";
import { c as formatTextWithAttachmentLinks, o as dispatchInboundReplyWithBase, u as resolveOutboundMediaUrls } from "./compat-DDXNEdAm.js";
import { n as runStoppablePassiveMonitor, t as resolveLoggerBackedRuntime } from "./runtime-De-gSpe6.js";
import { t as requireChannelOpenAllowFrom } from "./config-schema-helpers-B9BKxgs0.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region extensions/nextcloud-talk/src/accounts.ts
function isTruthyEnvValue(value) {
	const normalized = (value ?? "").trim().toLowerCase();
	return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}
const debugAccounts = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_NEXTCLOUD_TALK_ACCOUNTS)) {console.warn("[nextcloud-talk:accounts]", ...args);}
};
const { listAccountIds: listNextcloudTalkAccountIdsInternal, resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId } = createAccountListHelpers("nextcloud-talk", { normalizeAccountId });
function listNextcloudTalkAccountIds(cfg) {
	const ids = listNextcloudTalkAccountIdsInternal(cfg);
	debugAccounts("listNextcloudTalkAccountIds", ids);
	return ids;
}
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.["nextcloud-talk"]?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	const direct = accounts[accountId];
	if (direct) {return direct;}
	const normalized = normalizeAccountId(accountId);
	const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
function mergeNextcloudTalkAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = cfg.channels?.["nextcloud-talk"] ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function resolveNextcloudTalkSecret(cfg, opts) {
	const merged = mergeNextcloudTalkAccountConfig(cfg, opts.accountId ?? "default");
	const envSecret = process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim();
	if (envSecret && (!opts.accountId || opts.accountId === "default")) {return {
		secret: envSecret,
		source: "env"
	};}
	if (merged.botSecretFile) {
		const fileSecret = tryReadSecretFileSync(merged.botSecretFile, "Nextcloud Talk bot secret file", { rejectSymlink: true });
		if (fileSecret) {return {
			secret: fileSecret,
			source: "secretFile"
		};}
	}
	const inlineSecret = normalizeResolvedSecretInputString({
		value: merged.botSecret,
		path: `channels.nextcloud-talk.accounts.${opts.accountId ?? "default"}.botSecret`
	});
	if (inlineSecret) {return {
		secret: inlineSecret,
		source: "config"
	};}
	return {
		secret: "",
		source: "none"
	};
}
function resolveNextcloudTalkAccount(params) {
	const baseEnabled = params.cfg.channels?.["nextcloud-talk"]?.enabled !== false;
	const resolve = (accountId) => {
		const merged = mergeNextcloudTalkAccountConfig(params.cfg, accountId);
		const accountEnabled = merged.enabled !== false;
		const enabled = baseEnabled && accountEnabled;
		const secretResolution = resolveNextcloudTalkSecret(params.cfg, { accountId });
		const baseUrl = merged.baseUrl?.trim()?.replace(/\/$/, "") ?? "";
		debugAccounts("resolve", {
			accountId,
			enabled,
			secretSource: secretResolution.source,
			baseUrl: baseUrl ? "[set]" : "[missing]"
		});
		return {
			accountId,
			enabled,
			name: merged.name?.trim() || void 0,
			baseUrl,
			secret: secretResolution.secret,
			secretSource: secretResolution.source,
			config: merged
		};
	};
	return resolveAccountWithDefaultFallback({
		accountId: params.accountId,
		normalizeAccountId,
		resolvePrimary: resolve,
		hasCredential: (account) => account.secretSource !== "none",
		resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg)
	});
}
//#endregion
//#region extensions/nextcloud-talk/src/config-schema.ts
const NextcloudTalkRoomSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).strict();
const NextcloudTalkAccountSchemaBase = z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	baseUrl: z.string().optional(),
	botSecret: buildSecretInputSchema().optional(),
	botSecretFile: z.string().optional(),
	apiUser: z.string().optional(),
	apiPassword: buildSecretInputSchema().optional(),
	apiPasswordFile: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	webhookPort: z.number().int().positive().optional(),
	webhookHost: z.string().optional(),
	webhookPath: z.string().optional(),
	webhookPublicUrl: z.string().optional(),
	allowFrom: z.array(z.string()).optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
	...ReplyRuntimeConfigSchemaShape
}).strict();
const NextcloudTalkAccountSchema = NextcloudTalkAccountSchemaBase.superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "nextcloud-talk",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
const NextcloudTalkConfigSchema = NextcloudTalkAccountSchemaBase.extend({
	accounts: z.record(z.string(), NextcloudTalkAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "nextcloud-talk",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
//#endregion
//#region extensions/nextcloud-talk/src/policy.ts
function normalizeAllowEntry(raw) {
	return raw.trim().toLowerCase().replace(/^(nextcloud-talk|nc-talk|nc):/i, "");
}
function normalizeNextcloudTalkAllowlist(values) {
	return (values ?? []).map((value) => normalizeAllowEntry(String(value))).filter(Boolean);
}
function resolveNextcloudTalkAllowlistMatch(params) {
	const allowFrom = normalizeNextcloudTalkAllowlist(params.allowFrom);
	if (allowFrom.length === 0) {return { allowed: false };}
	if (allowFrom.includes("*")) {return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};}
	const senderId = normalizeAllowEntry(params.senderId);
	if (allowFrom.includes(senderId)) {return {
		allowed: true,
		matchKey: senderId,
		matchSource: "id"
	};}
	return { allowed: false };
}
function resolveNextcloudTalkRoomMatch(params) {
	const rooms = params.rooms ?? {};
	const allowlistConfigured = Object.keys(rooms).length > 0;
	const match = resolveChannelEntryMatchWithFallback({
		entries: rooms,
		keys: buildChannelKeyCandidates(params.roomToken),
		wildcardKey: "*",
		normalizeKey: normalizeChannelSlug
	});
	const roomConfig = match.entry;
	const allowed = resolveNestedAllowlistDecision({
		outerConfigured: allowlistConfigured,
		outerMatched: Boolean(roomConfig),
		innerConfigured: false,
		innerMatched: false
	});
	return {
		roomConfig,
		wildcardConfig: match.wildcardEntry,
		roomKey: match.matchKey ?? match.key,
		matchSource: match.matchSource,
		allowed,
		allowlistConfigured
	};
}
function resolveNextcloudTalkGroupToolPolicy(params) {
	const cfg = params.cfg;
	const roomToken = params.groupId?.trim();
	if (!roomToken) {return;}
	const match = resolveNextcloudTalkRoomMatch({
		rooms: cfg.channels?.["nextcloud-talk"]?.rooms,
		roomToken
	});
	return match.roomConfig?.tools ?? match.wildcardConfig?.tools;
}
function resolveNextcloudTalkRequireMention(params) {
	if (typeof params.roomConfig?.requireMention === "boolean") {return params.roomConfig.requireMention;}
	if (typeof params.wildcardConfig?.requireMention === "boolean") {return params.wildcardConfig.requireMention;}
	return true;
}
function resolveNextcloudTalkGroupAllow(params) {
	const outerAllow = normalizeNextcloudTalkAllowlist(params.outerAllowFrom);
	const innerAllow = normalizeNextcloudTalkAllowlist(params.innerAllowFrom);
	const outerMatch = resolveNextcloudTalkAllowlistMatch({
		allowFrom: params.outerAllowFrom,
		senderId: params.senderId
	});
	const innerMatch = resolveNextcloudTalkAllowlistMatch({
		allowFrom: params.innerAllowFrom,
		senderId: params.senderId
	});
	return {
		allowed: evaluateMatchedGroupAccessForPolicy({
			groupPolicy: params.groupPolicy,
			allowlistConfigured: outerAllow.length > 0 || innerAllow.length > 0,
			allowlistMatched: resolveNestedAllowlistDecision({
				outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
				outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
				innerConfigured: innerAllow.length > 0,
				innerMatched: innerMatch.allowed
			})
		}).allowed,
		outerMatch: params.groupPolicy === "open" ? { allowed: true } : params.groupPolicy === "disabled" ? { allowed: false } : outerMatch,
		innerMatch: params.groupPolicy === "open" ? { allowed: true } : params.groupPolicy === "disabled" ? { allowed: false } : innerMatch
	};
}
function resolveNextcloudTalkMentionGate(params) {
	const result = resolveMentionGatingWithBypass({
		isGroup: params.isGroup,
		requireMention: params.requireMention,
		canDetectMention: true,
		wasMentioned: params.wasMentioned,
		allowTextCommands: params.allowTextCommands,
		hasControlCommand: params.hasControlCommand,
		commandAuthorized: params.commandAuthorized
	});
	return {
		shouldSkip: result.shouldSkip,
		shouldBypassMention: result.shouldBypassMention
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/room-info.ts
const ROOM_CACHE_TTL_MS = 300 * 1e3;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1e3;
const roomCache = /* @__PURE__ */ new Map();
function resolveRoomCacheKey(params) {
	return `${params.accountId}:${params.roomToken}`;
}
function readApiPassword(params) {
	const inlinePassword = normalizeResolvedSecretInputString({
		value: params.apiPassword,
		path: "channels.nextcloud-talk.apiPassword"
	});
	if (inlinePassword) {return inlinePassword;}
	if (!params.apiPasswordFile) {return;}
	try {
		return readFileSync(params.apiPasswordFile, "utf-8").trim() || void 0;
	} catch {
		return;
	}
}
function coerceRoomType(value) {
	if (typeof value === "number" && Number.isFinite(value)) {return value;}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function resolveRoomKindFromType(type) {
	if (!type) {return;}
	if (type === 1 || type === 5 || type === 6) {return "direct";}
	return "group";
}
async function resolveNextcloudTalkRoomKind(params) {
	const { account, roomToken, runtime } = params;
	const key = resolveRoomCacheKey({
		accountId: account.accountId,
		roomToken
	});
	const cached = roomCache.get(key);
	if (cached) {
		const age = Date.now() - cached.fetchedAt;
		if (cached.kind && age < ROOM_CACHE_TTL_MS) {return cached.kind;}
		if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) {return;}
	}
	const apiUser = account.config.apiUser?.trim();
	const apiPassword = readApiPassword({
		apiPassword: account.config.apiPassword,
		apiPasswordFile: account.config.apiPasswordFile
	});
	if (!apiUser || !apiPassword) {return;}
	const baseUrl = account.baseUrl?.trim();
	if (!baseUrl) {return;}
	const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`;
	const auth = Buffer.from(`${apiUser}:${apiPassword}`, "utf-8").toString("base64");
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url,
			init: {
				method: "GET",
				headers: {
					Authorization: `Basic ${auth}`,
					"OCS-APIRequest": "true",
					Accept: "application/json"
				}
			},
			auditContext: "nextcloud-talk.room-info"
		});
		try {
			if (!response.ok) {
				roomCache.set(key, {
					fetchedAt: Date.now(),
					error: `status:${response.status}`
				});
				runtime?.log?.(`nextcloud-talk: room lookup failed (${response.status}) token=${roomToken}`);
				return;
			}
			const kind = resolveRoomKindFromType(coerceRoomType((await response.json()).ocs?.data?.type));
			roomCache.set(key, {
				fetchedAt: Date.now(),
				kind
			});
			return kind;
		} finally {
			await release();
		}
	} catch (err) {
		roomCache.set(key, {
			fetchedAt: Date.now(),
			error: err instanceof Error ? err.message : String(err)
		});
		runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
		return;
	}
}
//#endregion
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore("Nextcloud Talk runtime not initialized");
//#endregion
//#region extensions/nextcloud-talk/src/normalize.ts
function stripNextcloudTalkTargetPrefix(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return;}
	let normalized = trimmed;
	if (normalized.startsWith("nextcloud-talk:")) {normalized = normalized.slice(15).trim();}
	else if (normalized.startsWith("nc-talk:")) {normalized = normalized.slice(8).trim();}
	else if (normalized.startsWith("nc:")) {normalized = normalized.slice(3).trim();}
	if (normalized.startsWith("room:")) {normalized = normalized.slice(5).trim();}
	if (!normalized) {return;}
	return normalized;
}
function normalizeNextcloudTalkMessagingTarget(raw) {
	const normalized = stripNextcloudTalkTargetPrefix(raw);
	return normalized ? `nextcloud-talk:${normalized}`.toLowerCase() : void 0;
}
function looksLikeNextcloudTalkTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return false;}
	if (/^(nextcloud-talk|nc-talk|nc):/i.test(trimmed)) {return true;}
	return /^[a-z0-9]{8,}$/i.test(trimmed);
}
//#endregion
//#region extensions/nextcloud-talk/src/signature.ts
const SIGNATURE_HEADER = "x-nextcloud-talk-signature";
const RANDOM_HEADER = "x-nextcloud-talk-random";
const BACKEND_HEADER = "x-nextcloud-talk-backend";
/**
* Verify the HMAC-SHA256 signature of an incoming webhook request.
* Signature is calculated as: HMAC-SHA256(random + body, secret)
*/
function verifyNextcloudTalkSignature(params) {
	const { signature, random, body, secret } = params;
	if (!signature || !random || !secret) {return false;}
	const expected = createHmac("sha256", secret).update(random + body).digest("hex");
	if (signature.length !== expected.length) {return false;}
	let result = 0;
	for (let i = 0; i < signature.length; i++) {result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);}
	return result === 0;
}
/**
* Extract webhook headers from an incoming request.
*/
function extractNextcloudTalkHeaders(headers) {
	const getHeader = (name) => {
		const value = headers[name] ?? headers[name.toLowerCase()];
		return Array.isArray(value) ? value[0] : value;
	};
	const signature = getHeader(SIGNATURE_HEADER);
	const random = getHeader(RANDOM_HEADER);
	const backend = getHeader(BACKEND_HEADER);
	if (!signature || !random || !backend) {return null;}
	return {
		signature,
		random,
		backend
	};
}
/**
* Generate signature headers for an outbound request to Nextcloud Talk.
*/
function generateNextcloudTalkSignature(params) {
	const { body, secret } = params;
	const random = randomBytes(32).toString("hex");
	return {
		random,
		signature: createHmac("sha256", secret).update(random + body).digest("hex")
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/send.ts
function resolveCredentials(explicit, account) {
	const baseUrl = explicit.baseUrl?.trim() ?? account.baseUrl;
	const secret = explicit.secret?.trim() ?? account.secret;
	if (!baseUrl) {throw new Error(`Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk.baseUrl).`);}
	if (!secret) {throw new Error(`Nextcloud Talk bot secret missing for account "${account.accountId}" (set channels.nextcloud-talk.botSecret/botSecretFile or NEXTCLOUD_TALK_BOT_SECRET for default).`);}
	return {
		baseUrl,
		secret
	};
}
function normalizeRoomToken(to) {
	const normalized = stripNextcloudTalkTargetPrefix(to);
	if (!normalized) {throw new Error("Room token is required for Nextcloud Talk sends");}
	return normalized;
}
function resolveNextcloudTalkSendContext(opts) {
	const cfg = opts.cfg ?? getNextcloudTalkRuntime().config.loadConfig();
	const account = resolveNextcloudTalkAccount({
		cfg,
		accountId: opts.accountId
	});
	const { baseUrl, secret } = resolveCredentials({
		baseUrl: opts.baseUrl,
		secret: opts.secret
	}, account);
	return {
		cfg,
		account,
		baseUrl,
		secret
	};
}
async function sendMessageNextcloudTalk(to, text, opts = {}) {
	const { cfg, account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
	const roomToken = normalizeRoomToken(to);
	if (!text?.trim()) {throw new Error("Message must be non-empty for Nextcloud Talk sends");}
	const tableMode = getNextcloudTalkRuntime().channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "nextcloud-talk",
		accountId: account.accountId
	});
	const message = getNextcloudTalkRuntime().channel.text.convertMarkdownTables(text.trim(), tableMode);
	const body = { message };
	if (opts.replyTo) {body.replyTo = opts.replyTo;}
	const bodyStr = JSON.stringify(body);
	const { random, signature } = generateNextcloudTalkSignature({
		body: message,
		secret
	});
	const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"OCS-APIRequest": "true",
			"X-Nextcloud-Talk-Bot-Random": random,
			"X-Nextcloud-Talk-Bot-Signature": signature
		},
		body: bodyStr
	});
	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		const status = response.status;
		let errorMsg = `Nextcloud Talk send failed (${status})`;
		if (status === 400) {errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;}
		else if (status === 401) {errorMsg = "Nextcloud Talk: authentication failed - check bot secret";}
		else if (status === 403) {errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";}
		else if (status === 404) {errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;}
		else if (errorBody) {errorMsg = `Nextcloud Talk send failed: ${errorBody}`;}
		throw new Error(errorMsg);
	}
	let messageId = "unknown";
	let timestamp;
	try {
		const data = await response.json();
		if (data.ocs?.data?.id != null) {messageId = String(data.ocs.data.id);}
		if (typeof data.ocs?.data?.timestamp === "number") {timestamp = data.ocs.data.timestamp;}
	} catch {}
	if (opts.verbose) {console.log(`[nextcloud-talk] Sent message ${messageId} to room ${roomToken}`);}
	getNextcloudTalkRuntime().channel.activity.record({
		channel: "nextcloud-talk",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId,
		roomToken,
		timestamp
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/inbound.ts
const CHANNEL_ID = "nextcloud-talk";
async function deliverNextcloudTalkReply(params) {
	const { payload, roomToken, accountId, statusSink } = params;
	const combined = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
	if (!combined) {return;}
	await sendMessageNextcloudTalk(roomToken, combined, {
		accountId,
		replyTo: payload.replyToId
	});
	statusSink?.({ lastOutboundAt: Date.now() });
}
async function handleNextcloudTalkInbound(params) {
	const { message, account, config, runtime, statusSink } = params;
	const core = getNextcloudTalkRuntime();
	const pairing = createScopedPairingAccess({
		core,
		channel: CHANNEL_ID,
		accountId: account.accountId
	});
	const rawBody = message.text?.trim() ?? "";
	if (!rawBody) {return;}
	const roomKind = await resolveNextcloudTalkRoomKind({
		account,
		roomToken: message.roomToken,
		runtime
	});
	const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
	const senderId = message.senderId;
	const senderName = message.senderName;
	const roomToken = message.roomToken;
	const roomName = message.roomName;
	statusSink?.({ lastInboundAt: message.timestamp });
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: (config.channels?.["nextcloud-talk"] ?? void 0) !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "nextcloud-talk",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
		log: (message) => runtime.log?.(message)
	});
	const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
	const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
	const storeAllowList = normalizeNextcloudTalkAllowlist(await readStoreAllowFromForDmPolicy({
		provider: CHANNEL_ID,
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	}));
	const roomMatch = resolveNextcloudTalkRoomMatch({
		rooms: account.config.rooms,
		roomToken
	});
	const roomConfig = roomMatch.roomConfig;
	if (isGroup && !roomMatch.allowed) {
		runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
		return;
	}
	if (roomConfig?.enabled === false) {
		runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
		return;
	}
	const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg: config,
		surface: CHANNEL_ID
	});
	const useAccessGroups = config.commands?.useAccessGroups !== false;
	const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
	const access = resolveDmGroupAccessWithCommandGate({
		isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: configAllowFrom,
		groupAllowFrom: configGroupAllowFrom,
		storeAllowFrom: storeAllowList,
		isSenderAllowed: (allowFrom) => resolveNextcloudTalkAllowlistMatch({
			allowFrom,
			senderId
		}).allowed,
		command: {
			useAccessGroups,
			allowTextCommands,
			hasControlCommand
		}
	});
	const commandAuthorized = access.commandAuthorized;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	if (isGroup) {
		if (access.decision !== "allow") {
			runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${access.reason})`);
			return;
		}
		if (!resolveNextcloudTalkGroupAllow({
			groupPolicy,
			outerAllowFrom: effectiveGroupAllowFrom,
			innerAllowFrom: roomAllowFrom,
			senderId
		}).allowed) {
			runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
			return;
		}
	} else if (access.decision !== "allow") {
		if (access.decision === "pairing") {await issuePairingChallenge({
			channel: CHANNEL_ID,
			senderId,
			senderIdLine: `Your Nextcloud user id: ${senderId}`,
			meta: { name: senderName || void 0 },
			upsertPairingRequest: pairing.upsertPairingRequest,
			sendPairingReply: async (text) => {
				await sendMessageNextcloudTalk(roomToken, text, { accountId: account.accountId });
				statusSink?.({ lastOutboundAt: Date.now() });
			},
			onReplyError: (err) => {
				runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
			}
		});}
		runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${access.reason})`);
		return;
	}
	if (access.shouldBlockControlCommand) {
		logInboundDrop({
			log: (message) => runtime.log?.(message),
			channel: CHANNEL_ID,
			reason: "control command (unauthorized)",
			target: senderId
		});
		return;
	}
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
	const wasMentioned = mentionRegexes.length ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) : false;
	const mentionGate = resolveNextcloudTalkMentionGate({
		isGroup,
		requireMention: isGroup ? resolveNextcloudTalkRequireMention({
			roomConfig,
			wildcardConfig: roomMatch.wildcardConfig
		}) : false,
		wasMentioned,
		allowTextCommands,
		hasControlCommand,
		commandAuthorized
	});
	if (isGroup && mentionGate.shouldSkip) {
		runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
		return;
	}
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: isGroup ? roomToken : senderId
		}
	});
	const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "Nextcloud Talk",
		from: fromLabel,
		timestamp: message.timestamp,
		previousTimestamp,
		envelope: envelopeOptions,
		body: rawBody
	});
	const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || void 0;
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		RawBody: rawBody,
		CommandBody: rawBody,
		From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
		To: `nextcloud-talk:${roomToken}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		SenderName: senderName || void 0,
		SenderId: senderId,
		GroupSubject: isGroup ? roomName || roomToken : void 0,
		GroupSystemPrompt: isGroup ? groupSystemPrompt : void 0,
		Provider: CHANNEL_ID,
		Surface: CHANNEL_ID,
		WasMentioned: isGroup ? wasMentioned : void 0,
		MessageSid: message.messageId,
		Timestamp: message.timestamp,
		OriginatingChannel: CHANNEL_ID,
		OriginatingTo: `nextcloud-talk:${roomToken}`,
		CommandAuthorized: commandAuthorized
	});
	await dispatchInboundReplyWithBase({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		route,
		storePath,
		ctxPayload,
		core,
		deliver: async (payload) => {
			await deliverNextcloudTalkReply({
				payload,
				roomToken,
				accountId: account.accountId,
				statusSink
			});
		},
		onRecordError: (err) => {
			runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
		},
		onDispatchError: (err, info) => {
			runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
		},
		replyOptions: {
			skillFilter: roomConfig?.skills,
			disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
		}
	});
}
//#endregion
//#region extensions/nextcloud-talk/src/replay-guard.ts
const DEFAULT_REPLAY_TTL_MS = 1440 * 60 * 1e3;
const DEFAULT_MEMORY_MAX_SIZE = 1e3;
const DEFAULT_FILE_MAX_ENTRIES = 1e4;
function sanitizeSegment(value) {
	const trimmed = value.trim();
	if (!trimmed) {return "default";}
	return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function buildReplayKey(params) {
	const roomToken = params.roomToken.trim();
	const messageId = params.messageId.trim();
	if (!roomToken || !messageId) {return null;}
	return `${roomToken}:${messageId}`;
}
function createNextcloudTalkReplayGuard(options) {
	const stateDir = options.stateDir.trim();
	const persistentDedupe = createPersistentDedupe({
		ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
		memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
		fileMaxEntries: options.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES,
		resolveFilePath: (namespace) => path.join(stateDir, "nextcloud-talk", "replay-dedupe", `${sanitizeSegment(namespace)}.json`)
	});
	return { shouldProcessMessage: async ({ accountId, roomToken, messageId }) => {
		const replayKey = buildReplayKey({
			roomToken,
			messageId
		});
		if (!replayKey) {return true;}
		return await persistentDedupe.checkAndRecord(replayKey, {
			namespace: accountId,
			onDiskError: options.onDiskError
		});
	} };
}
//#endregion
//#region extensions/nextcloud-talk/src/monitor.ts
const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5e3;
const HEALTH_PATH = "/healthz";
const WEBHOOK_ERRORS = {
	missingSignatureHeaders: "Missing signature headers",
	invalidBackend: "Invalid backend",
	invalidSignature: "Invalid signature",
	invalidPayloadFormat: "Invalid payload format",
	payloadTooLarge: "Payload too large",
	internalServerError: "Internal server error"
};
function formatError(err) {
	if (err instanceof Error) {return err.message;}
	return typeof err === "string" ? err : JSON.stringify(err);
}
function normalizeOrigin(value) {
	try {
		return new URL(value).origin.toLowerCase();
	} catch {
		return null;
	}
}
function parseWebhookPayload(body) {
	try {
		const data = JSON.parse(body);
		if (!data.type || !data.actor?.type || !data.actor?.id || !data.object?.type || !data.object?.id || !data.target?.type || !data.target?.id) {return null;}
		return data;
	} catch {
		return null;
	}
}
function writeJsonResponse(res, status, body) {
	if (body) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
		return;
	}
	res.writeHead(status);
	res.end();
}
function writeWebhookError(res, status, error) {
	if (res.headersSent) {return;}
	writeJsonResponse(res, status, { error });
}
function validateWebhookHeaders(params) {
	const headers = extractNextcloudTalkHeaders(params.req.headers);
	if (!headers) {
		writeWebhookError(params.res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
		return null;
	}
	if (params.isBackendAllowed && !params.isBackendAllowed(headers.backend)) {
		writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidBackend);
		return null;
	}
	return headers;
}
function verifyWebhookSignature(params) {
	if (!verifyNextcloudTalkSignature({
		signature: params.headers.signature,
		random: params.headers.random,
		body: params.body,
		secret: params.secret
	})) {
		writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
		return false;
	}
	return true;
}
function decodeWebhookCreateMessage(params) {
	const payload = parseWebhookPayload(params.body);
	if (!payload) {
		writeWebhookError(params.res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
		return { kind: "invalid" };
	}
	if (payload.type !== "Create") {return { kind: "ignore" };}
	return {
		kind: "message",
		message: payloadToInboundMessage(payload)
	};
}
function payloadToInboundMessage(payload) {
	return {
		messageId: String(payload.object.id),
		roomToken: payload.target.id,
		roomName: payload.target.name,
		senderId: payload.actor.id,
		senderName: payload.actor.name ?? "",
		text: payload.object.content || payload.object.name || "",
		mediaType: payload.object.mediaType || "text/plain",
		timestamp: Date.now(),
		isGroupChat: true
	};
}
function readNextcloudTalkWebhookBody(req, maxBodyBytes) {
	return readRequestBodyWithLimit(req, {
		maxBytes: Math.min(maxBodyBytes, PREAUTH_WEBHOOK_MAX_BODY_BYTES),
		timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS
	});
}
function createNextcloudTalkWebhookServer(opts) {
	const { port, host, path, secret, onMessage, onError, abortSignal } = opts;
	const maxBodyBytes = typeof opts.maxBodyBytes === "number" && Number.isFinite(opts.maxBodyBytes) && opts.maxBodyBytes > 0 ? Math.floor(opts.maxBodyBytes) : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
	const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
	const isBackendAllowed = opts.isBackendAllowed;
	const shouldProcessMessage = opts.shouldProcessMessage;
	const server = createServer(async (req, res) => {
		if (req.url === HEALTH_PATH) {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
			return;
		}
		if (req.url !== path || req.method !== "POST") {
			res.writeHead(404);
			res.end();
			return;
		}
		try {
			const headers = validateWebhookHeaders({
				req,
				res,
				isBackendAllowed
			});
			if (!headers) {return;}
			const body = await readBody(req, maxBodyBytes);
			if (!verifyWebhookSignature({
				headers,
				body,
				secret,
				res
			})) {return;}
			const decoded = decodeWebhookCreateMessage({
				body,
				res
			});
			if (decoded.kind === "invalid") {return;}
			if (decoded.kind === "ignore") {
				writeJsonResponse(res, 200);
				return;
			}
			const message = decoded.message;
			if (shouldProcessMessage) {
				if (!await shouldProcessMessage(message)) {
					writeJsonResponse(res, 200);
					return;
				}
			}
			writeJsonResponse(res, 200);
			try {
				await onMessage(message);
			} catch (err) {
				onError?.(err instanceof Error ? err : new Error(formatError(err)));
			}
		} catch (err) {
			if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
				writeWebhookError(res, 413, WEBHOOK_ERRORS.payloadTooLarge);
				return;
			}
			if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
				writeWebhookError(res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
				return;
			}
			const error = err instanceof Error ? err : new Error(formatError(err));
			onError?.(error);
			writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
		}
	});
	const start = () => {
		return new Promise((resolve) => {
			server.listen(port, host, () => resolve());
		});
	};
	let stopped = false;
	const stop = () => {
		if (stopped) {return;}
		stopped = true;
		try {
			server.close();
		} catch {}
	};
	if (abortSignal) {if (abortSignal.aborted) stop();
	else abortSignal.addEventListener("abort", stop, { once: true });}
	return {
		server,
		start,
		stop
	};
}
async function monitorNextcloudTalkProvider(opts) {
	const core = getNextcloudTalkRuntime();
	const cfg = opts.config ?? core.config.loadConfig();
	const account = resolveNextcloudTalkAccount({
		cfg,
		accountId: opts.accountId
	});
	const runtime = resolveLoggerBackedRuntime(opts.runtime, core.logging.getChildLogger());
	if (!account.secret) {throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);}
	const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
	const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
	const path = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;
	const logger = core.logging.getChildLogger({
		channel: "nextcloud-talk",
		accountId: account.accountId
	});
	const expectedBackendOrigin = normalizeOrigin(account.baseUrl);
	const replayGuard = createNextcloudTalkReplayGuard({
		stateDir: core.state.resolveStateDir(process.env, os.homedir),
		onDiskError: (error) => {
			logger.warn(`[nextcloud-talk:${account.accountId}] replay guard disk error: ${String(error)}`);
		}
	});
	const { start, stop } = createNextcloudTalkWebhookServer({
		port,
		host,
		path,
		secret: account.secret,
		isBackendAllowed: (backend) => {
			if (!expectedBackendOrigin) {return true;}
			return normalizeOrigin(backend) === expectedBackendOrigin;
		},
		shouldProcessMessage: async (message) => {
			const shouldProcess = await replayGuard.shouldProcessMessage({
				accountId: account.accountId,
				roomToken: message.roomToken,
				messageId: message.messageId
			});
			if (!shouldProcess) {logger.warn(`[nextcloud-talk:${account.accountId}] replayed webhook ignored room=${message.roomToken} messageId=${message.messageId}`);}
			return shouldProcess;
		},
		onMessage: async (message) => {
			core.channel.activity.record({
				channel: "nextcloud-talk",
				accountId: account.accountId,
				direction: "inbound",
				at: message.timestamp
			});
			if (opts.onMessage) {
				await opts.onMessage(message);
				return;
			}
			await handleNextcloudTalkInbound({
				message,
				account,
				config: cfg,
				runtime,
				statusSink: opts.statusSink
			});
		},
		onError: (error) => {
			logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
		},
		abortSignal: opts.abortSignal
	});
	if (opts.abortSignal?.aborted) {return { stop };}
	await start();
	if (opts.abortSignal?.aborted) {
		stop();
		return { stop };
	}
	const publicUrl = account.config.webhookPublicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
	logger.info(`[nextcloud-talk:${account.accountId}] webhook listening on ${publicUrl}`);
	return { stop };
}
//#endregion
//#region extensions/nextcloud-talk/src/setup-core.ts
const channel$1 = "nextcloud-talk";
function normalizeNextcloudTalkBaseUrl(value) {
	return value?.trim().replace(/\/+$/, "") ?? "";
}
function validateNextcloudTalkBaseUrl(value) {
	if (!value) {return "Required";}
	if (!value.startsWith("http://") && !value.startsWith("https://")) {return "URL must start with http:// or https://";}
}
function setNextcloudTalkAccountConfig(cfg, accountId, updates) {
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel$1,
		accountId,
		patch: updates
	});
}
function clearNextcloudTalkAccountFields(cfg, accountId, fields) {
	const section = cfg.channels?.["nextcloud-talk"];
	if (!section) {return cfg;}
	if (accountId === "default") {
		const nextSection = { ...section };
		for (const field of fields) {delete nextSection[field];}
		return {
			...cfg,
			channels: {
				...cfg.channels,
				"nextcloud-talk": nextSection
			}
		};
	}
	const currentAccount = section.accounts?.[accountId];
	if (!currentAccount) {return cfg;}
	const nextAccount = { ...currentAccount };
	for (const field of fields) {delete nextAccount[field];}
	return {
		...cfg,
		channels: {
			...cfg.channels,
			"nextcloud-talk": {
				...section,
				accounts: {
					...section.accounts,
					[accountId]: nextAccount
				}
			}
		}
	};
}
const nextcloudTalkSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => {
		const setupInput = input;
		if (setupInput.useEnv && accountId !== "default") {return "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.";}
		if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) {return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";}
		if (!setupInput.baseUrl) {return "Nextcloud Talk requires --base-url.";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const setupInput = input;
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: setupInput.name
		});
		return setNextcloudTalkAccountConfig(setupInput.useEnv ? clearNextcloudTalkAccountFields(namedConfig, accountId, ["botSecret", "botSecretFile"]) : namedConfig, accountId, {
			baseUrl: normalizeNextcloudTalkBaseUrl(setupInput.baseUrl),
			...setupInput.useEnv ? {} : setupInput.secretFile ? { botSecretFile: setupInput.secretFile } : setupInput.secret ? { botSecret: setupInput.secret } : {}
		});
	}
};
//#endregion
//#region extensions/nextcloud-talk/src/setup-surface.ts
const channel = "nextcloud-talk";
const CONFIGURE_API_FLAG = "__nextcloudTalkConfigureApiCredentials";
function setNextcloudTalkDmPolicy(cfg, dmPolicy) {
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy
	});
}
async function promptNextcloudTalkAllowFrom(params) {
	const existingAllowFrom = resolveNextcloudTalkAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.allowFrom ?? [];
	await params.prompter.note([
		"1) Check the Nextcloud admin panel for user IDs",
		"2) Or look at the webhook payload logs when someone messages",
		"3) User IDs are typically lowercase usernames in Nextcloud",
		`Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`
	].join("\n"), "Nextcloud Talk user id");
	let resolvedIds = [];
	while (resolvedIds.length === 0) {
		const entry = await params.prompter.text({
			message: "Nextcloud Talk allowFrom (user id)",
			placeholder: "username",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		resolvedIds = String(entry).split(/[\n,;]+/g).map((value) => value.trim().toLowerCase()).filter(Boolean);
		if (resolvedIds.length === 0) {await params.prompter.note("Please enter at least one valid user ID.", "Nextcloud Talk");}
	}
	return setNextcloudTalkAccountConfig(params.cfg, params.accountId, {
		dmPolicy: "allowlist",
		allowFrom: mergeAllowFromEntries(existingAllowFrom.map((value) => String(value).trim().toLowerCase()), resolvedIds)
	});
}
async function promptNextcloudTalkAllowFromForAccount(params) {
	const accountId = resolveSetupAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultNextcloudTalkAccountId(params.cfg)
	});
	return await promptNextcloudTalkAllowFrom({
		cfg: params.cfg,
		prompter: params.prompter,
		accountId
	});
}
const nextcloudTalkDmPolicy = {
	label: "Nextcloud Talk",
	channel,
	policyKey: "channels.nextcloud-talk.dmPolicy",
	allowFromKey: "channels.nextcloud-talk.allowFrom",
	getCurrent: (cfg) => cfg.channels?.["nextcloud-talk"]?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setNextcloudTalkDmPolicy(cfg, policy),
	promptAllowFrom: promptNextcloudTalkAllowFromForAccount
};
const nextcloudTalkPlugin = {
	id: "nextcloud-talk",
	meta: {
		id: "nextcloud-talk",
		label: "Nextcloud Talk",
		selectionLabel: "Nextcloud Talk (self-hosted)",
		docsPath: "/channels/nextcloud-talk",
		docsLabel: "nextcloud-talk",
		blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
		aliases: ["nc-talk", "nc"],
		order: 65,
		quickstartAllowFrom: true
	},
	setupWizard: {
		channel,
		stepOrder: "text-first",
		status: {
			configuredLabel: "configured",
			unconfiguredLabel: "needs setup",
			configuredHint: "configured",
			unconfiguredHint: "self-hosted chat",
			configuredScore: 1,
			unconfiguredScore: 5,
			resolveConfigured: ({ cfg }) => listNextcloudTalkAccountIds(cfg).some((accountId) => {
				const account = resolveNextcloudTalkAccount({
					cfg,
					accountId
				});
				return Boolean(account.secret && account.baseUrl);
			})
		},
		introNote: {
			title: "Nextcloud Talk bot setup",
			lines: [
				"1) SSH into your Nextcloud server",
				"2) Run: ./occ talk:bot:install \"OpenClaw\" \"<shared-secret>\" \"<webhook-url>\" --feature reaction",
				"3) Copy the shared secret you used in the command",
				"4) Enable the bot in your Nextcloud Talk room settings",
				"Tip: you can also set NEXTCLOUD_TALK_BOT_SECRET in your env.",
				`Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`
			],
			shouldShow: ({ cfg, accountId }) => {
				const account = resolveNextcloudTalkAccount({
					cfg,
					accountId
				});
				return !account.secret || !account.baseUrl;
			}
		},
		prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
			const resolvedAccount = resolveNextcloudTalkAccount({
				cfg,
				accountId
			});
			const hasApiCredentials = Boolean(resolvedAccount.config.apiUser?.trim() && (hasConfiguredSecretInput(resolvedAccount.config.apiPassword) || resolvedAccount.config.apiPasswordFile));
			if (!await prompter.confirm({
				message: "Configure optional Nextcloud Talk API credentials for room lookups?",
				initialValue: hasApiCredentials
			})) {return;}
			return { credentialValues: {
				...credentialValues,
				[CONFIGURE_API_FLAG]: "1"
			} };
		},
		credentials: [{
			inputKey: "token",
			providerHint: channel,
			credentialLabel: "bot secret",
			preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
			envPrompt: "NEXTCLOUD_TALK_BOT_SECRET detected. Use env var?",
			keepPrompt: "Nextcloud Talk bot secret already configured. Keep it?",
			inputPrompt: "Enter Nextcloud Talk bot secret",
			allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
			inspect: ({ cfg, accountId }) => {
				const resolvedAccount = resolveNextcloudTalkAccount({
					cfg,
					accountId
				});
				return {
					accountConfigured: Boolean(resolvedAccount.secret && resolvedAccount.baseUrl),
					hasConfiguredValue: Boolean(hasConfiguredSecretInput(resolvedAccount.config.botSecret) || resolvedAccount.config.botSecretFile),
					resolvedValue: resolvedAccount.secret || void 0,
					envValue: accountId === "default" ? process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim() || void 0 : void 0
				};
			},
			applyUseEnv: async (params) => {
				const resolvedAccount = resolveNextcloudTalkAccount({
					cfg: params.cfg,
					accountId: params.accountId
				});
				return setNextcloudTalkAccountConfig(clearNextcloudTalkAccountFields(params.cfg, params.accountId, ["botSecret", "botSecretFile"]), params.accountId, { baseUrl: resolvedAccount.baseUrl });
			},
			applySet: async (params) => setNextcloudTalkAccountConfig(clearNextcloudTalkAccountFields(params.cfg, params.accountId, ["botSecret", "botSecretFile"]), params.accountId, { botSecret: params.value })
		}, {
			inputKey: "password",
			providerHint: "nextcloud-talk-api",
			credentialLabel: "API password",
			preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
			envPrompt: "",
			keepPrompt: "Nextcloud Talk API password already configured. Keep it?",
			inputPrompt: "Enter Nextcloud Talk API password",
			inspect: ({ cfg, accountId }) => {
				const resolvedAccount = resolveNextcloudTalkAccount({
					cfg,
					accountId
				});
				const apiUser = resolvedAccount.config.apiUser?.trim();
				const apiPasswordConfigured = Boolean(hasConfiguredSecretInput(resolvedAccount.config.apiPassword) || resolvedAccount.config.apiPasswordFile);
				return {
					accountConfigured: Boolean(apiUser && apiPasswordConfigured),
					hasConfiguredValue: apiPasswordConfigured
				};
			},
			shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
			applySet: async (params) => setNextcloudTalkAccountConfig(clearNextcloudTalkAccountFields(params.cfg, params.accountId, ["apiPassword", "apiPasswordFile"]), params.accountId, { apiPassword: params.value })
		}],
		textInputs: [{
			inputKey: "httpUrl",
			message: "Enter Nextcloud instance URL (e.g., https://cloud.example.com)",
			currentValue: ({ cfg, accountId }) => resolveNextcloudTalkAccount({
				cfg,
				accountId
			}).baseUrl || void 0,
			shouldPrompt: ({ currentValue }) => !currentValue,
			validate: ({ value }) => validateNextcloudTalkBaseUrl(value),
			normalizeValue: ({ value }) => normalizeNextcloudTalkBaseUrl(value),
			applySet: async (params) => setNextcloudTalkAccountConfig(params.cfg, params.accountId, { baseUrl: params.value })
		}, {
			inputKey: "userId",
			message: "Nextcloud Talk API user",
			currentValue: ({ cfg, accountId }) => resolveNextcloudTalkAccount({
				cfg,
				accountId
			}).config.apiUser?.trim() || void 0,
			shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
			validate: ({ value }) => value ? void 0 : "Required",
			applySet: async (params) => setNextcloudTalkAccountConfig(params.cfg, params.accountId, { apiUser: params.value })
		}],
		dmPolicy: nextcloudTalkDmPolicy,
		disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
	},
	pairing: {
		idLabel: "nextcloudUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase(),
		notifyApproval: async ({ id }) => {
			console.log(`[nextcloud-talk] User ${id} approved for pairing`);
		}
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		reactions: true,
		threads: false,
		media: true,
		nativeCommands: false,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.nextcloud-talk"] },
	configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
	config: {
		listAccountIds: (cfg) => listNextcloudTalkAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveNextcloudTalkAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultNextcloudTalkAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "nextcloud-talk",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "nextcloud-talk",
			accountId,
			clearBaseFields: [
				"botSecret",
				"botSecretFile",
				"baseUrl",
				"name"
			]
		}),
		isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
			secretSource: account.secretSource,
			baseUrl: account.baseUrl ? "[set]" : "[missing]"
		}),
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveNextcloudTalkAccount({
			cfg,
			accountId
		}).config.allowFrom).map((entry) => entry.toLowerCase()),
		formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({
			allowFrom,
			stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "nextcloud-talk",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => raw.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase()
			});
		},
		collectWarnings: ({ account, cfg }) => {
			const roomAllowlistConfigured = account.config.rooms && Object.keys(account.config.rooms).length > 0;
			return collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.["nextcloud-talk"] !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyRouteAllowlistWarnings({
					groupPolicy,
					routeAllowlistConfigured: Boolean(roomAllowlistConfigured),
					restrictSenders: {
						surface: "Nextcloud Talk rooms",
						openScope: "any member in allowed rooms",
						groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
						groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom"
					},
					noRouteAllowlist: {
						surface: "Nextcloud Talk rooms",
						routeAllowlistPath: "channels.nextcloud-talk.rooms",
						routeScope: "room",
						groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
						groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom"
					}
				})
			});
		}
	},
	groups: {
		resolveRequireMention: ({ cfg, accountId, groupId }) => {
			const rooms = resolveNextcloudTalkAccount({
				cfg,
				accountId
			}).config.rooms;
			if (!rooms || !groupId) {return true;}
			const roomConfig = rooms[groupId];
			if (roomConfig?.requireMention !== void 0) {return roomConfig.requireMention;}
			const wildcardConfig = rooms["*"];
			if (wildcardConfig?.requireMention !== void 0) {return wildcardConfig.requireMention;}
			return true;
		},
		resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy
	},
	messaging: {
		normalizeTarget: normalizeNextcloudTalkMessagingTarget,
		targetResolver: {
			looksLikeId: looksLikeNextcloudTalkTargetId,
			hint: "<roomToken>"
		}
	},
	setup: nextcloudTalkSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		sendText: async ({ cfg, to, text, accountId, replyToId }) => {
			return {
				channel: "nextcloud-talk",
				...await sendMessageNextcloudTalk(to, text, {
					accountId: accountId ?? void 0,
					replyTo: replyToId ?? void 0,
					cfg
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
			return {
				channel: "nextcloud-talk",
				...await sendMessageNextcloudTalk(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
					accountId: accountId ?? void 0,
					replyTo: replyToId ?? void 0,
					cfg
				})
			};
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		buildChannelSummary: ({ snapshot }) => {
			const base = buildBaseChannelStatusSummary(snapshot);
			return {
				configured: base.configured,
				secretSource: snapshot.secretSource ?? "none",
				running: base.running,
				mode: "webhook",
				lastStartAt: base.lastStartAt,
				lastStopAt: base.lastStopAt,
				lastError: base.lastError
			};
		},
		buildAccountSnapshot: ({ account, runtime }) => {
			const configured = Boolean(account.secret?.trim() && account.baseUrl?.trim());
			const runtimeSnapshot = buildRuntimeAccountStatusSnapshot({ runtime });
			return {
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured,
				secretSource: account.secretSource,
				baseUrl: account.baseUrl ? "[set]" : "[missing]",
				running: runtimeSnapshot.running,
				lastStartAt: runtimeSnapshot.lastStartAt,
				lastStopAt: runtimeSnapshot.lastStopAt,
				lastError: runtimeSnapshot.lastError,
				mode: "webhook",
				lastInboundAt: runtime?.lastInboundAt ?? null,
				lastOutboundAt: runtime?.lastOutboundAt ?? null
			};
		}
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			if (!account.secret || !account.baseUrl) {throw new Error(`Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`);}
			ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk webhook server`);
			const statusSink = createAccountStatusSink({
				accountId: ctx.accountId,
				setStatus: ctx.setStatus
			});
			await runStoppablePassiveMonitor({
				abortSignal: ctx.abortSignal,
				start: async () => await monitorNextcloudTalkProvider({
					accountId: account.accountId,
					config: ctx.cfg,
					runtime: ctx.runtime,
					abortSignal: ctx.abortSignal,
					statusSink
				})
			});
		},
		logoutAccount: async ({ accountId, cfg }) => {
			const nextCfg = { ...cfg };
			const nextSection = cfg.channels?.["nextcloud-talk"] ? { ...cfg.channels["nextcloud-talk"] } : void 0;
			let cleared = false;
			let changed = false;
			if (nextSection) {
				if (accountId === "default" && nextSection.botSecret) {
					delete nextSection.botSecret;
					cleared = true;
					changed = true;
				}
				const accountCleanup = clearAccountEntryFields({
					accounts: nextSection.accounts,
					accountId,
					fields: ["botSecret"]
				});
				if (accountCleanup.changed) {
					changed = true;
					if (accountCleanup.cleared) {cleared = true;}
					if (accountCleanup.nextAccounts) {nextSection.accounts = accountCleanup.nextAccounts;}
					else {delete nextSection.accounts;}
				}
			}
			if (changed) {if (nextSection && Object.keys(nextSection).length > 0) nextCfg.channels = {
				...nextCfg.channels,
				"nextcloud-talk": nextSection
			};
			else {
				const nextChannels = { ...nextCfg.channels };
				delete nextChannels["nextcloud-talk"];
				if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
				else delete nextCfg.channels;
			}}
			const loggedOut = resolveNextcloudTalkAccount({
				cfg: changed ? nextCfg : cfg,
				accountId
			}).secretSource === "none";
			if (changed) {await getNextcloudTalkRuntime().config.writeConfigFile(nextCfg);}
			return {
				cleared,
				envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
				loggedOut
			};
		}
	}
};
//#endregion
export { setNextcloudTalkRuntime as n, nextcloudTalkPlugin as t };
