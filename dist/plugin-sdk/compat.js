import "./github-copilot-token-AislbH1d.js";
import { $t as sameFileIdentity, B as materializeWindowsSpawnProgram, Cn as resolveThreadSessionKeys, Dn as DEFAULT_ACCOUNT_ID, G as extensionForMime, Gt as runCommandWithTimeout, H as resolveWindowsSpawnProgram, K as getFileExtension, On as normalizeAccountId, U as resolveWindowsSpawnProgramCandidate, V as resolveWindowsExecutablePath, W as detectMime, at as openFileWithinRoot, bn as normalizeAgentId, mt as redactSensitiveText, nn as isPathInside, ot as openWritableFileWithinRoot, rt as copyFileWithinRoot, tn as isNotFoundPathError, tt as SafeOpenError, z as applyWindowsSpawnProgramPolicy } from "./query-expansion-5GTLCC48.js";
import { $ as requestBodyErrorToText, $c as upsertAuthProfileWithLock, $i as parseSlackBlocksInput, $o as listSignalAccountIds, Aa as QIANFAN_DEFAULT_MODEL_ID, Ac as formatErrorMessage, Ai as AcpRuntimeError, Ao as resolveGoogleChatGroupRequireMention, As as listIMessageAccountIds, At as recordPendingHistoryEntryIfEnabled, B as formatDocsLink, Bi as readNumberParam, Bo as inspectTelegramAccount, Br as resolveSenderScopedGroupPolicy, Bs as buildAccountScopedDmSecurityPolicy, Bt as collectDiscordAuditChannelIds, C as SecretInputSchema, Ca as withTempDownloadPath, Ci as KeyedAsyncQueue, Cl as createAccountListHelpers, Cn as resolveDiscordUserAllowlist, Co as resolveWhatsAppMentionStripPatterns, Cr as createAllowedChatSenderMatcher, Ct as DEFAULT_GROUP_HISTORY_LIMIT, D as TtsProviderSchema, Di as requireAcpRuntimeBackend, Do as resolveBlueBubblesGroupToolPolicy, Dr as resolveServicePrefixedChatTarget, Dt as clearHistoryEntriesIfEnabled, E as TtsModeSchema, Ei as registerAcpRuntimeBackend, Eo as resolveBlueBubblesGroupRequireMention, Er as resolveServicePrefixedAllowTarget, Et as clearHistoryEntries, Fa as buildOllamaModelDefinition, Fo as resolveSlackGroupToolPolicy, Fs as normalizeWhatsAppMessagingTarget, Ft as resolveDmGroupAccessDecision, G as resolveSlackChannelAllowlist, Gc as registerContextEngine, Go as resolveAccountWithDefaultFallback, Gr as resolveOpenProviderRuntimeGroupPolicy, Gs as formatAllowFromLowercase, Hc as getChatChannelMeta, Hi as readStringParam, Ho as resolveDefaultTelegramAccountId, Hr as resetMissingProviderGroupPolicyFallbackWarningsForTesting, Hs as clearAccountEntryFields, Ht as extractToolSend, Ia as enrichOllamaModelsWithContext, Ic as SsrFBlockedError, Io as resolveTelegramGroupRequireMention, Ir as evaluateGroupRouteAccessForPolicy, Is as looksLikeHandleOrPhoneTarget, It as resolveDmGroupAccessWithCommandGate, J as RequestBodyLimitError, Jc as formatExecSecretRefIdValidationMessage, Ji as isSilentReplyText, Jo as listEnabledSlackAccounts, Js as isNormalizedSenderAllowed, Jt as resolveControlCommandGate, K as DEFAULT_WEBHOOK_BODY_TIMEOUT_MS, Ki as SILENT_REPLY_TOKEN, Ko as buildSlackThreadingToolContext, Kr as resolveRuntimeGroupPolicy, Ks as formatNormalizedAllowFromEntries, La as fetchOllamaModels, Lc as isBlockedHostname, Lo as resolveTelegramGroupToolPolicy, Lr as evaluateMatchedGroupAccessForPolicy, Ls as trimMessagingTarget, Lt as resolveDmGroupAccessWithLists, Ma as buildSglangProvider, Mo as resolveIMessageGroupRequireMention, Mr as parseDiscordTarget, Ms as resolveIMessageAccount, Mt as DM_GROUP_ACCESS_REASON, Na as buildVllmProvider, No as resolveIMessageGroupToolPolicy, Nr as normalizeDiscordSlug, Ns as looksLikeWhatsAppTargetId, Nt as readStoreAllowFromForDmPolicy, O as normalizeAllowFrom, Oi as unregisterAcpRuntimeBackend, Oo as resolveDiscordGroupRequireMention, Or as resolveServicePrefixedOrChatAllowTarget, Ot as evictOldHistoryKeys, Pa as OLLAMA_DEFAULT_BASE_URL, Po as resolveSlackGroupRequireMention, Ps as normalizeWhatsAppAllowFromEntries, Pt as resolveDmAllowState, Q as readRequestBodyWithLimit, Qc as encodeJsonPointerToken, Qi as chunkTextByBreakResolver, Qo as resolveSlackReplyToMode, Qs as resolveDiscordAccount, Ra as resolveOllamaApiBase, Rc as isBlockedHostnameOrIp, Ri as createActionGate, Ro as resolveWhatsAppGroupRequireMention, Rr as evaluateSenderGroupAccess, Rs as isWhatsAppGroupJid, Rt as resolveEffectiveAllowFromLists, S as ReplyRuntimeConfigSchemaShape, Sa as buildRandomTempFilePath, Sl as CHANNEL_MESSAGE_ACTION_NAMES, Sn as resolveSlackUserAllowlist, So as resolveWhatsAppGroupIntroHint, Sr as normalizeIMessageHandle, St as logTypingFailure, T as TtsConfigSchema, Tc as extractOriginalFilename, Ti as getAcpRuntimeBackend, To as normalizeSignalMessagingTarget, Tr as parseChatTargetPrefixesOrThrow, Tt as buildPendingHistoryContextFromMap, Uo as resolveTelegramAccount, Ur as resolveAllowlistProviderRuntimeGroupPolicy, Us as deleteAccountFromConfigSection, Vi as readReactionParams, Vo as listTelegramAccountIds, Vr as GROUP_POLICY_BLOCKED_LABEL, Vs as formatPairingApproveHint, Vt as recordInboundSession, Wc as normalizePluginHttpPath, Wi as loadWebMedia, Wo as listConfiguredAccountIds, Wr as resolveDefaultGroupPolicy, Ws as setAccountEnabledInConfigSection, X as isRequestBodyLimitError, Xc as isValidFileSecretRefId, Xo as resolveDefaultSlackAccountId, Xs as listDiscordAccountIds, Xt as shouldAckReaction, Y as installRequestBodyLimitGuard, Yc as isValidExecSecretRefId, Yo as listSlackAccountIds, Ys as inspectDiscordAccount, Yt as removeAckReactionAfterReply, Z as readJsonBodyWithLimit, Zc as resolveDefaultSecretProviderAlias, Zo as resolveSlackAccount, Zs as resolveDefaultDiscordAccountId, Zt as shouldAckReactionForWhatsApp, _ as DmConfigSchema, _i as emitDiagnosticEvent, _n as resolvePairingPaths, _o as listTelegramDirectoryPeersFromConfig, _r as toLocationContext, _t as createTypingCallbacks, al as hasConfiguredSecretInput, an as dispatchReplyFromConfig, ao as resolveAllowlistMatchByCandidates, ar as createDedupeCache, as as formatTrimmedAllowFromEntries, at as resolveLineAccount, b as MarkdownConfigSchema, bl as BLUEBUBBLES_ACTION_NAMES, bn as resolveTimezone, bo as looksLikeSlackTargetId, bt as logAckFailure, c as DiscordConfigSchema, ci as stringEnum, cl as normalizeResolvedSecretInputString, co as normalizeChannelSlug, cs as resolveIMessageConfigAllowFrom, ct as openUrl, d as MSTeamsConfigSchema, da as processLineMessage, dc as readJsonFile, di as normalizeDeviceAuthScopes, do as resolveNestedAllowlistDecision, dr as parseTelegramThreadId, ds as resolveWhatsAppConfigAllowFrom, dt as summarizeMapping, ea as resolveAckReaction, ec as resolveChannelGroupRequireMention, ei as resolveChannelMediaMaxBytes, es as resolveDefaultSignalAccountId, et as resolveInboundSessionEnvelopeContext, f as SignalConfigSchema, fa as stripMarkdown, fc as writeJsonAtomic, fn as listSkillCommandsForAgents, fo as listDiscordDirectoryGroupsFromConfig, fs as resolveWhatsAppConfigDefaultTo, g as BlockStreamingCoalesceSchema, gn as pruneExpiredPending, go as listTelegramDirectoryGroupsFromConfig, gr as formatLocationText, gs as resolveWhatsAppAuthDir, gt as isDangerousNameMatchingEnabled, h as ToolPolicySchema, hn as rejectPendingPairingRequest, ho as listSlackDirectoryPeersFromConfig, hr as writeJsonFileAtomically, hs as resolveWhatsAppAccount, ht as resolveMentionGatingWithBypass, il as assertSecretInputResolved, in as withReplyDispatcher, io as resolveAllowlistCandidates, is as createScopedDmSecurityResolver, it as resolveDefaultLineAccountId, ja as buildOllamaProvider, jo as resolveGoogleChatGroupToolPolicy, js as resolveDefaultIMessageAccountId, jt as buildMediaPayload, k as requireOpenAllowFrom, ka as requireApiKey, ki as ACP_ERROR_CODES, ko as resolveDiscordGroupToolPolicy, kr as resolveServicePrefixedTarget, kt as recordPendingHistoryEntry, l as GoogleChatConfigSchema, ll as normalizeSecretInputString, lo as resolveChannelEntryMatch, ls as resolveIMessageConfigDefaultTo, lt as resolveDiscordChannelAllowlist, m as TelegramConfigSchema, ma as attachFooterText, mi as parseTelegramTarget, mn as generatePairingToken, mo as listSlackDirectoryGroupsFromConfig, mr as readJsonFileWithFallback, ms as resolveDefaultWhatsAppAccountId, mt as resolveMentionGating, n as listThreadBindingsBySessionKey, ni as readBooleanParam, nl as withFileLock, no as compileAllowlist, ns as createScopedAccountConfigAccessors, nt as listLineAccountIds, ol as isSecretRef, oo as resolveAllowlistMatchSimple, or as pruneMapToMaxSize, os as formatWhatsAppConfigAllowFromEntries, p as SlackConfigSchema, pa as createReceiptCard, pi as normalizeTelegramLookupTarget, po as listDiscordDirectoryPeersFromConfig, ps as listWhatsAppAccountIds, pt as issuePairingChallenge, q as DEFAULT_WEBHOOK_MAX_BODY_BYTES, qc as resolveSecretRefString, qo as inspectSlackAccount, qr as warnMissingProviderGroupPolicyFallbackOnce, qs as isAllowedParsedChatSender, r as unbindThreadBindingsBySessionKey, rl as formatCliCommand, rn as formatInboundFromLabel, ro as formatAllowlistMatchMeta, rs as createScopedChannelConfigBase, rt as normalizeAccountId$1, s as WhatsAppConfigSchema, si as optionalStringEnum, sl as isValidEnvSecretRefId, so as buildChannelKeyCandidates, ss as mapAllowFromEntries, st as detectBinary, t as autoBindSpawnedDiscordSubagent, tc as resolveToolsBySender, ti as missingTargetError, tl as acquireFileLock, ts as resolveSignalAccount, tt as registerPluginHttpRoute, u as IMessageConfigSchema, ua as hasMarkdownToConvert, uc as createAsyncLock, uo as resolveChannelEntryMatchWithFallback, ur as parseTelegramReplyToMessageId, us as resolveOptionalConfigString, ut as mergeAllowlist, v as DmPolicySchema, vi as isDiagnosticsEnabled, vn as formatUtcTimestamp, vo as listWhatsAppDirectoryGroupsFromConfig, vt as createReplyPrefixContext, w as TtsAutoSchema, wa as fetchWithSsrFGuard, wc as rawDataToString, wi as enqueueKeyedTask, wo as looksLikeSignalTargetId, wr as parseChatAllowTargetPrefixes, x as MarkdownTableModeSchema, xl as BLUEBUBBLES_GROUP_ACTIONS, xo as normalizeSlackMessagingTarget, xt as logInboundDrop, y as GroupPolicySchema, yi as onDiagnosticEvent, yl as BLUEBUBBLES_ACTIONS, yn as formatZonedTimestamp, yo as listWhatsAppDirectoryPeersFromConfig, yt as createReplyPrefixOptions, zc as isPrivateIpAddress, zi as jsonResult, zo as resolveWhatsAppGroupToolPolicy, zr as evaluateSenderGroupAccessForPolicy, zs as normalizeWhatsAppTarget } from "./thread-bindings-D280gj7z.js";
import "./paths-DBpXUsXY.js";
import { C as normalizeE164, O as safeParseJson, Q as resolvePreferredOpenClawTmpDir, a as createSubsystemLogger, b as isRecord, j as sleep, m as clamp, p as CONFIG_DIR, q as registerLogTransport, s as stripAnsi, v as escapeRegExp, w as pathExists } from "./logger-DarMZ-03.js";
import { a as isWSLEnv, h as isTruthyEnvValue, i as isWSL2Sync, o as isWSLSync } from "./fetch-BRELrDME.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-DVB-eheb.js";
import { r as resolveWhatsAppHeartbeatRecipients } from "./channel-web-QJbMP1VY.js";
import "./outbound-UATUegyP.js";
import "./session-DHFbceWM.js";
import { t as loginWeb } from "./login-UGpFjOG2.js";
import fs, { constants, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { format } from "node:util";
import fs$1 from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { request } from "node:https";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import JSZip from "jszip";
import * as tar from "tar";
//#region src/line/flex-templates/basic-cards.ts
/**
* Create an info card with title, body, and optional footer
*
* Editorial design: Clean hierarchy with accent bar, generous spacing,
* and subtle background zones for visual separation.
*/
function createInfoCard(title, body, footer) {
	const bubble = {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "box",
				layout: "horizontal",
				contents: [{
					type: "box",
					layout: "vertical",
					contents: [],
					width: "4px",
					backgroundColor: "#06C755",
					cornerRadius: "2px"
				}, {
					type: "text",
					text: title,
					weight: "bold",
					size: "xl",
					color: "#111111",
					wrap: true,
					flex: 1,
					margin: "lg"
				}]
			}, {
				type: "box",
				layout: "vertical",
				contents: [{
					type: "text",
					text: body,
					size: "md",
					color: "#444444",
					wrap: true,
					lineSpacing: "6px"
				}],
				margin: "xl",
				paddingAll: "lg",
				backgroundColor: "#F8F9FA",
				cornerRadius: "lg"
			}],
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
	if (footer) attachFooterText(bubble, footer);
	return bubble;
}
/**
* Create a list card with title and multiple items
*
* Editorial design: Numbered/bulleted list with clear visual hierarchy,
* accent dots for each item, and generous spacing.
*/
function createListCard(title, items) {
	const itemContents = items.slice(0, 8).map((item, index) => {
		const itemContents = [{
			type: "text",
			text: item.title,
			size: "md",
			weight: "bold",
			color: "#1a1a1a",
			wrap: true
		}];
		if (item.subtitle) itemContents.push({
			type: "text",
			text: item.subtitle,
			size: "sm",
			color: "#888888",
			wrap: true,
			margin: "xs"
		});
		const itemBox = {
			type: "box",
			layout: "horizontal",
			contents: [{
				type: "box",
				layout: "vertical",
				contents: [{
					type: "box",
					layout: "vertical",
					contents: [],
					width: "8px",
					height: "8px",
					backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
					cornerRadius: "4px"
				}],
				width: "20px",
				alignItems: "center",
				paddingTop: "sm"
			}, {
				type: "box",
				layout: "vertical",
				contents: itemContents,
				flex: 1
			}],
			margin: index > 0 ? "lg" : void 0
		};
		if (item.action) itemBox.action = item.action;
		return itemBox;
	});
	return {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: [
				{
					type: "text",
					text: title,
					weight: "bold",
					size: "xl",
					color: "#111111",
					wrap: true
				},
				{
					type: "separator",
					margin: "lg",
					color: "#EEEEEE"
				},
				{
					type: "box",
					layout: "vertical",
					contents: itemContents,
					margin: "lg"
				}
			],
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
}
/**
* Create an image card with image, title, and optional body text
*/
function createImageCard(imageUrl, title, body, options) {
	const bubble = {
		type: "bubble",
		hero: {
			type: "image",
			url: imageUrl,
			size: "full",
			aspectRatio: options?.aspectRatio ?? "20:13",
			aspectMode: options?.aspectMode ?? "cover",
			action: options?.action
		},
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "text",
				text: title,
				weight: "bold",
				size: "xl",
				wrap: true
			}],
			paddingAll: "lg"
		}
	};
	if (body && bubble.body) bubble.body.contents.push({
		type: "text",
		text: body,
		size: "md",
		wrap: true,
		margin: "md",
		color: "#666666"
	});
	return bubble;
}
/**
* Create an action card with title, body, and action buttons
*/
function createActionCard(title, body, actions, options) {
	const bubble = {
		type: "bubble",
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "text",
				text: title,
				weight: "bold",
				size: "xl",
				wrap: true
			}, {
				type: "text",
				text: body,
				size: "md",
				wrap: true,
				margin: "md",
				color: "#666666"
			}],
			paddingAll: "lg"
		},
		footer: {
			type: "box",
			layout: "vertical",
			contents: actions.slice(0, 4).map((action, index) => ({
				type: "button",
				action: action.action,
				style: index === 0 ? "primary" : "secondary",
				margin: index > 0 ? "sm" : void 0
			})),
			paddingAll: "md"
		}
	};
	if (options?.imageUrl) bubble.hero = {
		type: "image",
		url: options.imageUrl,
		size: "full",
		aspectRatio: options.aspectRatio ?? "20:13",
		aspectMode: "cover"
	};
	return bubble;
}
//#endregion
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
//#endregion
//#region src/plugin-sdk/allowlist-resolution.ts
function mapBasicAllowlistResolutionEntries(entries) {
	return entries.map((entry) => ({
		input: entry.input,
		resolved: entry.resolved,
		id: entry.id,
		name: entry.name,
		note: entry.note
	}));
}
async function mapAllowlistResolutionInputs(params) {
	const results = [];
	for (const input of params.inputs) results.push(await params.mapInput(input));
	return results;
}
//#endregion
//#region src/plugin-sdk/request-url.ts
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof input === "object" && input && "url" in input && typeof input.url === "string") return input.url;
	return "";
}
//#endregion
//#region src/plugin-sdk/discord-send.ts
function buildDiscordSendOptions(input) {
	return {
		verbose: false,
		replyTo: input.replyToId ?? void 0,
		accountId: input.accountId ?? void 0,
		silent: input.silent ?? void 0
	};
}
function buildDiscordSendMediaOptions(input) {
	return {
		...buildDiscordSendOptions(input),
		mediaUrl: input.mediaUrl,
		mediaLocalRoots: input.mediaLocalRoots
	};
}
function tagDiscordChannelResult(result) {
	return {
		channel: "discord",
		...result
	};
}
//#endregion
//#region src/plugin-sdk/webhook-path.ts
function normalizeWebhookPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "/";
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
	return withSlash;
}
function resolveWebhookPath(params) {
	const trimmedPath = params.webhookPath?.trim();
	if (trimmedPath) return normalizeWebhookPath(trimmedPath);
	if (params.webhookUrl?.trim()) try {
		return normalizeWebhookPath(new URL(params.webhookUrl).pathname || "/");
	} catch {
		return null;
	}
	return params.defaultPath ?? null;
}
//#endregion
//#region src/plugin-sdk/webhook-request-guards.ts
const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
	preAuth: {
		maxBytes: 64 * 1024,
		timeoutMs: 5e3
	},
	postAuth: {
		maxBytes: 1024 * 1024,
		timeoutMs: 3e4
	}
});
const WEBHOOK_IN_FLIGHT_DEFAULTS = Object.freeze({
	maxInFlightPerKey: 8,
	maxTrackedKeys: 4096
});
function resolveWebhookBodyReadLimits(params) {
	const defaults = params.profile === "pre-auth" ? WEBHOOK_BODY_READ_DEFAULTS.preAuth : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
	return {
		maxBytes: typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0 ? Math.floor(params.maxBytes) : defaults.maxBytes,
		timeoutMs: typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.floor(params.timeoutMs) : defaults.timeoutMs
	};
}
function respondWebhookBodyReadError(params) {
	const { res, code, invalidMessage } = params;
	if (code === "PAYLOAD_TOO_LARGE") {
		res.statusCode = 413;
		res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
		return { ok: false };
	}
	if (code === "REQUEST_BODY_TIMEOUT") {
		res.statusCode = 408;
		res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
		return { ok: false };
	}
	if (code === "CONNECTION_CLOSED") {
		res.statusCode = 400;
		res.end(requestBodyErrorToText("CONNECTION_CLOSED"));
		return { ok: false };
	}
	res.statusCode = 400;
	res.end(invalidMessage ?? "Bad Request");
	return { ok: false };
}
function createWebhookInFlightLimiter(options) {
	const maxInFlightPerKey = Math.max(1, Math.floor(options?.maxInFlightPerKey ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey));
	const maxTrackedKeys = Math.max(1, Math.floor(options?.maxTrackedKeys ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys));
	const active = /* @__PURE__ */ new Map();
	return {
		tryAcquire: (key) => {
			if (!key) return true;
			const current = active.get(key) ?? 0;
			if (current >= maxInFlightPerKey) return false;
			active.set(key, current + 1);
			pruneMapToMaxSize(active, maxTrackedKeys);
			return true;
		},
		release: (key) => {
			if (!key) return;
			const current = active.get(key);
			if (current === void 0) return;
			if (current <= 1) {
				active.delete(key);
				return;
			}
			active.set(key, current - 1);
		},
		size: () => active.size,
		clear: () => active.clear()
	};
}
function isJsonContentType(value) {
	const first = Array.isArray(value) ? value[0] : value;
	if (!first) return false;
	const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}
function applyBasicWebhookRequestGuards(params) {
	const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
	if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
		params.res.statusCode = 405;
		params.res.setHeader("Allow", allowMethods.join(", "));
		params.res.end("Method Not Allowed");
		return false;
	}
	if (params.rateLimiter && params.rateLimitKey && params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())) {
		params.res.statusCode = 429;
		params.res.end("Too Many Requests");
		return false;
	}
	if (params.requireJsonContentType && params.req.method === "POST" && !isJsonContentType(params.req.headers["content-type"])) {
		params.res.statusCode = 415;
		params.res.end("Unsupported Media Type");
		return false;
	}
	return true;
}
function beginWebhookRequestPipelineOrReject(params) {
	if (!applyBasicWebhookRequestGuards({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType
	})) return { ok: false };
	const inFlightKey = params.inFlightKey ?? "";
	const inFlightLimiter = params.inFlightLimiter;
	if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
		params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
		params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
		return { ok: false };
	}
	let released = false;
	return {
		ok: true,
		release: () => {
			if (released) return;
			released = true;
			if (inFlightLimiter && inFlightKey) inFlightLimiter.release(inFlightKey);
		}
	};
}
async function readWebhookBodyOrReject(params) {
	const limits = resolveWebhookBodyReadLimits({
		maxBytes: params.maxBytes,
		timeoutMs: params.timeoutMs,
		profile: params.profile
	});
	try {
		return {
			ok: true,
			value: await readRequestBodyWithLimit(params.req, limits)
		};
	} catch (error) {
		if (isRequestBodyLimitError(error)) return respondWebhookBodyReadError({
			res: params.res,
			code: error.code,
			invalidMessage: params.invalidBodyMessage
		});
		return respondWebhookBodyReadError({
			res: params.res,
			code: "INVALID_BODY",
			invalidMessage: params.invalidBodyMessage ?? (error instanceof Error ? error.message : String(error))
		});
	}
}
async function readJsonWebhookBodyOrReject(params) {
	const limits = resolveWebhookBodyReadLimits({
		maxBytes: params.maxBytes,
		timeoutMs: params.timeoutMs,
		profile: params.profile
	});
	const body = await readJsonBodyWithLimit(params.req, {
		maxBytes: limits.maxBytes,
		timeoutMs: limits.timeoutMs,
		emptyObjectOnEmpty: params.emptyObjectOnEmpty
	});
	if (body.ok) return {
		ok: true,
		value: body.value
	};
	return respondWebhookBodyReadError({
		res: params.res,
		code: body.code,
		invalidMessage: params.invalidJsonMessage
	});
}
//#endregion
//#region src/plugin-sdk/webhook-targets.ts
function registerWebhookTargetWithPluginRoute(params) {
	return registerWebhookTarget(params.targetsByPath, params.target, {
		onFirstPathTarget: ({ path }) => registerPluginHttpRoute({
			...params.route,
			path,
			replaceExisting: params.route.replaceExisting ?? true
		}),
		onLastPathTargetRemoved: params.onLastPathTargetRemoved
	});
}
const pathTeardownByTargetMap = /* @__PURE__ */ new WeakMap();
function getPathTeardownMap(targetsByPath) {
	const mapKey = targetsByPath;
	const existing = pathTeardownByTargetMap.get(mapKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	pathTeardownByTargetMap.set(mapKey, created);
	return created;
}
function registerWebhookTarget(targetsByPath, target, opts) {
	const key = normalizeWebhookPath(target.path);
	const normalizedTarget = {
		...target,
		path: key
	};
	const existing = targetsByPath.get(key) ?? [];
	if (existing.length === 0) {
		const onFirstPathResult = opts?.onFirstPathTarget?.({
			path: key,
			target: normalizedTarget
		});
		if (typeof onFirstPathResult === "function") getPathTeardownMap(targetsByPath).set(key, onFirstPathResult);
	}
	targetsByPath.set(key, [...existing, normalizedTarget]);
	let isActive = true;
	const unregister = () => {
		if (!isActive) return;
		isActive = false;
		const updated = (targetsByPath.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
		if (updated.length > 0) {
			targetsByPath.set(key, updated);
			return;
		}
		targetsByPath.delete(key);
		const teardown = getPathTeardownMap(targetsByPath).get(key);
		if (teardown) {
			getPathTeardownMap(targetsByPath).delete(key);
			teardown();
		}
		opts?.onLastPathTargetRemoved?.({ path: key });
	};
	return {
		target: normalizedTarget,
		unregister
	};
}
function resolveWebhookTargets(req, targetsByPath) {
	const path = normalizeWebhookPath(new URL(req.url ?? "/", "http://localhost").pathname);
	const targets = targetsByPath.get(path);
	if (!targets || targets.length === 0) return null;
	return {
		path,
		targets
	};
}
async function withResolvedWebhookRequestPipeline(params) {
	const resolved = resolveWebhookTargets(params.req, params.targetsByPath);
	if (!resolved) return false;
	const inFlightKey = typeof params.inFlightKey === "function" ? params.inFlightKey({
		req: params.req,
		path: resolved.path,
		targets: resolved.targets
	}) : params.inFlightKey ?? `${resolved.path}:${params.req.socket?.remoteAddress ?? "unknown"}`;
	const requestLifecycle = beginWebhookRequestPipelineOrReject({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType,
		inFlightLimiter: params.inFlightLimiter,
		inFlightKey,
		inFlightLimitStatusCode: params.inFlightLimitStatusCode,
		inFlightLimitMessage: params.inFlightLimitMessage
	});
	if (!requestLifecycle.ok) return true;
	try {
		await params.handle(resolved);
		return true;
	} finally {
		requestLifecycle.release();
	}
}
function updateMatchedWebhookTarget(matched, target) {
	if (matched) return {
		ok: false,
		result: { kind: "ambiguous" }
	};
	return {
		ok: true,
		matched: target
	};
}
function finalizeMatchedWebhookTarget(matched) {
	if (!matched) return { kind: "none" };
	return {
		kind: "single",
		target: matched
	};
}
function resolveSingleWebhookTarget(targets, isMatch) {
	let matched;
	for (const target of targets) {
		if (!isMatch(target)) continue;
		const updated = updateMatchedWebhookTarget(matched, target);
		if (!updated.ok) return updated.result;
		matched = updated.matched;
	}
	return finalizeMatchedWebhookTarget(matched);
}
async function resolveSingleWebhookTargetAsync(targets, isMatch) {
	let matched;
	for (const target of targets) {
		if (!await isMatch(target)) continue;
		const updated = updateMatchedWebhookTarget(matched, target);
		if (!updated.ok) return updated.result;
		matched = updated.matched;
	}
	return finalizeMatchedWebhookTarget(matched);
}
async function resolveWebhookTargetWithAuthOrReject(params) {
	return resolveWebhookTargetMatchOrReject(params, await resolveSingleWebhookTargetAsync(params.targets, async (target) => Boolean(await params.isMatch(target))));
}
function resolveWebhookTargetWithAuthOrRejectSync(params) {
	return resolveWebhookTargetMatchOrReject(params, resolveSingleWebhookTarget(params.targets, params.isMatch));
}
function resolveWebhookTargetMatchOrReject(params, match) {
	if (match.kind === "single") return match.target;
	if (match.kind === "ambiguous") {
		params.res.statusCode = params.ambiguousStatusCode ?? 401;
		params.res.end(params.ambiguousMessage ?? "ambiguous webhook target");
		return null;
	}
	params.res.statusCode = params.unauthorizedStatusCode ?? 401;
	params.res.end(params.unauthorizedMessage ?? "unauthorized");
	return null;
}
function rejectNonPostWebhookRequest(req, res) {
	if (req.method === "POST") return false;
	res.statusCode = 405;
	res.setHeader("Allow", "POST");
	res.end("Method Not Allowed");
	return true;
}
//#endregion
//#region src/plugin-sdk/channel-lifecycle.ts
function createAccountStatusSink(params) {
	return (patch) => {
		params.setStatus({
			accountId: params.accountId,
			...patch
		});
	};
}
/**
* Return a promise that resolves when the signal is aborted.
*
* If no signal is provided, the promise stays pending forever. When provided,
* `onAbort` runs once before the promise resolves.
*/
function waitUntilAbort(signal, onAbort) {
	return new Promise((resolve, reject) => {
		const complete = () => {
			Promise.resolve(onAbort?.()).then(() => resolve(), reject);
		};
		if (!signal) return;
		if (signal.aborted) {
			complete();
			return;
		}
		signal.addEventListener("abort", complete, { once: true });
	});
}
/**
* Keep a passive account task alive until abort, then run optional cleanup.
*/
async function runPassiveAccountLifecycle(params) {
	const handle = await params.start();
	try {
		await waitUntilAbort(params.abortSignal);
	} finally {
		await params.stop?.(handle);
		await params.onStop?.();
	}
}
/**
* Keep a channel/provider task pending until the HTTP server closes.
*
* When an abort signal is provided, `onAbort` is invoked once and should
* trigger server shutdown. The returned promise resolves only after `close`.
*/
async function keepHttpServerTaskAlive(params) {
	const { server, abortSignal, onAbort } = params;
	let abortTask = Promise.resolve();
	let abortTriggered = false;
	const triggerAbort = () => {
		if (abortTriggered) return;
		abortTriggered = true;
		abortTask = Promise.resolve(onAbort?.()).then(() => void 0);
	};
	const onAbortSignal = () => {
		triggerAbort();
	};
	if (abortSignal) if (abortSignal.aborted) triggerAbort();
	else abortSignal.addEventListener("abort", onAbortSignal, { once: true });
	await new Promise((resolve) => {
		server.once("close", () => resolve());
	});
	if (abortSignal) abortSignal.removeEventListener("abort", onAbortSignal);
	await abortTask;
}
//#endregion
//#region src/plugin-sdk/agent-media-payload.ts
function buildAgentMediaPayload(mediaList) {
	const first = mediaList[0];
	const mediaPaths = mediaList.map((media) => media.path);
	const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean);
	return {
		MediaPath: first?.path,
		MediaType: first?.contentType ?? void 0,
		MediaUrl: first?.path,
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaUrls: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0
	};
}
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function createDefaultChannelRuntimeState(accountId, extra) {
	return {
		accountId,
		running: false,
		lastStartAt: null,
		lastStopAt: null,
		lastError: null,
		...extra ?? {}
	};
}
function buildBaseChannelStatusSummary(snapshot) {
	return {
		configured: snapshot.configured ?? false,
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
function buildProbeChannelStatusSummary(snapshot, extra) {
	return {
		...buildBaseChannelStatusSummary(snapshot),
		...extra ?? {},
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
}
function buildBaseAccountStatusSnapshot(params) {
	const { account, runtime, probe } = params;
	return {
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: account.configured,
		...buildRuntimeAccountStatusSnapshot({
			runtime,
			probe
		}),
		lastInboundAt: runtime?.lastInboundAt ?? null,
		lastOutboundAt: runtime?.lastOutboundAt ?? null
	};
}
function buildComputedAccountStatusSnapshot(params) {
	const { accountId, name, enabled, configured, runtime, probe } = params;
	return buildBaseAccountStatusSnapshot({
		account: {
			accountId,
			name,
			enabled,
			configured
		},
		runtime,
		probe
	});
}
function buildRuntimeAccountStatusSnapshot(params) {
	const { runtime, probe } = params;
	return {
		running: runtime?.running ?? false,
		lastStartAt: runtime?.lastStartAt ?? null,
		lastStopAt: runtime?.lastStopAt ?? null,
		lastError: runtime?.lastError ?? null,
		probe
	};
}
function buildTokenChannelStatusSummary(snapshot, opts) {
	const base = {
		...buildBaseChannelStatusSummary(snapshot),
		tokenSource: snapshot.tokenSource ?? "none",
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
	if (opts?.includeMode === false) return base;
	return {
		...base,
		mode: snapshot.mode ?? null
	};
}
function collectStatusIssuesFromLastError(channel, accounts) {
	return accounts.flatMap((account) => {
		const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
		if (!lastError) return [];
		return [{
			channel,
			accountId: account.accountId,
			kind: "runtime",
			message: `Channel error: ${lastError}`
		}];
	});
}
//#endregion
//#region src/secrets/provider-env-vars.ts
const PROVIDER_ENV_VARS = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GEMINI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	venice: ["VENICE_API_KEY"],
	zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
	qianfan: ["QIANFAN_API_KEY"],
	xai: ["XAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	kilocode: ["KILOCODE_API_KEY"],
	modelstudio: ["MODELSTUDIO_API_KEY"],
	volcengine: ["VOLCANO_ENGINE_API_KEY"],
	byteplus: ["BYTEPLUS_API_KEY"]
};
const EXTRA_PROVIDER_AUTH_ENV_VARS = [
	"VOYAGE_API_KEY",
	"GROQ_API_KEY",
	"DEEPGRAM_API_KEY",
	"CEREBRAS_API_KEY",
	"NVIDIA_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"CHUTES_OAUTH_TOKEN",
	"CHUTES_API_KEY",
	"QWEN_OAUTH_TOKEN",
	"QWEN_PORTAL_API_KEY",
	"MINIMAX_OAUTH_TOKEN",
	"OLLAMA_API_KEY",
	"VLLM_API_KEY"
];
const KNOWN_SECRET_ENV_VARS = [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
[...new Set([...KNOWN_SECRET_ENV_VARS, ...EXTRA_PROVIDER_AUTH_ENV_VARS])];
//#endregion
//#region src/commands/auth-choice.apply-helpers.ts
function formatErrorMessage$1(error) {
	if (error instanceof Error && typeof error.message === "string" && error.message.trim()) return error.message;
	return String(error);
}
function resolveDefaultProviderEnvVar(provider) {
	return PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
}
function resolveDefaultFilePointerId(provider) {
	return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}
async function promptSecretRefForOnboarding(params) {
	const defaultEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
	const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
	let sourceChoice = "env";
	while (true) {
		const source = await params.prompter.select({
			message: params.copy?.sourceMessage ?? "Where is this API key stored?",
			initialValue: sourceChoice,
			options: [{
				value: "env",
				label: "Environment variable",
				hint: "Reference a variable from your runtime environment"
			}, {
				value: "provider",
				label: "Configured secret provider",
				hint: "Use a configured file or exec secret provider"
			}]
		}) === "provider" ? "provider" : "env";
		sourceChoice = source;
		if (source === "env") {
			const envVarRaw = await params.prompter.text({
				message: params.copy?.envVarMessage ?? "Environment variable name",
				initialValue: defaultEnvVar || void 0,
				placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
				validate: (value) => {
					const candidate = value.trim();
					if (!isValidEnvSecretRefId(candidate)) return params.copy?.envVarFormatError ?? "Use an env var name like \"OPENAI_API_KEY\" (uppercase letters, numbers, underscores).";
					if (!process.env[candidate]?.trim()) return params.copy?.envVarMissingError?.(candidate) ?? `Environment variable "${candidate}" is missing or empty in this session.`;
				}
			});
			const envCandidate = String(envVarRaw ?? "").trim();
			const envVar = envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : defaultEnvVar;
			if (!envVar) throw new Error(`No valid environment variable name provided for provider "${params.provider}".`);
			const ref = {
				source: "env",
				provider: resolveDefaultSecretProviderAlias(params.config, "env", { preferFirstProviderForSource: true }),
				id: envVar
			};
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(params.copy?.envValidatedMessage?.(envVar) ?? `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		}
		const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(([, provider]) => provider?.source === "file" || provider?.source === "exec");
		if (externalProviders.length === 0) {
			await params.prompter.note(params.copy?.noProvidersMessage ?? "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.", "No providers configured");
			continue;
		}
		const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", { preferFirstProviderForSource: true });
		const selectedProvider = await params.prompter.select({
			message: "Select secret provider",
			initialValue: externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ?? externalProviders[0]?.[0],
			options: externalProviders.map(([providerName, provider]) => ({
				value: providerName,
				label: providerName,
				hint: provider?.source === "exec" ? "Exec provider" : "File provider"
			}))
		});
		const providerEntry = params.config.secrets?.providers?.[selectedProvider];
		if (!providerEntry || providerEntry.source !== "file" && providerEntry.source !== "exec") {
			await params.prompter.note(`Provider "${selectedProvider}" is not a file/exec provider.`, "Invalid provider");
			continue;
		}
		const idPrompt = providerEntry.source === "file" ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)" : "Secret id for the exec provider";
		const idDefault = providerEntry.source === "file" ? providerEntry.mode === "singleValue" ? "value" : defaultFilePointer : `${params.provider}/apiKey`;
		const idRaw = await params.prompter.text({
			message: idPrompt,
			initialValue: idDefault,
			placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
			validate: (value) => {
				const candidate = value.trim();
				if (!candidate) return "Secret id cannot be empty.";
				if (providerEntry.source === "file" && providerEntry.mode !== "singleValue" && !isValidFileSecretRefId(candidate)) return "Use an absolute JSON pointer like \"/providers/openai/apiKey\".";
				if (providerEntry.source === "file" && providerEntry.mode === "singleValue" && candidate !== "value") return "singleValue mode expects id \"value\".";
				if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) return formatExecSecretRefIdValidationMessage();
			}
		});
		const id = String(idRaw ?? "").trim() || idDefault;
		const ref = {
			source: providerEntry.source,
			provider: selectedProvider,
			id
		};
		try {
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ?? `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		} catch (error) {
			await params.prompter.note([
				`Could not validate provider reference ${selectedProvider}:${id}.`,
				formatErrorMessage$1(error),
				"Check your provider configuration and try again."
			].join("\n"), "Reference check failed");
		}
	}
}
async function resolveSecretInputModeForEnvSelection(params) {
	if (params.explicitMode) return params.explicitMode;
	if (typeof params.prompter.select !== "function") return "plaintext";
	return await params.prompter.select({
		message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
		initialValue: "plaintext",
		options: [{
			value: "plaintext",
			label: params.copy?.plaintextLabel ?? "Paste API key now",
			hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config"
		}, {
			value: "ref",
			label: params.copy?.refLabel ?? "Use external secret provider",
			hint: params.copy?.refHint ?? "Stores a reference to env or configured external secret providers"
		}]
	}) === "ref" ? "ref" : "plaintext";
}
//#endregion
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || "default";
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === "default" ? "default (primary)" : id
		})), {
			value: "__new__",
			label: "Add a new account"
		}],
		initialValue: initial
	});
	if (choice !== "__new__") return normalizeAccountId(choice);
	const entered = await params.prompter.text({
		message: `New ${params.label} account id`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const normalized = normalizeAccountId(String(entered));
	if (String(entered).trim() !== normalized) await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
	return normalized;
}
//#endregion
//#region src/channels/plugins/setup-helpers.ts
function channelHasAccounts(cfg, channelKey) {
	const base = cfg.channels?.[channelKey];
	return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
	if (params.alwaysUseAccounts) return true;
	if (params.accountId !== "default") return true;
	return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return params.cfg;
	const accountId = normalizeAccountId(params.accountId);
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!shouldStoreNameInAccounts({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId,
		alwaysUseAccounts: params.alwaysUseAccounts
	}) && accountId === "default") {
		const safeBase = base ?? {};
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.channelKey]: {
					...safeBase,
					name: trimmed
				}
			}
		};
	}
	const baseAccounts = base?.accounts ?? {};
	const existingAccount = baseAccounts[accountId] ?? {};
	const baseWithoutName = accountId === "default" ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...baseWithoutName,
				accounts: {
					...baseAccounts,
					[accountId]: {
						...existingAccount,
						name: trimmed
					}
				}
			}
		}
	};
}
function migrateBaseNameToDefaultAccount(params) {
	if (params.alwaysUseAccounts) return params.cfg;
	const base = params.cfg.channels?.[params.channelKey];
	const baseName = base?.name?.trim();
	if (!baseName) return params.cfg;
	const accounts = { ...base?.accounts };
	const defaultAccount = accounts["default"] ?? {};
	if (!defaultAccount.name) accounts[DEFAULT_ACCOUNT_ID] = {
		...defaultAccount,
		name: baseName
	};
	const { name: _ignored, ...rest } = base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...rest,
				accounts
			}
		}
	};
}
function applySetupAccountConfigPatch(params) {
	return patchScopedAccountConfig({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId: params.accountId,
		patch: params.patch
	});
}
function patchScopedAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof channelConfig === "object" && channelConfig ? channelConfig : void 0;
	const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
	const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
	const patch = params.patch;
	const accountPatch = params.accountPatch ?? patch;
	if (accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = base?.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureAccountEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...accountPatch
					}
				}
			}
		}
	};
}
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"token",
	"tokenFile",
	"botToken",
	"appToken",
	"account",
	"signalNumber",
	"authDir",
	"cliPath",
	"dbPath",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"webhookSecret",
	"service",
	"region",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"url",
	"code",
	"dmPolicy",
	"allowFrom",
	"groupPolicy",
	"groupAllowFrom",
	"defaultTo"
]);
const SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL = { telegram: new Set(["streaming"]) };
function shouldMoveSingleAccountChannelKey(params) {
	if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) return true;
	return SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL[params.channelKey]?.has(params.key) ?? false;
}
function cloneIfObject(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function moveSingleAccountChannelSectionToDefaultAccount(params) {
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!base) return params.cfg;
	const accounts = base.accounts ?? {};
	if (Object.keys(accounts).length > 0) return params.cfg;
	const keysToMove = Object.entries(base).filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== void 0 && shouldMoveSingleAccountChannelKey({
		channelKey: params.channelKey,
		key
	})).map(([key]) => key);
	const defaultAccount = {};
	for (const key of keysToMove) {
		const value = base[key];
		defaultAccount[key] = cloneIfObject(value);
	}
	const nextChannel = { ...base };
	for (const key of keysToMove) delete nextChannel[key];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...nextChannel,
				accounts: {
					...accounts,
					[DEFAULT_ACCOUNT_ID]: defaultAccount
				}
			}
		}
	};
}
//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
const promptAccountId = async (params) => {
	return await promptAccountId$1(params);
};
function addWildcardAllowFrom(allowFrom) {
	const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
	if (!next.includes("*")) next.push("*");
	return next;
}
function mergeAllowFromEntries(current, additions) {
	const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
	return [...new Set(merged)];
}
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function parseOnboardingEntriesWithParser(raw, parseEntry) {
	const parts = splitOnboardingEntries(String(raw ?? ""));
	const entries = [];
	for (const part of parts) {
		const parsed = parseEntry(part);
		if ("error" in parsed) return {
			entries: [],
			error: parsed.error
		};
		entries.push(parsed.value);
	}
	return { entries: normalizeAllowFromEntries(entries) };
}
function parseOnboardingEntriesAllowingWildcard(raw, parseEntry) {
	return parseOnboardingEntriesWithParser(raw, (entry) => {
		if (entry === "*") return { value: "*" };
		return parseEntry(entry);
	});
}
function parseMentionOrPrefixedId(params) {
	const trimmed = params.value.trim();
	if (!trimmed) return null;
	const mentionMatch = trimmed.match(params.mentionPattern);
	if (mentionMatch?.[1]) return params.normalizeId ? params.normalizeId(mentionMatch[1]) : mentionMatch[1];
	const stripped = params.prefixPattern ? trimmed.replace(params.prefixPattern, "") : trimmed;
	if (!params.idPattern.test(stripped)) return null;
	return params.normalizeId ? params.normalizeId(stripped) : stripped;
}
function normalizeAllowFromEntries(entries, normalizeEntry) {
	const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
		if (entry === "*") return "*";
		if (!normalizeEntry) return entry;
		const value = normalizeEntry(entry);
		return typeof value === "string" ? value.trim() : "";
	}).filter(Boolean);
	return [...new Set(normalized)];
}
function resolveOnboardingAccountId(params) {
	return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
}
async function resolveAccountIdForConfigure(params) {
	const override = params.accountOverride?.trim();
	let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
	if (params.shouldPromptAccountIds && !override) accountId = await promptAccountId({
		cfg: params.cfg,
		prompter: params.prompter,
		label: params.label,
		currentId: accountId,
		listAccountIds: params.listAccountIds,
		defaultAccountId: params.defaultAccountId
	});
	return accountId;
}
function setAccountAllowFromForChannel(params) {
	const { cfg, channel, accountId, allowFrom } = params;
	return patchConfigForScopedAccount({
		cfg,
		channel,
		accountId,
		patch: { allowFrom },
		ensureEnabled: false
	});
}
function patchTopLevelChannelConfig(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channel]: {
				...channelConfig,
				...params.enabled ? { enabled: true } : {},
				...params.patch
			}
		}
	};
}
function setTopLevelChannelAllowFrom(params) {
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		enabled: params.enabled,
		patch: { allowFrom: params.allowFrom }
	});
}
function setTopLevelChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	const existingAllowFrom = params.getAllowFrom?.(params.cfg) ?? channelConfig.allowFrom ?? void 0;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function setTopLevelChannelGroupPolicy(params) {
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		enabled: params.enabled,
		patch: { groupPolicy: params.groupPolicy }
	});
}
function setChannelDmPolicyWithAllowFrom(params) {
	const { cfg, channel, dmPolicy } = params;
	const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...cfg.channels?.[channel],
				dmPolicy,
				...allowFrom ? { allowFrom } : {}
			}
		}
	};
}
function setLegacyChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {
		allowFrom: void 0,
		dm: void 0
	};
	const existingAllowFrom = channelConfig.allowFrom ?? channelConfig.dm?.allowFrom;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function setLegacyChannelAllowFrom(params) {
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: { allowFrom: params.allowFrom }
	});
}
function setAccountGroupPolicyForChannel(params) {
	return patchChannelConfigForAccount({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		patch: { groupPolicy: params.groupPolicy }
	});
}
function patchLegacyDmChannelConfig(params) {
	const { cfg, channel, patch } = params;
	const channelConfig = cfg.channels?.[channel] ?? {};
	const dmConfig = channelConfig.dm ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				...patch,
				dm: {
					...dmConfig,
					enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true
				}
			}
		}
	};
}
function setOnboardingChannelEnabled(cfg, channel, enabled) {
	const channelConfig = cfg.channels?.[channel] ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				enabled
			}
		}
	};
}
function patchConfigForScopedAccount(params) {
	const { cfg, channel, accountId, patch, ensureEnabled } = params;
	return patchScopedAccountConfig({
		cfg: accountId === "default" ? cfg : moveSingleAccountChannelSectionToDefaultAccount({
			cfg,
			channelKey: channel
		}),
		channelKey: channel,
		accountId,
		patch,
		ensureChannelEnabled: ensureEnabled,
		ensureAccountEnabled: ensureEnabled
	});
}
function patchChannelConfigForAccount(params) {
	return patchConfigForScopedAccount({
		...params,
		ensureEnabled: true
	});
}
function applySingleTokenPromptResult(params) {
	let next = params.cfg;
	if (params.tokenResult.useEnv) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: {}
	});
	if (params.tokenResult.token) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: { [params.tokenPatchKey]: params.tokenResult.token }
	});
	return next;
}
function buildSingleChannelSecretPromptState(params) {
	return {
		accountConfigured: params.accountConfigured,
		hasConfigToken: params.hasConfigToken,
		canUseEnv: params.allowEnv && Boolean(params.envValue?.trim()) && !params.hasConfigToken
	};
}
async function promptSingleChannelToken(params) {
	const promptToken = async () => String(await params.prompter.text({
		message: params.inputPrompt,
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
	if (params.canUseEnv) {
		if (await params.prompter.confirm({
			message: params.envPrompt,
			initialValue: true
		})) return {
			useEnv: true,
			token: null
		};
		return {
			useEnv: false,
			token: await promptToken()
		};
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return {
			useEnv: false,
			token: null
		};
	}
	return {
		useEnv: false,
		token: await promptToken()
	};
}
async function runSingleChannelSecretStep(params) {
	const promptState = buildSingleChannelSecretPromptState({
		accountConfigured: params.accountConfigured,
		hasConfigToken: params.hasConfigToken,
		allowEnv: params.allowEnv,
		envValue: params.envValue
	});
	if (!promptState.accountConfigured && params.onMissingConfigured) await params.onMissingConfigured();
	const result = await promptSingleChannelSecretInput({
		cfg: params.cfg,
		prompter: params.prompter,
		providerHint: params.providerHint,
		credentialLabel: params.credentialLabel,
		secretInputMode: params.secretInputMode,
		accountConfigured: promptState.accountConfigured,
		canUseEnv: promptState.canUseEnv,
		hasConfigToken: promptState.hasConfigToken,
		envPrompt: params.envPrompt,
		keepPrompt: params.keepPrompt,
		inputPrompt: params.inputPrompt,
		preferredEnvVar: params.preferredEnvVar
	});
	if (result.action === "use-env") return {
		cfg: params.applyUseEnv ? await params.applyUseEnv(params.cfg) : params.cfg,
		action: result.action,
		resolvedValue: params.envValue?.trim() || void 0
	};
	if (result.action === "set") return {
		cfg: params.applySet ? await params.applySet(params.cfg, result.value, result.resolvedValue) : params.cfg,
		action: result.action,
		resolvedValue: result.resolvedValue
	};
	return {
		cfg: params.cfg,
		action: result.action
	};
}
async function promptSingleChannelSecretInput(params) {
	if (await resolveSecretInputModeForEnvSelection({
		prompter: params.prompter,
		explicitMode: params.secretInputMode,
		copy: {
			modeMessage: `How do you want to provide this ${params.credentialLabel}?`,
			plaintextLabel: `Enter ${params.credentialLabel}`,
			plaintextHint: "Stores the credential directly in OpenClaw config",
			refLabel: "Use external secret provider",
			refHint: "Stores a reference to env or configured external secret providers"
		}
	}) === "plaintext") {
		const plainResult = await promptSingleChannelToken({
			prompter: params.prompter,
			accountConfigured: params.accountConfigured,
			canUseEnv: params.canUseEnv,
			hasConfigToken: params.hasConfigToken,
			envPrompt: params.envPrompt,
			keepPrompt: params.keepPrompt,
			inputPrompt: params.inputPrompt
		});
		if (plainResult.useEnv) return { action: "use-env" };
		if (plainResult.token) return {
			action: "set",
			value: plainResult.token,
			resolvedValue: plainResult.token
		};
		return { action: "keep" };
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return { action: "keep" };
	}
	const resolved = await promptSecretRefForOnboarding({
		provider: params.providerHint,
		config: params.cfg,
		prompter: params.prompter,
		preferredEnvVar: params.preferredEnvVar,
		copy: {
			sourceMessage: `Where is this ${params.credentialLabel} stored?`,
			envVarPlaceholder: params.preferredEnvVar ?? "OPENCLAW_SECRET",
			envVarFormatError: "Use an env var name like \"OPENCLAW_SECRET\" (uppercase letters, numbers, underscores).",
			noProvidersMessage: "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable."
		}
	});
	return {
		action: "set",
		value: resolved.ref,
		resolvedValue: resolved.resolvedValue
	};
}
async function promptParsedAllowFromForScopedChannel(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: params.defaultAccountId
	});
	const existing = params.getExistingAllowFrom({
		cfg: params.cfg,
		accountId
	});
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const entry = await params.prompter.text({
		message: params.message,
		placeholder: params.placeholder,
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			return params.parseEntries(raw).error;
		}
	});
	const unique = mergeAllowFromEntries(void 0, params.parseEntries(String(entry)).entries);
	return setAccountAllowFromForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId,
		allowFrom: unique
	});
}
async function noteChannelLookupSummary(params) {
	const lines = [];
	for (const section of params.resolvedSections) {
		if (section.values.length === 0) continue;
		lines.push(`${section.title}: ${section.values.join(", ")}`);
	}
	if (params.unresolved && params.unresolved.length > 0) lines.push(`Unresolved (kept as typed): ${params.unresolved.join(", ")}`);
	if (lines.length > 0) await params.prompter.note(lines.join("\n"), params.label);
}
async function noteChannelLookupFailure(params) {
	await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${String(params.error)}`, params.label);
}
async function promptResolvedAllowFrom(params) {
	while (true) {
		const entry = await params.prompter.text({
			message: params.message,
			placeholder: params.placeholder,
			initialValue: params.existing[0] ? String(params.existing[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = params.parseInputs(String(entry));
		if (!params.token) {
			const ids = parts.map(params.parseId).filter(Boolean);
			if (ids.length !== parts.length) {
				await params.prompter.note(params.invalidWithoutTokenNote, params.label);
				continue;
			}
			return mergeAllowFromEntries(params.existing, ids);
		}
		const results = await params.resolveEntries({
			token: params.token,
			entries: parts
		}).catch(() => null);
		if (!results) {
			await params.prompter.note("Failed to resolve usernames. Try again.", params.label);
			continue;
		}
		const unresolved = results.filter((res) => !res.resolved || !res.id);
		if (unresolved.length > 0) {
			await params.prompter.note(`Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`, params.label);
			continue;
		}
		const ids = results.map((res) => res.id);
		return mergeAllowFromEntries(params.existing, ids);
	}
}
async function promptLegacyChannelAllowFrom(params) {
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const unique = await promptResolvedAllowFrom({
		prompter: params.prompter,
		existing: params.existing,
		token: params.token,
		message: params.message,
		placeholder: params.placeholder,
		label: params.noteTitle,
		parseInputs: splitOnboardingEntries,
		parseId: params.parseId,
		invalidWithoutTokenNote: params.invalidWithoutTokenNote,
		resolveEntries: params.resolveEntries
	});
	return setLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: params.channel,
		allowFrom: unique
	});
}
//#endregion
//#region src/plugin-sdk/provider-auth-result.ts
function buildOauthProviderAuthResult(params) {
	const email = params.email ?? void 0;
	return {
		profiles: [{
			profileId: `${params.profilePrefix ?? params.providerId}:${email ?? "default"}`,
			credential: {
				type: "oauth",
				provider: params.providerId,
				access: params.access,
				...params.refresh ? { refresh: params.refresh } : {},
				...Number.isFinite(params.expires) ? { expires: params.expires } : {},
				...email ? { email } : {},
				...params.credentialExtra
			}
		}],
		configPatch: params.configPatch ?? { agents: { defaults: { models: { [params.defaultModel]: {} } } } },
		defaultModel: params.defaultModel,
		notes: params.notes
	};
}
//#endregion
//#region src/plugin-sdk/resolution-notes.ts
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) return;
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
//#region src/plugin-sdk/channel-send-result.ts
function buildChannelSendResult(channel, result) {
	return {
		channel,
		ok: result.ok,
		messageId: result.messageId ?? "",
		error: result.error ? new Error(result.error) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/runtime-store.ts
function createPluginRuntimeStore(errorMessage) {
	let runtime = null;
	return {
		setRuntime(next) {
			runtime = next;
		},
		clearRuntime() {
			runtime = null;
		},
		tryGetRuntime() {
			return runtime;
		},
		getRuntime() {
			if (!runtime) throw new Error(errorMessage);
			return runtime;
		}
	};
}
//#endregion
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();
function buildNestedDmConfigSchema() {
	return z.object({
		enabled: z.boolean().optional(),
		policy: DmPolicySchema.optional(),
		allowFrom: AllowFromListSchema
	}).optional();
}
function buildCatchallMultiAccountChannelSchema(accountSchema) {
	return accountSchema.extend({
		accounts: z.object({}).catchall(accountSchema).optional(),
		defaultAccount: z.string().optional()
	});
}
function buildChannelConfigSchema(schema) {
	const schemaWithJson = schema;
	if (typeof schemaWithJson.toJSONSchema === "function") return { schema: schemaWithJson.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	}) };
	return { schema: {
		type: "object",
		additionalProperties: true
	} };
}
//#endregion
//#region src/plugin-sdk/command-auth.ts
function resolveDirectDmAuthorizationOutcome(params) {
	if (params.isGroup) return "allowed";
	if (params.dmPolicy === "disabled") return "disabled";
	if (params.dmPolicy !== "open" && !params.senderAllowedForCommands) return "unauthorized";
	return "allowed";
}
async function resolveSenderCommandAuthorizationWithRuntime(params) {
	return resolveSenderCommandAuthorization({
		...params,
		shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
		resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers
	});
}
async function resolveSenderCommandAuthorization(params) {
	const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const storeAllowFrom = !params.isGroup && params.dmPolicy !== "allowlist" && (params.dmPolicy !== "open" || shouldComputeAuth) ? await params.readAllowFromStore().catch(() => []) : [];
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: "allowlist",
		allowFrom: params.configuredAllowFrom,
		groupAllowFrom: params.configuredGroupAllowFrom ?? [],
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom)
	});
	const effectiveAllowFrom = access.effectiveAllowFrom;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom);
	const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
	return {
		shouldComputeAuth,
		effectiveAllowFrom,
		effectiveGroupAllowFrom,
		senderAllowedForCommands,
		commandAuthorized: shouldComputeAuth ? params.resolveCommandAuthorizedFromAuthorizers({
			useAccessGroups,
			authorizers: [{
				configured: effectiveAllowFrom.length > 0,
				allowed: ownerAllowedForCommands
			}, {
				configured: effectiveGroupAllowFrom.length > 0,
				allowed: groupAllowedForCommands
			}]
		}) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/pairing-access.ts
function createScopedPairingAccess(params) {
	const resolvedAccountId = normalizeAccountId(params.accountId);
	return {
		accountId: resolvedAccountId,
		readAllowFromStore: () => params.core.channel.pairing.readAllowFromStore({
			channel: params.channel,
			accountId: resolvedAccountId
		}),
		readStoreForDmPolicy: (provider, accountId) => params.core.channel.pairing.readAllowFromStore({
			channel: provider,
			accountId: normalizeAccountId(accountId)
		}),
		upsertPairingRequest: (input) => params.core.channel.pairing.upsertPairingRequest({
			channel: params.channel,
			accountId: resolvedAccountId,
			...input
		})
	};
}
//#endregion
//#region src/plugin-sdk/inbound-envelope.ts
function createInboundEnvelopeBuilder(params) {
	const storePath = params.resolveStorePath(params.sessionStore, { agentId: params.route.agentId });
	const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
	return (input) => {
		const previousTimestamp = params.readSessionUpdatedAt({
			storePath,
			sessionKey: params.route.sessionKey
		});
		return {
			storePath,
			body: params.formatAgentEnvelope({
				channel: input.channel,
				from: input.from,
				timestamp: input.timestamp,
				previousTimestamp,
				envelope: envelopeOptions,
				body: input.body
			})
		};
	};
}
function resolveInboundRouteEnvelopeBuilder(params) {
	const route = params.resolveAgentRoute({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer
	});
	return {
		route,
		buildEnvelope: createInboundEnvelopeBuilder({
			cfg: params.cfg,
			route,
			sessionStore: params.sessionStore,
			resolveStorePath: params.resolveStorePath,
			readSessionUpdatedAt: params.readSessionUpdatedAt,
			resolveEnvelopeFormatOptions: params.resolveEnvelopeFormatOptions,
			formatAgentEnvelope: params.formatAgentEnvelope
		})
	};
}
function resolveInboundRouteEnvelopeBuilderWithRuntime(params) {
	return resolveInboundRouteEnvelopeBuilder({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer,
		resolveAgentRoute: (routeParams) => params.runtime.routing.resolveAgentRoute(routeParams),
		sessionStore: params.sessionStore,
		resolveStorePath: params.runtime.session.resolveStorePath,
		readSessionUpdatedAt: params.runtime.session.readSessionUpdatedAt,
		resolveEnvelopeFormatOptions: params.runtime.reply.resolveEnvelopeFormatOptions,
		formatAgentEnvelope: params.runtime.reply.formatAgentEnvelope
	});
}
//#endregion
//#region src/plugin-sdk/slack-message-actions.ts
function readSlackBlocksParam(actionParams) {
	return parseSlackBlocksInput(actionParams.blocks);
}
async function handleSlackMessageAction(params) {
	const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
	const { action, cfg, params: actionParams } = ctx;
	const accountId = ctx.accountId ?? void 0;
	const resolveChannelId = () => {
		const channelId = readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to", { required: true });
		return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
	};
	if (action === "send") {
		const to = readStringParam(actionParams, "to", { required: true });
		const content = readStringParam(actionParams, "message", {
			required: false,
			allowEmpty: true
		});
		const mediaUrl = readStringParam(actionParams, "media", { trim: false });
		const blocks = readSlackBlocksParam(actionParams);
		if (!content && !mediaUrl && !blocks) throw new Error("Slack send requires message, blocks, or media.");
		if (mediaUrl && blocks) throw new Error("Slack send does not support blocks with media.");
		const threadId = readStringParam(actionParams, "threadId");
		const replyTo = readStringParam(actionParams, "replyTo");
		return await invoke({
			action: "sendMessage",
			to,
			content: content ?? "",
			mediaUrl: mediaUrl ?? void 0,
			blocks,
			accountId,
			threadTs: threadId ?? replyTo ?? void 0
		}, cfg, ctx.toolContext);
	}
	if (action === "react") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
		const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : void 0;
		return await invoke({
			action: "react",
			channelId: resolveChannelId(),
			messageId,
			emoji,
			remove,
			accountId
		}, cfg);
	}
	if (action === "reactions") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		return await invoke({
			action: "reactions",
			channelId: resolveChannelId(),
			messageId,
			limit,
			accountId
		}, cfg);
	}
	if (action === "read") {
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		const readAction = {
			action: "readMessages",
			channelId: resolveChannelId(),
			limit,
			before: readStringParam(actionParams, "before"),
			after: readStringParam(actionParams, "after"),
			accountId
		};
		if (includeReadThreadId) readAction.threadId = readStringParam(actionParams, "threadId");
		return await invoke(readAction, cfg);
	}
	if (action === "edit") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const content = readStringParam(actionParams, "message", { allowEmpty: true });
		const blocks = readSlackBlocksParam(actionParams);
		if (!content && !blocks) throw new Error("Slack edit requires message or blocks.");
		return await invoke({
			action: "editMessage",
			channelId: resolveChannelId(),
			messageId,
			content: content ?? "",
			blocks,
			accountId
		}, cfg);
	}
	if (action === "delete") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		return await invoke({
			action: "deleteMessage",
			channelId: resolveChannelId(),
			messageId,
			accountId
		}, cfg);
	}
	if (action === "pin" || action === "unpin" || action === "list-pins") {
		const messageId = action === "list-pins" ? void 0 : readStringParam(actionParams, "messageId", { required: true });
		return await invoke({
			action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
			channelId: resolveChannelId(),
			messageId,
			accountId
		}, cfg);
	}
	if (action === "member-info") return await invoke({
		action: "memberInfo",
		userId: readStringParam(actionParams, "userId", { required: true }),
		accountId
	}, cfg);
	if (action === "emoji-list") return await invoke({
		action: "emojiList",
		limit: readNumberParam(actionParams, "limit", { integer: true }),
		accountId
	}, cfg);
	if (action === "download-file") {
		const fileId = readStringParam(actionParams, "fileId", { required: true });
		const channelId = readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
		const threadId = readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
		return await invoke({
			action: "downloadFile",
			fileId,
			channelId: channelId ?? void 0,
			threadId: threadId ?? void 0,
			accountId
		}, cfg);
	}
	throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
//#endregion
//#region src/plugin-sdk/reply-payload.ts
function normalizeOutboundReplyPayload(payload) {
	return {
		text: typeof payload.text === "string" ? payload.text : void 0,
		mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls.filter((entry) => typeof entry === "string" && entry.length > 0) : void 0,
		mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : void 0,
		replyToId: typeof payload.replyToId === "string" ? payload.replyToId : void 0
	};
}
function createNormalizedOutboundDeliverer(handler) {
	return async (payload) => {
		await handler(payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {});
	};
}
function resolveOutboundMediaUrls(payload) {
	if (payload.mediaUrls?.length) return payload.mediaUrls;
	if (payload.mediaUrl) return [payload.mediaUrl];
	return [];
}
async function sendPayloadWithChunkedTextAndMedia(params) {
	const payload = params.ctx.payload;
	const text = payload.text ?? "";
	const urls = resolveOutboundMediaUrls(payload);
	if (!text && urls.length === 0) return params.emptyResult;
	if (urls.length > 0) {
		let lastResult = await params.sendMedia({
			...params.ctx,
			text,
			mediaUrl: urls[0]
		});
		for (let i = 1; i < urls.length; i++) lastResult = await params.sendMedia({
			...params.ctx,
			text: "",
			mediaUrl: urls[i]
		});
		return lastResult;
	}
	const limit = params.textChunkLimit;
	const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
	let lastResult;
	for (const chunk of chunks) lastResult = await params.sendText({
		...params.ctx,
		text: chunk
	});
	return lastResult;
}
function isNumericTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	return /^\d{3,}$/.test(trimmed);
}
function formatTextWithAttachmentLinks(text, mediaUrls) {
	const trimmedText = text?.trim() ?? "";
	if (!trimmedText && mediaUrls.length === 0) return "";
	const mediaBlock = mediaUrls.length ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n") : "";
	if (!trimmedText) return mediaBlock;
	if (!mediaBlock) return trimmedText;
	return `${trimmedText}\n\n${mediaBlock}`;
}
async function sendMediaWithLeadingCaption(params) {
	if (params.mediaUrls.length === 0) return false;
	let first = true;
	for (const mediaUrl of params.mediaUrls) {
		const caption = first ? params.caption : void 0;
		first = false;
		try {
			await params.send({
				mediaUrl,
				caption
			});
		} catch (error) {
			if (params.onError) {
				params.onError(error, mediaUrl);
				continue;
			}
			throw error;
		}
	}
	return true;
}
//#endregion
//#region src/plugin-sdk/inbound-reply-dispatch.ts
async function dispatchReplyFromConfigWithSettledDispatcher(params) {
	return await withReplyDispatcher({
		dispatcher: params.dispatcher,
		onSettled: params.onSettled,
		run: () => dispatchReplyFromConfig({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions
		})
	});
}
function buildInboundReplyDispatchBase(params) {
	return {
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		agentId: params.route.agentId,
		routeSessionKey: params.route.sessionKey,
		storePath: params.storePath,
		ctxPayload: params.ctxPayload,
		recordInboundSession: params.core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
	};
}
async function dispatchInboundReplyWithBase(params) {
	await recordInboundSessionAndDispatchReply({
		...buildInboundReplyDispatchBase(params),
		deliver: params.deliver,
		onRecordError: params.onRecordError,
		onDispatchError: params.onDispatchError,
		replyOptions: params.replyOptions
	});
}
async function recordInboundSessionAndDispatchReply(params) {
	await params.recordInboundSession({
		storePath: params.storePath,
		sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
		ctx: params.ctxPayload,
		onRecordError: params.onRecordError
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId
	});
	const deliver = createNormalizedOutboundDeliverer(params.deliver);
	await params.dispatchReplyWithBufferedBlockDispatcher({
		ctx: params.ctxPayload,
		cfg: params.cfg,
		dispatcherOptions: {
			...prefixOptions,
			deliver,
			onError: params.onDispatchError
		},
		replyOptions: {
			...params.replyOptions,
			onModelSelected
		}
	});
}
//#endregion
//#region src/plugin-sdk/outbound-media.ts
async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
	return await loadWebMedia(mediaUrl, {
		maxBytes: options.maxBytes,
		localRoots: options.mediaLocalRoots
	});
}
//#endregion
//#region src/plugin-sdk/config-paths.ts
function resolveChannelAccountConfigBasePath(params) {
	const accounts = (params.cfg.channels?.[params.channelKey])?.accounts;
	return Boolean(accounts?.[params.accountId]) ? `channels.${params.channelKey}.accounts.${params.accountId}.` : `channels.${params.channelKey}.`;
}
//#endregion
//#region src/plugin-sdk/runtime.ts
function createLoggerBackedRuntime(params) {
	return {
		log: (...args) => {
			params.logger.info(format(...args));
		},
		error: (...args) => {
			params.logger.error(format(...args));
		},
		exit: (code) => {
			throw params.exitError?.(code) ?? /* @__PURE__ */ new Error(`exit ${code}`);
		}
	};
}
function resolveRuntimeEnv(params) {
	return params.runtime ?? createLoggerBackedRuntime(params);
}
function resolveRuntimeEnvWithUnavailableExit(params) {
	return resolveRuntimeEnv({
		runtime: params.runtime,
		logger: params.logger,
		exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available")
	});
}
//#endregion
//#region src/plugin-sdk/text-chunking.ts
function chunkTextForOutbound(text, limit) {
	return chunkTextByBreakResolver(text, limit, (window) => {
		const lastNewline = window.lastIndexOf("\n");
		const lastSpace = window.lastIndexOf(" ");
		return lastNewline > 0 ? lastNewline : lastSpace;
	});
}
//#endregion
//#region src/plugin-sdk/oauth-utils.ts
function toFormUrlEncoded(data) {
	return Object.entries(data).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
function generatePkceVerifierChallenge() {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
//#endregion
//#region src/plugin-sdk/run-command.ts
async function runPluginCommandWithTimeout(options) {
	const [command] = options.argv;
	if (!command) return {
		code: 1,
		stdout: "",
		stderr: "command is required"
	};
	try {
		const result = await runCommandWithTimeout(options.argv, {
			timeoutMs: options.timeoutMs,
			cwd: options.cwd,
			env: options.env
		});
		const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
		return {
			code: result.code ?? 1,
			stdout: result.stdout,
			stderr: timedOut ? result.stderr || `command timed out after ${options.timeoutMs}ms` : result.stderr
		};
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region src/shared/gateway-bind-url.ts
function resolveGatewayBindUrl(params) {
	const bind = params.bind ?? "loopback";
	if (bind === "custom") {
		const host = params.customBindHost?.trim();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=custom"
		};
		return { error: "gateway.bind=custom requires gateway.customBindHost." };
	}
	if (bind === "tailnet") {
		const host = params.pickTailnetHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=tailnet"
		};
		return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
	}
	if (bind === "lan") {
		const host = params.pickLanHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=lan"
		};
		return { error: "gateway.bind=lan set, but no private LAN IP was found." };
	}
	return null;
}
//#endregion
//#region src/shared/tailscale-status.ts
const TAILSCALE_STATUS_COMMAND_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
function parsePossiblyNoisyJsonObject(raw) {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return {};
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return {};
	}
}
function extractTailnetHostFromStatusJson(raw) {
	const parsed = parsePossiblyNoisyJsonObject(raw);
	const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : void 0;
	const dns = typeof self?.DNSName === "string" ? self.DNSName : void 0;
	if (dns && dns.length > 0) return dns.replace(/\.$/, "");
	const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
	return ips.length > 0 ? ips[0] ?? null : null;
}
async function resolveTailnetHostWithRunner(runCommandWithTimeout) {
	if (!runCommandWithTimeout) return null;
	for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) try {
		const result = await runCommandWithTimeout([
			candidate,
			"status",
			"--json"
		], { timeoutMs: 5e3 });
		if (result.code !== 0) continue;
		const raw = result.stdout.trim();
		if (!raw) continue;
		const host = extractTailnetHostFromStatusJson(raw);
		if (host) return host;
	} catch {
		continue;
	}
	return null;
}
//#endregion
//#region src/infra/device-pairing.ts
const PENDING_TTL_MS = 300 * 1e3;
const withLock = createAsyncLock();
async function loadState(baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	const [pending, paired] = await Promise.all([readJsonFile(pendingPath), readJsonFile(pairedPath)]);
	const state = {
		pendingById: pending ?? {},
		pairedByDeviceId: paired ?? {}
	};
	pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	await Promise.all([writeJsonAtomic(pendingPath, state.pendingById), writeJsonAtomic(pairedPath, state.pairedByDeviceId)]);
}
function normalizeRole(role) {
	const trimmed = role?.trim();
	return trimmed ? trimmed : null;
}
function mergeRoles(...items) {
	const roles = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		if (Array.isArray(item)) for (const role of item) {
			const trimmed = role.trim();
			if (trimmed) roles.add(trimmed);
		}
		else {
			const trimmed = item.trim();
			if (trimmed) roles.add(trimmed);
		}
	}
	if (roles.size === 0) return;
	return [...roles];
}
function mergeScopes(...items) {
	const scopes = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		for (const scope of item) {
			const trimmed = scope.trim();
			if (trimmed) scopes.add(trimmed);
		}
	}
	if (scopes.size === 0) return;
	return [...scopes];
}
function newToken() {
	return generatePairingToken();
}
async function listDevicePairing(baseDir) {
	const state = await loadState(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
		paired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function approveDevicePairing(requestId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
		const now = Date.now();
		const existing = state.pairedByDeviceId[pending.deviceId];
		const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
		const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
		const tokens = existing?.tokens ? { ...existing.tokens } : {};
		const roleForToken = normalizeRole(pending.role);
		if (roleForToken) {
			const existingToken = tokens[roleForToken];
			const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
			const nextScopes = requestedScopes.length > 0 ? requestedScopes : normalizeDeviceAuthScopes(existingToken?.scopes ?? approvedScopes ?? existing?.approvedScopes ?? existing?.scopes);
			const now = Date.now();
			tokens[roleForToken] = {
				token: newToken(),
				role: roleForToken,
				scopes: nextScopes,
				createdAtMs: existingToken?.createdAtMs ?? now,
				rotatedAtMs: existingToken ? now : void 0,
				revokedAtMs: void 0,
				lastUsedAtMs: existingToken?.lastUsedAtMs
			};
		}
		const device = {
			deviceId: pending.deviceId,
			publicKey: pending.publicKey,
			displayName: pending.displayName,
			platform: pending.platform,
			deviceFamily: pending.deviceFamily,
			clientId: pending.clientId,
			clientMode: pending.clientMode,
			role: pending.role,
			roles,
			scopes: approvedScopes,
			approvedScopes,
			remoteIp: pending.remoteIp,
			tokens,
			createdAtMs: existing?.createdAtMs ?? now,
			approvedAtMs: now
		};
		delete state.pendingById[requestId];
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, baseDir);
		return {
			requestId,
			device
		};
	});
}
async function rejectDevicePairing(requestId, baseDir) {
	return await withLock(async () => {
		return await rejectPendingPairingRequest({
			requestId,
			idKey: "deviceId",
			loadState: () => loadState(baseDir),
			persistState: (state) => persistState(state, baseDir),
			getId: (pending) => pending.deviceId
		});
	});
}
//#endregion
//#region src/plugin-sdk/persistent-dedupe.ts
const DEFAULT_LOCK_OPTIONS = {
	retries: {
		retries: 6,
		factor: 1.35,
		minTimeout: 8,
		maxTimeout: 180,
		randomize: true
	},
	stale: 6e4
};
function mergeLockOptions(overrides) {
	return {
		stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
		retries: {
			retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
			factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
			minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
			maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
			randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize
		}
	};
}
function sanitizeData(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, ts] of Object.entries(value)) if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) out[key] = ts;
	return out;
}
function pruneData(data, now, ttlMs, maxEntries) {
	if (ttlMs > 0) {
		for (const [key, ts] of Object.entries(data)) if (now - ts >= ttlMs) delete data[key];
	}
	const keys = Object.keys(data);
	if (keys.length <= maxEntries) return;
	keys.toSorted((a, b) => data[a] - data[b]).slice(0, keys.length - maxEntries).forEach((key) => {
		delete data[key];
	});
}
function createPersistentDedupe(options) {
	const ttlMs = Math.max(0, Math.floor(options.ttlMs));
	const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
	const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
	const lockOptions = mergeLockOptions(options.lockOptions);
	const memory = createDedupeCache({
		ttlMs,
		maxSize: memoryMaxSize
	});
	const inflight = /* @__PURE__ */ new Map();
	async function checkAndRecordInner(key, namespace, scopedKey, now, onDiskError) {
		if (memory.check(scopedKey, now)) return false;
		const path = options.resolveFilePath(namespace);
		try {
			return !await withFileLock(path, lockOptions, async () => {
				const { value } = await readJsonFileWithFallback(path, {});
				const data = sanitizeData(value);
				const seenAt = data[key];
				if (seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs)) return true;
				data[key] = now;
				pruneData(data, now, ttlMs, fileMaxEntries);
				await writeJsonFileAtomically(path, data);
				return false;
			});
		} catch (error) {
			onDiskError?.(error);
			memory.check(scopedKey, now);
			return true;
		}
	}
	async function warmup(namespace = "global", onError) {
		const filePath = options.resolveFilePath(namespace);
		const now = Date.now();
		try {
			const { value } = await readJsonFileWithFallback(filePath, {});
			const data = sanitizeData(value);
			let loaded = 0;
			for (const [key, ts] of Object.entries(data)) {
				if (ttlMs > 0 && now - ts >= ttlMs) continue;
				const scopedKey = `${namespace}:${key}`;
				memory.check(scopedKey, ts);
				loaded++;
			}
			return loaded;
		} catch (error) {
			onError?.(error);
			return 0;
		}
	}
	async function checkAndRecord(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return true;
		const namespace = dedupeOptions?.namespace?.trim() || "global";
		const scopedKey = `${namespace}:${trimmed}`;
		if (inflight.has(scopedKey)) return false;
		const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
		const work = checkAndRecordInner(trimmed, namespace, scopedKey, dedupeOptions?.now ?? Date.now(), onDiskError);
		inflight.set(scopedKey, work);
		try {
			return await work;
		} finally {
			inflight.delete(scopedKey);
		}
	}
	return {
		checkAndRecord,
		warmup,
		clearMemory: () => memory.clear(),
		memorySize: () => memory.size()
	};
}
//#endregion
//#region src/plugin-sdk/webhook-memory-guards.ts
const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
	windowMs: 6e4,
	maxRequests: 120,
	maxTrackedKeys: 4096
});
const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
	maxTrackedKeys: 4096,
	ttlMs: 360 * 6e4,
	logEvery: 25
});
const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([
	400,
	401,
	408,
	413,
	415,
	429
]);
function createFixedWindowRateLimiter(options) {
	const windowMs = Math.max(1, Math.floor(options.windowMs));
	const maxRequests = Math.max(1, Math.floor(options.maxRequests));
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? windowMs));
	const state = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		state.delete(key);
		state.set(key, value);
	};
	const prune = (nowMs) => {
		for (const [key, entry] of state) if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
	};
	return {
		isRateLimited: (key, nowMs = Date.now()) => {
			if (!key) return false;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = state.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) {
				touch(key, {
					count: 1,
					windowStartMs: nowMs
				});
				pruneMapToMaxSize(state, maxTrackedKeys);
				return false;
			}
			const nextCount = existing.count + 1;
			touch(key, {
				count: nextCount,
				windowStartMs: existing.windowStartMs
			});
			pruneMapToMaxSize(state, maxTrackedKeys);
			return nextCount > maxRequests;
		},
		size: () => state.size,
		clear: () => {
			state.clear();
			lastPruneMs = 0;
		}
	};
}
function createBoundedCounter(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options.ttlMs ?? 0));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? (ttlMs > 0 ? ttlMs : 6e4)));
	const counters = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		counters.delete(key);
		counters.set(key, value);
	};
	const isExpired = (entry, nowMs) => ttlMs > 0 && nowMs - entry.updatedAtMs >= ttlMs;
	const prune = (nowMs) => {
		if (ttlMs > 0) {
			for (const [key, entry] of counters) if (isExpired(entry, nowMs)) counters.delete(key);
		}
	};
	return {
		increment: (key, nowMs = Date.now()) => {
			if (!key) return 0;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = counters.get(key);
			const nextCount = (existing && !isExpired(existing, nowMs) ? existing.count : 0) + 1;
			touch(key, {
				count: nextCount,
				updatedAtMs: nowMs
			});
			pruneMapToMaxSize(counters, maxTrackedKeys);
			return nextCount;
		},
		size: () => counters.size,
		clear: () => {
			counters.clear();
			lastPruneMs = 0;
		}
	};
}
function createWebhookAnomalyTracker(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options?.maxTrackedKeys ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options?.ttlMs ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs));
	const logEvery = Math.max(1, Math.floor(options?.logEvery ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery));
	const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
	const counter = createBoundedCounter({
		maxTrackedKeys,
		ttlMs
	});
	return {
		record: ({ key, statusCode, message, log, nowMs }) => {
			if (!trackedStatusCodes.has(statusCode)) return 0;
			const next = counter.increment(key, nowMs);
			if (log && (next === 1 || next % logEvery === 0)) log(message(next));
			return next;
		},
		size: () => counter.size(),
		clear: () => counter.clear()
	};
}
//#endregion
//#region src/plugin-sdk/ssrf-policy.ts
function normalizeHostnameSuffix(value) {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "";
	if (trimmed === "*" || trimmed === "*.") return "*";
	return trimmed.replace(/^\*\.?/, "").replace(/^\.+/, "").replace(/\.+$/, "");
}
function isHostnameAllowedBySuffixAllowlist(hostname, allowlist) {
	if (allowlist.includes("*")) return true;
	const normalized = hostname.toLowerCase();
	return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}
function normalizeHostnameSuffixAllowlist(input, defaults) {
	const source = input && input.length > 0 ? input : defaults;
	if (!source || source.length === 0) return [];
	const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
	if (normalized.includes("*")) return ["*"];
	return Array.from(new Set(normalized));
}
function isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") return false;
		return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
	} catch {
		return false;
	}
}
/**
* Converts suffix-style host allowlists (for example "example.com") into SSRF
* hostname allowlist patterns used by the shared fetch guard.
*
* Suffix semantics:
* - "example.com" allows "example.com" and "*.example.com"
* - "*" disables hostname allowlist restrictions
*/
function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts) {
	const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
	if (normalizedAllowHosts.length === 0) return;
	const patterns = /* @__PURE__ */ new Set();
	for (const normalized of normalizedAllowHosts) {
		if (normalized === "*") return;
		patterns.add(normalized);
		patterns.add(`*.${normalized}`);
	}
	if (patterns.size === 0) return;
	return { hostnameAllowlist: Array.from(patterns) };
}
//#endregion
//#region src/plugin-sdk/fetch-auth.ts
function isAuthFailureStatus(status) {
	return status === 401 || status === 403;
}
async function fetchWithBearerAuthScopeFallback(params) {
	const fetchFn = params.fetchFn ?? fetch;
	let parsedUrl;
	try {
		parsedUrl = new URL(params.url);
	} catch {
		throw new Error(`Invalid URL: ${params.url}`);
	}
	if (params.requireHttps === true && parsedUrl.protocol !== "https:") throw new Error(`URL must use HTTPS: ${params.url}`);
	const fetchOnce = (headers) => fetchFn(params.url, {
		...params.requestInit,
		...headers ? { headers } : {}
	});
	const firstAttempt = await fetchOnce();
	if (firstAttempt.ok) return firstAttempt;
	if (!params.tokenProvider) return firstAttempt;
	const shouldRetry = params.shouldRetry ?? ((response) => isAuthFailureStatus(response.status));
	if (!shouldRetry(firstAttempt)) return firstAttempt;
	if (params.shouldAttachAuth && !params.shouldAttachAuth(params.url)) return firstAttempt;
	for (const scope of params.scopes) try {
		const token = await params.tokenProvider.getAccessToken(scope);
		const authHeaders = new Headers(params.requestInit?.headers);
		authHeaders.set("Authorization", `Bearer ${token}`);
		const authAttempt = await fetchOnce(authHeaders);
		if (authAttempt.ok) return authAttempt;
		if (!shouldRetry(authAttempt)) continue;
	} catch {}
	return firstAttempt;
}
//#endregion
//#region src/channels/plugins/directory-config-helpers.ts
function resolveDirectoryQuery(query) {
	return query?.trim().toLowerCase() || "";
}
function resolveDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : void 0;
}
function applyDirectoryQueryAndLimit(ids, params) {
	const q = resolveDirectoryQuery(params.query);
	const limit = resolveDirectoryLimit(params.limit);
	const filtered = ids.filter((id) => q ? id.toLowerCase().includes(q) : true);
	return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}
function toDirectoryEntries(kind, ids) {
	return ids.map((id) => ({
		kind,
		id
	}));
}
function collectDirectoryIdsFromEntries(params) {
	return (params.entries ?? []).map((entry) => String(entry).trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function collectDirectoryIdsFromMapKeys(params) {
	return Object.keys(params.groups ?? {}).map((entry) => entry.trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function dedupeDirectoryIds(ids) {
	return Array.from(new Set(ids));
}
function listDirectoryUserEntriesFromAllowFrom(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryUserEntriesFromAllowFromAndMapKeys(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	}), ...collectDirectoryIdsFromMapKeys({
		groups: params.map,
		normalizeId: params.normalizeMapKeyId
	})]), params));
}
function listDirectoryGroupEntriesFromMapKeys(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeMapKeyId
	}), ...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	})]), params));
}
//#endregion
//#region src/channels/plugins/group-policy-warnings.ts
function buildOpenGroupPolicyWarning(params) {
	return `- ${params.surface}: groupPolicy="open" ${params.openBehavior}. ${params.remediation}.`;
}
function buildOpenGroupPolicyRestrictSendersWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} to restrict senders`
	});
}
function buildOpenGroupPolicyNoRouteAllowlistWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `with no ${params.routeAllowlistPath} allowlist; any ${params.routeScope} can add + ping${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} or configure ${params.routeAllowlistPath}`
	});
}
function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" and configure ${params.routeAllowlistPath}`
	});
}
function collectOpenGroupPolicyRestrictSendersWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	return [buildOpenGroupPolicyRestrictSendersWarning(params)];
}
function collectAllowlistProviderRestrictSendersWarnings(params) {
	return collectAllowlistProviderGroupPolicyWarnings({
		cfg: params.cfg,
		providerConfigPresent: params.providerConfigPresent,
		configuredGroupPolicy: params.configuredGroupPolicy,
		collect: (groupPolicy) => collectOpenGroupPolicyRestrictSendersWarnings({
			groupPolicy,
			surface: params.surface,
			openScope: params.openScope,
			groupPolicyPath: params.groupPolicyPath,
			groupAllowFromPath: params.groupAllowFromPath,
			mentionGated: params.mentionGated
		})
	});
}
function collectAllowlistProviderGroupPolicyWarnings(params) {
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy ?? void 0,
		defaultGroupPolicy
	});
	return params.collect(groupPolicy);
}
function collectOpenProviderGroupPolicyWarnings(params) {
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy ?? void 0,
		defaultGroupPolicy
	});
	return params.collect(groupPolicy);
}
function collectOpenGroupPolicyRouteAllowlistWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	if (params.routeAllowlistConfigured) return [buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)];
	return [buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)];
}
function collectOpenGroupPolicyConfiguredRouteWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	if (params.routeAllowlistConfigured) return [buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)];
	return [buildOpenGroupPolicyWarning(params.missingRouteAllowlist)];
}
//#endregion
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/channels/plugins/onboarding/channel-access.ts
function parseAllowlistEntries(raw) {
	return splitOnboardingEntries(String(raw ?? ""));
}
function formatAllowlistEntries(entries) {
	return entries.map((entry) => entry.trim()).filter(Boolean).join(", ");
}
async function promptChannelAccessPolicy(params) {
	const options = [{
		value: "allowlist",
		label: "Allowlist (recommended)"
	}];
	if (params.allowOpen !== false) options.push({
		value: "open",
		label: "Open (allow all channels)"
	});
	if (params.allowDisabled !== false) options.push({
		value: "disabled",
		label: "Disabled (block all channels)"
	});
	const initialValue = params.currentPolicy ?? "allowlist";
	return await params.prompter.select({
		message: `${params.label} access`,
		options,
		initialValue
	});
}
async function promptChannelAllowlist(params) {
	const initialValue = params.currentEntries && params.currentEntries.length > 0 ? formatAllowlistEntries(params.currentEntries) : void 0;
	return parseAllowlistEntries(await params.prompter.text({
		message: `${params.label} allowlist (comma-separated)`,
		placeholder: params.placeholder,
		initialValue
	}));
}
async function promptChannelAccessConfig(params) {
	const hasEntries = (params.currentEntries ?? []).length > 0;
	const shouldPrompt = params.defaultPrompt ?? !hasEntries;
	if (!await params.prompter.confirm({
		message: params.updatePrompt ? `Update ${params.label} access?` : `Configure ${params.label} access?`,
		initialValue: shouldPrompt
	})) return null;
	const policy = await promptChannelAccessPolicy({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		allowOpen: params.allowOpen,
		allowDisabled: params.allowDisabled
	});
	if (policy !== "allowlist") return {
		policy,
		entries: []
	};
	return {
		policy,
		entries: await promptChannelAllowlist({
			prompter: params.prompter,
			label: params.label,
			currentEntries: params.currentEntries,
			placeholder: params.placeholder
		})
	};
}
//#endregion
//#region src/channels/plugins/onboarding/channel-access-configure.ts
async function configureChannelAccessWithAllowlist(params) {
	let next = params.cfg;
	const accessConfig = await promptChannelAccessConfig({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		currentEntries: params.currentEntries,
		placeholder: params.placeholder,
		updatePrompt: params.updatePrompt
	});
	if (!accessConfig) return next;
	if (accessConfig.policy !== "allowlist") return params.setPolicy(next, accessConfig.policy);
	const resolved = await params.resolveAllowlist({
		cfg: next,
		entries: accessConfig.entries
	});
	next = params.setPolicy(next, "allowlist");
	return params.applyAllowlist({
		cfg: next,
		resolved
	});
}
//#endregion
//#region src/channels/plugins/onboarding/discord.ts
const channel$5 = "discord";
async function noteDiscordTokenHelp(prompter) {
	await prompter.note([
		"1) Discord Developer Portal → Applications → New Application",
		"2) Bot → Add Bot → Reset Token → copy token",
		"3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
		"Tip: enable Message Content Intent if you need message text. (Bot → Privileged Gateway Intents → Message Content Intent)",
		`Docs: ${formatDocsLink("/discord", "discord")}`
	].join("\n"), "Discord bot token");
}
function setDiscordGuildChannelAllowlist(cfg, accountId, entries) {
	const guilds = { ...accountId === "default" ? cfg.channels?.discord?.guilds ?? {} : cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {} };
	for (const entry of entries) {
		const guildKey = entry.guildKey || "*";
		const existing = guilds[guildKey] ?? {};
		if (entry.channelKey) {
			const channels = { ...existing.channels };
			channels[entry.channelKey] = { allow: true };
			guilds[guildKey] = {
				...existing,
				channels
			};
		} else guilds[guildKey] = existing;
	}
	return patchChannelConfigForAccount({
		cfg,
		channel: "discord",
		accountId,
		patch: { guilds }
	});
}
async function promptDiscordAllowFrom(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultDiscordAccountId(params.cfg)
	});
	const token = resolveDiscordAccount({
		cfg: params.cfg,
		accountId
	}).token;
	const existing = params.cfg.channels?.discord?.allowFrom ?? params.cfg.channels?.discord?.dm?.allowFrom ?? [];
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixPattern: /^(user:|discord:)/i,
		idPattern: /^\d+$/
	});
	return promptLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: "discord",
		prompter: params.prompter,
		existing,
		token,
		noteTitle: "Discord allowlist",
		noteLines: [
			"Allowlist Discord DMs by username (we resolve to user ids).",
			"Examples:",
			"- 123456789012345678",
			"- @alice",
			"- alice#1234",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/discord", "discord")}`
		],
		message: "Discord allowFrom (usernames or ids)",
		placeholder: "@alice, 123456789012345678",
		parseId,
		invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
		resolveEntries: ({ token, entries }) => resolveDiscordUserAllowlist({
			token,
			entries
		})
	});
}
const discordOnboardingAdapter = {
	channel: channel$5,
	getStatus: async ({ cfg }) => {
		const configured = listDiscordAccountIds(cfg).some((accountId) => {
			return inspectDiscordAccount({
				cfg,
				accountId
			}).configured;
		});
		return {
			channel: channel$5,
			configured,
			statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
			selectionHint: configured ? "configured" : "needs token",
			quickstartScore: configured ? 2 : 1
		};
	},
	configure: async ({ cfg, prompter, options, accountOverrides, shouldPromptAccountIds }) => {
		const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
		const discordAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Discord",
			accountOverride: accountOverrides.discord,
			shouldPromptAccountIds,
			listAccountIds: listDiscordAccountIds,
			defaultAccountId: defaultDiscordAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveDiscordAccount({
			cfg: next,
			accountId: discordAccountId
		});
		const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
		const tokenStep = await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "discord",
			credentialLabel: "Discord bot token",
			secretInputMode: options?.secretInputMode,
			accountConfigured: Boolean(resolvedAccount.token),
			hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.token),
			allowEnv,
			envValue: process.env.DISCORD_BOT_TOKEN,
			envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Discord token already configured. Keep it?",
			inputPrompt: "Enter Discord bot token",
			preferredEnvVar: allowEnv ? "DISCORD_BOT_TOKEN" : void 0,
			onMissingConfigured: async () => await noteDiscordTokenHelp(prompter),
			applyUseEnv: async (cfg) => applySingleTokenPromptResult({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				tokenPatchKey: "token",
				tokenResult: {
					useEnv: true,
					token: null
				}
			}),
			applySet: async (cfg, value) => applySingleTokenPromptResult({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				tokenPatchKey: "token",
				tokenResult: {
					useEnv: false,
					token: value
				}
			})
		});
		next = tokenStep.cfg;
		const currentEntries = Object.entries(resolvedAccount.config.guilds ?? {}).flatMap(([guildKey, value]) => {
			const channels = value?.channels ?? {};
			const channelKeys = Object.keys(channels);
			if (channelKeys.length === 0) return [/^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey];
			return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
		});
		next = await configureChannelAccessWithAllowlist({
			cfg: next,
			prompter,
			label: "Discord channels",
			currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
			currentEntries,
			placeholder: "My Server/#general, guildId/channelId, #support",
			updatePrompt: Boolean(resolvedAccount.config.guilds),
			setPolicy: (cfg, policy) => setAccountGroupPolicyForChannel({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				groupPolicy: policy
			}),
			resolveAllowlist: async ({ cfg, entries }) => {
				const accountWithTokens = resolveDiscordAccount({
					cfg,
					accountId: discordAccountId
				});
				let resolved = entries.map((input) => ({
					input,
					resolved: false
				}));
				const activeToken = accountWithTokens.token || tokenStep.resolvedValue || "";
				if (activeToken && entries.length > 0) try {
					resolved = await resolveDiscordChannelAllowlist({
						token: activeToken,
						entries
					});
					const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
					const resolvedGuilds = resolved.filter((entry) => entry.resolved && entry.guildId && !entry.channelId);
					const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
					await noteChannelLookupSummary({
						prompter,
						label: "Discord channels",
						resolvedSections: [{
							title: "Resolved channels",
							values: resolvedChannels.map((entry) => entry.channelId).filter((value) => Boolean(value))
						}, {
							title: "Resolved guilds",
							values: resolvedGuilds.map((entry) => entry.guildId).filter((value) => Boolean(value))
						}],
						unresolved
					});
				} catch (err) {
					await noteChannelLookupFailure({
						prompter,
						label: "Discord channels",
						error: err
					});
				}
				return resolved;
			},
			applyAllowlist: ({ cfg, resolved }) => {
				const allowlistEntries = [];
				for (const entry of resolved) {
					const guildKey = entry.guildId ?? (entry.guildName ? normalizeDiscordSlug(entry.guildName) : void 0) ?? "*";
					const channelKey = entry.channelId ?? (entry.channelName ? normalizeDiscordSlug(entry.channelName) : void 0);
					if (!channelKey && guildKey === "*") continue;
					allowlistEntries.push({
						guildKey,
						...channelKey ? { channelKey } : {}
					});
				}
				return setDiscordGuildChannelAllowlist(cfg, discordAccountId, allowlistEntries);
			}
		});
		return {
			cfg: next,
			accountId: discordAccountId
		};
	},
	dmPolicy: {
		label: "Discord",
		channel: channel$5,
		policyKey: "channels.discord.dmPolicy",
		allowFromKey: "channels.discord.allowFrom",
		getCurrent: (cfg) => cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
		setPolicy: (cfg, policy) => setLegacyChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "discord",
			dmPolicy: policy
		}),
		promptAllowFrom: promptDiscordAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$5, false)
};
//#endregion
//#region src/channels/plugins/normalize/discord.ts
function normalizeDiscordMessagingTarget(raw) {
	return parseDiscordTarget(raw, { defaultKind: "channel" })?.normalized;
}
/**
* Normalize a Discord outbound target for delivery. Bare numeric IDs are
* prefixed with "channel:" to avoid the ambiguous-target error in
* parseDiscordTarget. All other formats pass through unchanged.
*/
function normalizeDiscordOutboundTarget(to) {
	const trimmed = to?.trim();
	if (!trimmed) return {
		ok: false,
		error: /* @__PURE__ */ new Error("Discord recipient is required. Use \"channel:<id>\" for channels or \"user:<id>\" for DMs.")
	};
	if (/^\d+$/.test(trimmed)) return {
		ok: true,
		to: `channel:${trimmed}`
	};
	return {
		ok: true,
		to: trimmed
	};
}
function looksLikeDiscordTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (/^<@!?\d+>$/.test(trimmed)) return true;
	if (/^(user|channel|discord):/i.test(trimmed)) return true;
	if (/^\d{6,}$/.test(trimmed)) return true;
	return false;
}
//#endregion
//#region src/channels/plugins/status-issues/shared.ts
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function formatMatchMetadata(params) {
	const matchKey = typeof params.matchKey === "string" ? params.matchKey : typeof params.matchKey === "number" ? String(params.matchKey) : void 0;
	const matchSource = asString(params.matchSource);
	const parts = [matchKey ? `matchKey=${matchKey}` : null, matchSource ? `matchSource=${matchSource}` : null].filter((entry) => Boolean(entry));
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function appendMatchMetadata(message, params) {
	const meta = formatMatchMetadata(params);
	return meta ? `${message} (${meta})` : message;
}
function resolveEnabledConfiguredAccountId(account) {
	const accountId = asString(account.accountId) ?? "default";
	const enabled = account.enabled !== false;
	const configured = account.configured === true;
	return enabled && configured ? accountId : null;
}
function collectIssuesForEnabledAccounts(params) {
	const issues = [];
	for (const entry of params.accounts) {
		const account = params.readAccount(entry);
		if (!account || account.enabled === false) continue;
		const accountId = asString(account.accountId) ?? "default";
		params.collectIssues({
			account,
			accountId,
			issues
		});
	}
	return issues;
}
//#endregion
//#region src/channels/plugins/status-issues/discord.ts
function readDiscordAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		configured: value.configured,
		application: value.application,
		audit: value.audit
	};
}
function readDiscordApplicationSummary(value) {
	if (!isRecord(value)) return {};
	const intentsRaw = value.intents;
	if (!isRecord(intentsRaw)) return {};
	return { intents: { messageContent: intentsRaw.messageContent === "enabled" || intentsRaw.messageContent === "limited" || intentsRaw.messageContent === "disabled" ? intentsRaw.messageContent : void 0 } };
}
function readDiscordPermissionsAuditSummary(value) {
	if (!isRecord(value)) return {};
	const unresolvedChannels = typeof value.unresolvedChannels === "number" && Number.isFinite(value.unresolvedChannels) ? value.unresolvedChannels : void 0;
	const channelsRaw = value.channels;
	return {
		unresolvedChannels,
		channels: Array.isArray(channelsRaw) ? channelsRaw.map((entry) => {
			if (!isRecord(entry)) return null;
			const channelId = asString(entry.channelId);
			if (!channelId) return null;
			const ok = typeof entry.ok === "boolean" ? entry.ok : void 0;
			const missing = Array.isArray(entry.missing) ? entry.missing.map((v) => asString(v)).filter(Boolean) : void 0;
			const error = asString(entry.error) ?? null;
			const matchKey = asString(entry.matchKey) ?? void 0;
			const matchSource = asString(entry.matchSource) ?? void 0;
			return {
				channelId,
				ok,
				missing: missing?.length ? missing : void 0,
				error,
				matchKey,
				matchSource
			};
		}).filter(Boolean) : void 0
	};
}
function collectDiscordStatusIssues(accounts) {
	const issues = [];
	for (const entry of accounts) {
		const account = readDiscordAccountStatus(entry);
		if (!account) continue;
		const accountId = resolveEnabledConfiguredAccountId(account);
		if (!accountId) continue;
		if (readDiscordApplicationSummary(account.application).intents?.messageContent === "disabled") issues.push({
			channel: "discord",
			accountId,
			kind: "intent",
			message: "Message Content Intent is disabled. Bot may not see normal channel messages.",
			fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation."
		});
		const audit = readDiscordPermissionsAuditSummary(account.audit);
		if (audit.unresolvedChannels && audit.unresolvedChannels > 0) issues.push({
			channel: "discord",
			accountId,
			kind: "config",
			message: `Some configured guild channels are not numeric IDs (unresolvedChannels=${audit.unresolvedChannels}). Permission audit can only check numeric channel IDs.`,
			fix: "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe)."
		});
		for (const channel of audit.channels ?? []) {
			if (channel.ok === true) continue;
			const missing = channel.missing?.length ? ` missing ${channel.missing.join(", ")}` : "";
			const error = channel.error ? `: ${channel.error}` : "";
			const baseMessage = `Channel ${channel.channelId} permission check failed.${missing}${error}`;
			issues.push({
				channel: "discord",
				accountId,
				kind: "permissions",
				message: appendMatchMetadata(baseMessage, {
					matchKey: channel.matchKey,
					matchSource: channel.matchSource
				}),
				fix: "Ensure the bot role can view + send in this channel (and that channel overrides don't deny it)."
			});
		}
	}
	return issues;
}
//#endregion
//#region src/channels/plugins/onboarding/imessage.ts
const channel$4 = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		const lower = entry.toLowerCase();
		if (lower.startsWith("chat_id:")) {
			const id = entry.slice(8).trim();
			if (!/^\d+$/.test(id)) return { error: `Invalid chat_id: ${entry}` };
			return { value: entry };
		}
		if (lower.startsWith("chat_guid:")) {
			if (!entry.slice(10).trim()) return { error: "Invalid chat_guid entry" };
			return { value: entry };
		}
		if (lower.startsWith("chat_identifier:")) {
			if (!entry.slice(16).trim()) return { error: "Invalid chat_identifier entry" };
			return { value: entry };
		}
		if (!normalizeIMessageHandle(entry)) return { error: `Invalid handle: ${entry}` };
		return { value: entry };
	});
}
async function promptIMessageAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "iMessage allowlist",
		noteLines: [
			"Allowlist iMessage DMs by handle or chat target.",
			"Examples:",
			"- +15555550123",
			"- user@example.com",
			"- chat_id:123",
			"- chat_guid:... or chat_identifier:...",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		],
		message: "iMessage allowFrom (handle or chat_id)",
		placeholder: "+15555550123, user@example.com, chat_id:123",
		parseEntries: parseIMessageAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveIMessageAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const imessageOnboardingAdapter = {
	channel: channel$4,
	getStatus: async ({ cfg }) => {
		const configured = listIMessageAccountIds(cfg).some((accountId) => {
			const account = resolveIMessageAccount({
				cfg,
				accountId
			});
			return Boolean(account.config.cliPath || account.config.dbPath || account.config.allowFrom || account.config.service || account.config.region);
		});
		const imessageCliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
		const imessageCliDetected = await detectBinary(imessageCliPath);
		return {
			channel: channel$4,
			configured,
			statusLines: [`iMessage: ${configured ? "configured" : "needs setup"}`, `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`],
			selectionHint: imessageCliDetected ? "imsg found" : "imsg missing",
			quickstartScore: imessageCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
		const defaultIMessageAccountId = resolveDefaultIMessageAccountId(cfg);
		const imessageAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "iMessage",
			accountOverride: accountOverrides.imessage,
			shouldPromptAccountIds,
			listAccountIds: listIMessageAccountIds,
			defaultAccountId: defaultIMessageAccountId
		});
		let next = cfg;
		let resolvedCliPath = resolveIMessageAccount({
			cfg: next,
			accountId: imessageAccountId
		}).config.cliPath ?? "imsg";
		if (!await detectBinary(resolvedCliPath)) {
			const entered = await prompter.text({
				message: "imsg CLI path",
				initialValue: resolvedCliPath,
				validate: (value) => value?.trim() ? void 0 : "Required"
			});
			resolvedCliPath = String(entered).trim();
			if (!resolvedCliPath) await prompter.note("imsg CLI path required to enable iMessage.", "iMessage");
		}
		if (resolvedCliPath) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "imessage",
			accountId: imessageAccountId,
			patch: { cliPath: resolvedCliPath }
		});
		await prompter.note([
			"This is still a work in progress.",
			"Ensure OpenClaw has Full Disk Access to Messages DB.",
			"Grant Automation permission for Messages when prompted.",
			"List chats with: imsg chats --limit 20",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		].join("\n"), "iMessage next steps");
		return {
			cfg: next,
			accountId: imessageAccountId
		};
	},
	dmPolicy: {
		label: "iMessage",
		channel: channel$4,
		policyKey: "channels.imessage.dmPolicy",
		allowFromKey: "channels.imessage.allowFrom",
		getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "imessage",
			dmPolicy: policy
		}),
		promptAllowFrom: promptIMessageAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$4, false)
};
//#endregion
//#region src/channels/plugins/normalize/imessage.ts
const SERVICE_PREFIXES = [
	"imessage:",
	"sms:",
	"auto:"
];
const CHAT_TARGET_PREFIX_RE = /^(chat_id:|chatid:|chat:|chat_guid:|chatguid:|guid:|chat_identifier:|chatidentifier:|chatident:)/i;
function normalizeIMessageMessagingTarget(raw) {
	const trimmed = trimMessagingTarget(raw);
	if (!trimmed) return;
	const lower = trimmed.toLowerCase();
	for (const prefix of SERVICE_PREFIXES) if (lower.startsWith(prefix)) {
		const normalizedHandle = normalizeIMessageHandle(trimmed.slice(prefix.length).trim());
		if (!normalizedHandle) return;
		if (CHAT_TARGET_PREFIX_RE.test(normalizedHandle)) return normalizedHandle;
		return `${prefix}${normalizedHandle}`;
	}
	return normalizeIMessageHandle(trimmed) || void 0;
}
function looksLikeIMessageTargetId(raw) {
	const trimmed = trimMessagingTarget(raw);
	if (!trimmed) return false;
	if (CHAT_TARGET_PREFIX_RE.test(trimmed)) return true;
	return looksLikeHandleOrPhoneTarget({
		raw: trimmed,
		prefixPattern: /^(imessage:|sms:|auto:)/i
	});
}
//#endregion
//#region src/slack/message-actions.ts
function listSlackMessageActions(cfg) {
	const accounts = listEnabledSlackAccounts(cfg).filter((account) => account.botTokenSource !== "none");
	if (accounts.length === 0) return [];
	const isActionEnabled = (key, defaultValue = true) => {
		for (const account of accounts) if (createActionGate(account.actions ?? cfg.channels?.slack?.actions)(key, defaultValue)) return true;
		return false;
	};
	const actions = new Set(["send"]);
	if (isActionEnabled("reactions")) {
		actions.add("react");
		actions.add("reactions");
	}
	if (isActionEnabled("messages")) {
		actions.add("read");
		actions.add("edit");
		actions.add("delete");
		actions.add("download-file");
	}
	if (isActionEnabled("pins")) {
		actions.add("pin");
		actions.add("unpin");
		actions.add("list-pins");
	}
	if (isActionEnabled("memberInfo")) actions.add("member-info");
	if (isActionEnabled("emojiList")) actions.add("emoji-list");
	return Array.from(actions);
}
function extractSlackToolSend(args) {
	if ((typeof args.action === "string" ? args.action.trim() : "") !== "sendMessage") return null;
	const to = typeof args.to === "string" ? args.to : void 0;
	if (!to) return null;
	return {
		to,
		accountId: typeof args.accountId === "string" ? args.accountId.trim() : void 0
	};
}
//#endregion
//#region src/channels/plugins/onboarding/slack.ts
const channel$3 = "slack";
function buildSlackManifest(botName) {
	const safeName = botName.trim() || "OpenClaw";
	const manifest = {
		display_information: {
			name: safeName,
			description: `${safeName} connector for OpenClaw`
		},
		features: {
			bot_user: {
				display_name: safeName,
				always_online: false
			},
			app_home: {
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false
			},
			slash_commands: [{
				command: "/openclaw",
				description: "Send a message to OpenClaw",
				should_escape: false
			}]
		},
		oauth_config: { scopes: { bot: [
			"chat:write",
			"channels:history",
			"channels:read",
			"groups:history",
			"im:history",
			"mpim:history",
			"users:read",
			"app_mentions:read",
			"reactions:read",
			"reactions:write",
			"pins:read",
			"pins:write",
			"emoji:read",
			"commands",
			"files:read",
			"files:write"
		] } },
		settings: {
			socket_mode_enabled: true,
			event_subscriptions: { bot_events: [
				"app_mention",
				"message.channels",
				"message.groups",
				"message.im",
				"message.mpim",
				"reaction_added",
				"reaction_removed",
				"member_joined_channel",
				"member_left_channel",
				"channel_rename",
				"pin_added",
				"pin_removed"
			] }
		}
	};
	return JSON.stringify(manifest, null, 2);
}
async function noteSlackTokenHelp(prompter, botName) {
	const manifest = buildSlackManifest(botName);
	await prompter.note([
		"1) Slack API → Create App → From scratch or From manifest (with the JSON below)",
		"2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
		"3) Install App to workspace to get the xoxb- bot token",
		"4) Enable Event Subscriptions (socket) for message events",
		"5) App Home → enable the Messages tab for DMs",
		"Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
		`Docs: ${formatDocsLink("/slack", "slack")}`,
		"",
		"Manifest (JSON):",
		manifest
	].join("\n"), "Slack socket mode tokens");
}
function setSlackChannelAllowlist(cfg, accountId, channelKeys) {
	return patchChannelConfigForAccount({
		cfg,
		channel: "slack",
		accountId,
		patch: { channels: Object.fromEntries(channelKeys.map((key) => [key, { allow: true }])) }
	});
}
async function promptSlackAllowFrom(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSlackAccountId(params.cfg)
	});
	const resolved = resolveSlackAccount({
		cfg: params.cfg,
		accountId
	});
	const token = resolved.userToken ?? resolved.botToken ?? "";
	const existing = params.cfg.channels?.slack?.allowFrom ?? params.cfg.channels?.slack?.dm?.allowFrom ?? [];
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@([A-Z0-9]+)>$/i,
		prefixPattern: /^(slack:|user:)/i,
		idPattern: /^[A-Z][A-Z0-9]+$/i,
		normalizeId: (id) => id.toUpperCase()
	});
	return promptLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: "slack",
		prompter: params.prompter,
		existing,
		token,
		noteTitle: "Slack allowlist",
		noteLines: [
			"Allowlist Slack DMs by username (we resolve to user ids).",
			"Examples:",
			"- U12345678",
			"- @alice",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/slack", "slack")}`
		],
		message: "Slack allowFrom (usernames or ids)",
		placeholder: "@alice, U12345678",
		parseId,
		invalidWithoutTokenNote: "Slack token missing; use user ids (or mention form) only.",
		resolveEntries: ({ token, entries }) => resolveSlackUserAllowlist({
			token,
			entries
		})
	});
}
const slackOnboardingAdapter = {
	channel: channel$3,
	getStatus: async ({ cfg }) => {
		const configured = listSlackAccountIds(cfg).some((accountId) => {
			return inspectSlackAccount({
				cfg,
				accountId
			}).configured;
		});
		return {
			channel: channel$3,
			configured,
			statusLines: [`Slack: ${configured ? "configured" : "needs tokens"}`],
			selectionHint: configured ? "configured" : "needs tokens",
			quickstartScore: configured ? 2 : 1
		};
	},
	configure: async ({ cfg, prompter, options, accountOverrides, shouldPromptAccountIds }) => {
		const defaultSlackAccountId = resolveDefaultSlackAccountId(cfg);
		const slackAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Slack",
			accountOverride: accountOverrides.slack,
			shouldPromptAccountIds,
			listAccountIds: listSlackAccountIds,
			defaultAccountId: defaultSlackAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveSlackAccount({
			cfg: next,
			accountId: slackAccountId
		});
		const hasConfiguredBotToken = hasConfiguredSecretInput(resolvedAccount.config.botToken);
		const hasConfiguredAppToken = hasConfiguredSecretInput(resolvedAccount.config.appToken);
		const hasConfigTokens = hasConfiguredBotToken && hasConfiguredAppToken;
		const accountConfigured = Boolean(resolvedAccount.botToken && resolvedAccount.appToken) || hasConfigTokens;
		const allowEnv = slackAccountId === DEFAULT_ACCOUNT_ID;
		let resolvedBotTokenForAllowlist = resolvedAccount.botToken;
		const slackBotName = String(await prompter.text({
			message: "Slack bot display name (used for manifest)",
			initialValue: "OpenClaw"
		})).trim();
		if (!accountConfigured) await noteSlackTokenHelp(prompter, slackBotName);
		const botTokenStep = await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "slack-bot",
			credentialLabel: "Slack bot token",
			secretInputMode: options?.secretInputMode,
			accountConfigured: Boolean(resolvedAccount.botToken) || hasConfiguredBotToken,
			hasConfigToken: hasConfiguredBotToken,
			allowEnv,
			envValue: process.env.SLACK_BOT_TOKEN,
			envPrompt: "SLACK_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Slack bot token already configured. Keep it?",
			inputPrompt: "Enter Slack bot token (xoxb-...)",
			preferredEnvVar: allowEnv ? "SLACK_BOT_TOKEN" : void 0,
			applySet: async (cfg, value) => patchChannelConfigForAccount({
				cfg,
				channel: "slack",
				accountId: slackAccountId,
				patch: { botToken: value }
			})
		});
		next = botTokenStep.cfg;
		if (botTokenStep.resolvedValue) resolvedBotTokenForAllowlist = botTokenStep.resolvedValue;
		next = (await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "slack-app",
			credentialLabel: "Slack app token",
			secretInputMode: options?.secretInputMode,
			accountConfigured: Boolean(resolvedAccount.appToken) || hasConfiguredAppToken,
			hasConfigToken: hasConfiguredAppToken,
			allowEnv,
			envValue: process.env.SLACK_APP_TOKEN,
			envPrompt: "SLACK_APP_TOKEN detected. Use env var?",
			keepPrompt: "Slack app token already configured. Keep it?",
			inputPrompt: "Enter Slack app token (xapp-...)",
			preferredEnvVar: allowEnv ? "SLACK_APP_TOKEN" : void 0,
			applySet: async (cfg, value) => patchChannelConfigForAccount({
				cfg,
				channel: "slack",
				accountId: slackAccountId,
				patch: { appToken: value }
			})
		})).cfg;
		next = await configureChannelAccessWithAllowlist({
			cfg: next,
			prompter,
			label: "Slack channels",
			currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
			currentEntries: Object.entries(resolvedAccount.config.channels ?? {}).filter(([, value]) => value?.allow !== false && value?.enabled !== false).map(([key]) => key),
			placeholder: "#general, #private, C123",
			updatePrompt: Boolean(resolvedAccount.config.channels),
			setPolicy: (cfg, policy) => setAccountGroupPolicyForChannel({
				cfg,
				channel: "slack",
				accountId: slackAccountId,
				groupPolicy: policy
			}),
			resolveAllowlist: async ({ cfg, entries }) => {
				let keys = entries;
				const activeBotToken = resolveSlackAccount({
					cfg,
					accountId: slackAccountId
				}).botToken || resolvedBotTokenForAllowlist || "";
				if (activeBotToken && entries.length > 0) try {
					const resolved = await resolveSlackChannelAllowlist({
						token: activeBotToken,
						entries
					});
					const resolvedKeys = resolved.filter((entry) => entry.resolved && entry.id).map((entry) => entry.id);
					const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
					keys = [...resolvedKeys, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
					await noteChannelLookupSummary({
						prompter,
						label: "Slack channels",
						resolvedSections: [{
							title: "Resolved",
							values: resolvedKeys
						}],
						unresolved
					});
				} catch (err) {
					await noteChannelLookupFailure({
						prompter,
						label: "Slack channels",
						error: err
					});
				}
				return keys;
			},
			applyAllowlist: ({ cfg, resolved }) => {
				return setSlackChannelAllowlist(cfg, slackAccountId, resolved);
			}
		});
		return {
			cfg: next,
			accountId: slackAccountId
		};
	},
	dmPolicy: {
		label: "Slack",
		channel: channel$3,
		policyKey: "channels.slack.dmPolicy",
		allowFromKey: "channels.slack.allowFrom",
		getCurrent: (cfg) => cfg.channels?.slack?.dmPolicy ?? cfg.channels?.slack?.dm?.policy ?? "pairing",
		setPolicy: (cfg, policy) => setLegacyChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "slack",
			dmPolicy: policy
		}),
		promptAllowFrom: promptSlackAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$3, false)
};
//#endregion
//#region src/channels/telegram/api.ts
async function fetchTelegramChatId(params) {
	const url = `https://api.telegram.org/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
	try {
		const res = await fetch(url, params.signal ? { signal: params.signal } : void 0);
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		const id = data?.ok ? data?.result?.id : void 0;
		if (typeof id === "number" || typeof id === "string") return String(id);
		return null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/channels/plugins/onboarding/telegram.ts
const channel$2 = "telegram";
async function noteTelegramTokenHelp(prompter) {
	await prompter.note([
		"1) Open Telegram and chat with @BotFather",
		"2) Run /newbot (or /mybots)",
		"3) Copy the token (looks like 123456:ABC...)",
		"Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
		`Docs: ${formatDocsLink("/telegram")}`,
		"Website: https://openclaw.ai"
	].join("\n"), "Telegram bot token");
}
async function noteTelegramUserIdHelp(prompter) {
	await prompter.note([
		`1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
		"2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
		"3) Third-party: DM @userinfobot or @getidsbot",
		`Docs: ${formatDocsLink("/telegram")}`,
		"Website: https://openclaw.ai"
	].join("\n"), "Telegram user id");
}
function normalizeTelegramAllowFromInput(raw) {
	return raw.trim().replace(/^(telegram|tg):/i, "").trim();
}
function parseTelegramAllowFromId(raw) {
	const stripped = normalizeTelegramAllowFromInput(raw);
	return /^\d+$/.test(stripped) ? stripped : null;
}
async function promptTelegramAllowFrom(params) {
	const { cfg, prompter, accountId } = params;
	const resolved = resolveTelegramAccount({
		cfg,
		accountId
	});
	const existingAllowFrom = resolved.config.allowFrom ?? [];
	await noteTelegramUserIdHelp(prompter);
	const token = params.tokenOverride?.trim() || resolved.token;
	if (!token) await prompter.note("Telegram token missing; username lookup is unavailable.", "Telegram");
	return patchChannelConfigForAccount({
		cfg,
		channel: "telegram",
		accountId,
		patch: {
			dmPolicy: "allowlist",
			allowFrom: await promptResolvedAllowFrom({
				prompter,
				existing: existingAllowFrom,
				token,
				message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
				placeholder: "@username",
				label: "Telegram allowlist",
				parseInputs: splitOnboardingEntries,
				parseId: parseTelegramAllowFromId,
				invalidWithoutTokenNote: "Telegram token missing; use numeric sender ids (usernames require a bot token).",
				resolveEntries: async ({ token: tokenValue, entries }) => {
					return await Promise.all(entries.map(async (entry) => {
						const numericId = parseTelegramAllowFromId(entry);
						if (numericId) return {
							input: entry,
							resolved: true,
							id: numericId
						};
						const stripped = normalizeTelegramAllowFromInput(entry);
						if (!stripped) return {
							input: entry,
							resolved: false,
							id: null
						};
						const id = await fetchTelegramChatId({
							token: tokenValue,
							chatId: stripped.startsWith("@") ? stripped : `@${stripped}`
						});
						return {
							input: entry,
							resolved: Boolean(id),
							id
						};
					}));
				}
			})
		}
	});
}
async function promptTelegramAllowFromForAccount(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultTelegramAccountId(params.cfg)
	});
	return promptTelegramAllowFrom({
		cfg: params.cfg,
		prompter: params.prompter,
		accountId
	});
}
const telegramOnboardingAdapter = {
	channel: channel$2,
	getStatus: async ({ cfg }) => {
		const configured = listTelegramAccountIds(cfg).some((accountId) => {
			return inspectTelegramAccount({
				cfg,
				accountId
			}).configured;
		});
		return {
			channel: channel$2,
			configured,
			statusLines: [`Telegram: ${configured ? "configured" : "needs token"}`],
			selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
			quickstartScore: configured ? 1 : 10
		};
	},
	configure: async ({ cfg, prompter, options, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
		const defaultTelegramAccountId = resolveDefaultTelegramAccountId(cfg);
		const telegramAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Telegram",
			accountOverride: accountOverrides.telegram,
			shouldPromptAccountIds,
			listAccountIds: listTelegramAccountIds,
			defaultAccountId: defaultTelegramAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveTelegramAccount({
			cfg: next,
			accountId: telegramAccountId
		});
		const hasConfigToken = hasConfiguredSecretInput(resolvedAccount.config.botToken) || Boolean(resolvedAccount.config.tokenFile?.trim());
		const allowEnv = telegramAccountId === DEFAULT_ACCOUNT_ID;
		const tokenStep = await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "telegram",
			credentialLabel: "Telegram bot token",
			secretInputMode: options?.secretInputMode,
			accountConfigured: Boolean(resolvedAccount.token) || hasConfigToken,
			hasConfigToken,
			allowEnv,
			envValue: process.env.TELEGRAM_BOT_TOKEN,
			envPrompt: "TELEGRAM_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Telegram token already configured. Keep it?",
			inputPrompt: "Enter Telegram bot token",
			preferredEnvVar: allowEnv ? "TELEGRAM_BOT_TOKEN" : void 0,
			onMissingConfigured: async () => await noteTelegramTokenHelp(prompter),
			applyUseEnv: async (cfg) => applySingleTokenPromptResult({
				cfg,
				channel: "telegram",
				accountId: telegramAccountId,
				tokenPatchKey: "botToken",
				tokenResult: {
					useEnv: true,
					token: null
				}
			}),
			applySet: async (cfg, value) => applySingleTokenPromptResult({
				cfg,
				channel: "telegram",
				accountId: telegramAccountId,
				tokenPatchKey: "botToken",
				tokenResult: {
					useEnv: false,
					token: value
				}
			})
		});
		next = tokenStep.cfg;
		if (forceAllowFrom) next = await promptTelegramAllowFrom({
			cfg: next,
			prompter,
			accountId: telegramAccountId,
			tokenOverride: tokenStep.resolvedValue
		});
		return {
			cfg: next,
			accountId: telegramAccountId
		};
	},
	dmPolicy: {
		label: "Telegram",
		channel: channel$2,
		policyKey: "channels.telegram.dmPolicy",
		allowFromKey: "channels.telegram.allowFrom",
		getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "telegram",
			dmPolicy: policy
		}),
		promptAllowFrom: promptTelegramAllowFromForAccount
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$2, false)
};
//#endregion
//#region src/channels/plugins/normalize/telegram.ts
const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;
function normalizeTelegramTargetBody(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, "").trim();
	if (!prefixStripped) return;
	const parsed = parseTelegramTarget(trimmed);
	const normalizedChatId = normalizeTelegramLookupTarget(parsed.chatId);
	if (!normalizedChatId) return;
	const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
	const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
	const chatSegment = keepLegacyGroupPrefix ? `group:${normalizedChatId}` : normalizedChatId;
	if (parsed.messageThreadId == null) return chatSegment;
	return `${chatSegment}${hasTopicSuffix ? `:topic:${parsed.messageThreadId}` : `:${parsed.messageThreadId}`}`;
}
function normalizeTelegramMessagingTarget(raw) {
	const normalizedBody = normalizeTelegramTargetBody(raw);
	if (!normalizedBody) return;
	return `telegram:${normalizedBody}`.toLowerCase();
}
function looksLikeTelegramTargetId(raw) {
	return normalizeTelegramTargetBody(raw) !== void 0;
}
//#endregion
//#region src/channels/plugins/status-issues/telegram.ts
function readTelegramAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		configured: value.configured,
		allowUnmentionedGroups: value.allowUnmentionedGroups,
		audit: value.audit
	};
}
function readTelegramGroupMembershipAuditSummary(value) {
	if (!isRecord(value)) return {};
	const unresolvedGroups = typeof value.unresolvedGroups === "number" && Number.isFinite(value.unresolvedGroups) ? value.unresolvedGroups : void 0;
	const hasWildcardUnmentionedGroups = typeof value.hasWildcardUnmentionedGroups === "boolean" ? value.hasWildcardUnmentionedGroups : void 0;
	const groupsRaw = value.groups;
	return {
		unresolvedGroups,
		hasWildcardUnmentionedGroups,
		groups: Array.isArray(groupsRaw) ? groupsRaw.map((entry) => {
			if (!isRecord(entry)) return null;
			const chatId = asString(entry.chatId);
			if (!chatId) return null;
			return {
				chatId,
				ok: typeof entry.ok === "boolean" ? entry.ok : void 0,
				status: asString(entry.status) ?? null,
				error: asString(entry.error) ?? null,
				matchKey: asString(entry.matchKey) ?? void 0,
				matchSource: asString(entry.matchSource) ?? void 0
			};
		}).filter(Boolean) : void 0
	};
}
function collectTelegramStatusIssues(accounts) {
	const issues = [];
	for (const entry of accounts) {
		const account = readTelegramAccountStatus(entry);
		if (!account) continue;
		const accountId = resolveEnabledConfiguredAccountId(account);
		if (!accountId) continue;
		if (account.allowUnmentionedGroups === true) issues.push({
			channel: "telegram",
			accountId,
			kind: "config",
			message: "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
			fix: "In BotFather run /setprivacy → Disable for this bot (then restart the gateway)."
		});
		const audit = readTelegramGroupMembershipAuditSummary(account.audit);
		if (audit.hasWildcardUnmentionedGroups === true) issues.push({
			channel: "telegram",
			accountId,
			kind: "config",
			message: "Telegram groups config uses \"*\" with requireMention=false; membership probing is not possible without explicit group IDs.",
			fix: "Add explicit numeric group ids under channels.telegram.groups (or per-account groups) to enable probing."
		});
		if (audit.unresolvedGroups && audit.unresolvedGroups > 0) issues.push({
			channel: "telegram",
			accountId,
			kind: "config",
			message: `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${audit.unresolvedGroups}). Membership probe can only check numeric group IDs.`,
			fix: "Use numeric chat IDs (e.g. -100...) as keys in channels.telegram.groups for requireMention=false groups."
		});
		for (const group of audit.groups ?? []) {
			if (group.ok === true) continue;
			const status = group.status ? ` status=${group.status}` : "";
			const err = group.error ? `: ${group.error}` : "";
			const baseMessage = `Group ${group.chatId} not reachable by bot.${status}${err}`;
			issues.push({
				channel: "telegram",
				accountId,
				kind: "runtime",
				message: appendMatchMetadata(baseMessage, {
					matchKey: group.matchKey,
					matchSource: group.matchSource
				}),
				fix: "Invite the bot to the group, then DM the bot once (/start) and restart the gateway."
			});
		}
	}
	return issues;
}
//#endregion
//#region src/infra/path-safety.ts
function resolveSafeBaseDir(rootDir) {
	const resolved = path.resolve(rootDir);
	return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}
//#endregion
//#region src/infra/archive-path.ts
function isWindowsDrivePath(value) {
	return /^[a-zA-Z]:[\\/]/.test(value);
}
function normalizeArchiveEntryPath(raw) {
	return raw.replaceAll("\\", "/");
}
function validateArchiveEntryPath(entryPath, params) {
	if (!entryPath || entryPath === "." || entryPath === "./") return;
	if (isWindowsDrivePath(entryPath)) throw new Error(`archive entry uses a drive path: ${entryPath}`);
	const normalized = path.posix.normalize(normalizeArchiveEntryPath(entryPath));
	const escapeLabel = params?.escapeLabel ?? "destination";
	if (normalized === ".." || normalized.startsWith("../")) throw new Error(`archive entry escapes ${escapeLabel}: ${entryPath}`);
	if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) throw new Error(`archive entry is absolute: ${entryPath}`);
}
function stripArchivePath(entryPath, stripComponents) {
	const raw = normalizeArchiveEntryPath(entryPath);
	if (!raw || raw === "." || raw === "./") return null;
	const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
	const strip = Math.max(0, Math.floor(stripComponents));
	const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
	const result = path.posix.normalize(stripped);
	if (!result || result === "." || result === "./") return null;
	return result;
}
function resolveArchiveOutputPath(params) {
	const safeBase = resolveSafeBaseDir(params.rootDir);
	const outPath = path.resolve(params.rootDir, params.relPath);
	const escapeLabel = params.escapeLabel ?? "destination";
	if (!outPath.startsWith(safeBase)) throw new Error(`archive entry escapes ${escapeLabel}: ${params.originalPath}`);
	return outPath;
}
//#endregion
//#region src/infra/archive-staging.ts
const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
var ArchiveSecurityError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "ArchiveSecurityError";
	}
};
function symlinkTraversalError$1(originalPath) {
	return new ArchiveSecurityError("destination-symlink-traversal", `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`);
}
async function prepareArchiveDestinationDir(destDir) {
	const stat = await fs$1.lstat(destDir);
	if (stat.isSymbolicLink()) throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
	if (!stat.isDirectory()) throw new ArchiveSecurityError("destination-not-directory", "archive destination is not a directory");
	return await fs$1.realpath(destDir);
}
async function assertNoSymlinkTraversal(params) {
	const parts = params.relPath.split(/[\\/]+/).filter(Boolean);
	let current = path.resolve(params.rootDir);
	for (const part of parts) {
		current = path.join(current, part);
		let stat;
		try {
			stat = await fs$1.lstat(current);
		} catch (err) {
			if (isNotFoundPathError(err)) continue;
			throw err;
		}
		if (stat.isSymbolicLink()) throw symlinkTraversalError$1(params.originalPath);
	}
}
async function assertResolvedInsideDestination(params) {
	let resolved;
	try {
		resolved = await fs$1.realpath(params.targetPath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (!isPathInside(params.destinationRealDir, resolved)) throw symlinkTraversalError$1(params.originalPath);
}
async function prepareArchiveOutputPath(params) {
	await assertNoSymlinkTraversal({
		rootDir: params.destinationDir,
		relPath: params.relPath,
		originalPath: params.originalPath
	});
	if (params.isDirectory) {
		await fs$1.mkdir(params.outPath, { recursive: true });
		await assertResolvedInsideDestination({
			destinationRealDir: params.destinationRealDir,
			targetPath: params.outPath,
			originalPath: params.originalPath
		});
		return;
	}
	const parentDir = path.dirname(params.outPath);
	await fs$1.mkdir(parentDir, { recursive: true });
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: parentDir,
		originalPath: params.originalPath
	});
}
async function applyStagedEntryMode(params) {
	const destinationPath = path.join(params.destinationRealDir, params.relPath);
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: destinationPath,
		originalPath: params.originalPath
	});
	if (params.mode !== 0) await fs$1.chmod(destinationPath, params.mode).catch(() => void 0);
}
async function withStagedArchiveDestination(params) {
	const stagingDir = await fs$1.mkdtemp(path.join(params.destinationRealDir, ".openclaw-archive-"));
	try {
		return await params.run(stagingDir);
	} finally {
		await fs$1.rm(stagingDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function mergeExtractedTreeIntoDestination(params) {
	const walk = async (currentSourceDir) => {
		const entries = await fs$1.readdir(currentSourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const sourcePath = path.join(currentSourceDir, entry.name);
			const relPath = path.relative(params.sourceDir, sourcePath);
			const originalPath = relPath.split(path.sep).join("/");
			const destinationPath = path.join(params.destinationDir, relPath);
			const sourceStat = await fs$1.lstat(sourcePath);
			if (sourceStat.isSymbolicLink()) throw symlinkTraversalError$1(originalPath);
			if (sourceStat.isDirectory()) {
				await prepareArchiveOutputPath({
					destinationDir: params.destinationDir,
					destinationRealDir: params.destinationRealDir,
					relPath,
					outPath: destinationPath,
					originalPath,
					isDirectory: true
				});
				await walk(sourcePath);
				await applyStagedEntryMode({
					destinationRealDir: params.destinationRealDir,
					relPath,
					mode: sourceStat.mode & 511,
					originalPath
				});
				continue;
			}
			if (!sourceStat.isFile()) throw new Error(`archive staging contains unsupported entry: ${originalPath}`);
			await prepareArchiveOutputPath({
				destinationDir: params.destinationDir,
				destinationRealDir: params.destinationRealDir,
				relPath,
				outPath: destinationPath,
				originalPath,
				isDirectory: false
			});
			await copyFileWithinRoot({
				sourcePath,
				rootDir: params.destinationRealDir,
				relativePath: relPath,
				mkdir: true
			});
			await applyStagedEntryMode({
				destinationRealDir: params.destinationRealDir,
				relPath,
				mode: sourceStat.mode & 511,
				originalPath
			});
		}
	};
	await walk(params.sourceDir);
}
function createArchiveSymlinkTraversalError(originalPath) {
	return symlinkTraversalError$1(originalPath);
}
const ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT = "archive size exceeds limit";
const ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT = "archive entry count exceeds limit";
const ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT = "archive entry extracted size exceeds limit";
const ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT = "archive extracted size exceeds limit";
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const TAR_SUFFIXES = [
	".tgz",
	".tar.gz",
	".tar"
];
function resolveArchiveKind(filePath) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".zip")) return "zip";
	if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "tar";
	return null;
}
async function withTimeout(promise, timeoutMs, label) {
	let timeoutId;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timeoutId = setTimeout(() => reject(/* @__PURE__ */ new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		})]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
function clampLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const v = Math.floor(value);
	return v > 0 ? v : void 0;
}
function resolveExtractLimits(limits) {
	return {
		maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? 268435456,
		maxEntries: clampLimit(limits?.maxEntries) ?? 5e4,
		maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? 536870912,
		maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? 268435456
	};
}
function assertArchiveEntryCountWithinLimit(entryCount, limits) {
	if (entryCount > limits.maxEntries) throw new Error(ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT);
}
function createByteBudgetTracker(limits) {
	let entryBytes = 0;
	let extractedBytes = 0;
	const addBytes = (bytes) => {
		const b = Math.max(0, Math.floor(bytes));
		if (b === 0) return;
		entryBytes += b;
		if (entryBytes > limits.maxEntryBytes) throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
		extractedBytes += b;
		if (extractedBytes > limits.maxExtractedBytes) throw new Error(ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT);
	};
	return {
		startEntry() {
			entryBytes = 0;
		},
		addBytes,
		addEntrySize(size) {
			const s = Math.max(0, Math.floor(size));
			if (s > limits.maxEntryBytes) throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
			addBytes(s);
		}
	};
}
function createExtractBudgetTransform(params) {
	return new Transform({ transform(chunk, _encoding, callback) {
		try {
			const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
			params.onChunkBytes(buf.byteLength);
			callback(null, buf);
		} catch (err) {
			callback(err instanceof Error ? err : new Error(String(err)));
		}
	} });
}
function symlinkTraversalError(originalPath) {
	return createArchiveSymlinkTraversalError(originalPath);
}
async function openZipOutputFile(params) {
	try {
		return await openWritableFileWithinRoot({
			rootDir: params.destinationRealDir,
			relativePath: params.relPath,
			mkdir: false,
			mode: 438
		});
	} catch (err) {
		if (err instanceof SafeOpenError && (err.code === "invalid-path" || err.code === "outside-workspace" || err.code === "path-mismatch")) throw symlinkTraversalError(params.originalPath);
		throw err;
	}
}
async function cleanupPartialRegularFile(filePath) {
	let stat;
	try {
		stat = await fs$1.lstat(filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (stat.isFile()) await fs$1.unlink(filePath).catch(() => void 0);
}
function buildArchiveAtomicTempPath(targetPath) {
	return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
}
async function verifyZipWriteResult(params) {
	const opened = await openFileWithinRoot({
		rootDir: params.destinationRealDir,
		relativePath: params.relPath,
		rejectHardlinks: true
	});
	try {
		if (!sameFileIdentity(opened.stat, params.expectedStat)) throw new SafeOpenError("path-mismatch", "path changed during zip extract");
		return opened.realPath;
	} finally {
		await opened.handle.close().catch(() => void 0);
	}
}
async function readZipEntryStream(entry) {
	if (typeof entry.nodeStream === "function") return entry.nodeStream();
	const buf = await entry.async("nodebuffer");
	return Readable.from(buf);
}
function resolveZipOutputPath(params) {
	validateArchiveEntryPath(params.entryPath);
	const relPath = stripArchivePath(params.entryPath, params.strip);
	if (!relPath) return null;
	validateArchiveEntryPath(relPath);
	return {
		relPath,
		outPath: resolveArchiveOutputPath({
			rootDir: params.destinationDir,
			relPath,
			originalPath: params.entryPath
		})
	};
}
async function prepareZipOutputPath(params) {
	await prepareArchiveOutputPath(params);
}
async function writeZipFileEntry(params) {
	const opened = await openZipOutputFile({
		relPath: params.relPath,
		originalPath: params.entry.name,
		destinationRealDir: params.destinationRealDir
	});
	params.budget.startEntry();
	const readable = await readZipEntryStream(params.entry);
	const destinationPath = opened.openedRealPath;
	const targetMode = opened.openedStat.mode & 511;
	await opened.handle.close().catch(() => void 0);
	let tempHandle = null;
	let tempPath = null;
	let tempStat = null;
	let handleClosedByStream = false;
	try {
		tempPath = buildArchiveAtomicTempPath(destinationPath);
		tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 438);
		const writable = tempHandle.createWriteStream();
		writable.once("close", () => {
			handleClosedByStream = true;
		});
		await pipeline(readable, createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }), writable);
		tempStat = await fs$1.stat(tempPath);
		if (!tempStat) throw new Error("zip temp write did not produce file metadata");
		if (!handleClosedByStream) {
			await tempHandle.close().catch(() => void 0);
			handleClosedByStream = true;
		}
		tempHandle = null;
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		const verifiedPath = await verifyZipWriteResult({
			destinationRealDir: params.destinationRealDir,
			relPath: params.relPath,
			expectedStat: tempStat
		});
		if (typeof params.entry.unixPermissions === "number") {
			const mode = params.entry.unixPermissions & 511;
			if (mode !== 0) await fs$1.chmod(verifiedPath, mode).catch(() => void 0);
		}
	} catch (err) {
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => void 0);
		else await cleanupPartialRegularFile(destinationPath).catch(() => void 0);
		if (err instanceof SafeOpenError) throw symlinkTraversalError(params.entry.name);
		throw err;
	} finally {
		if (tempHandle && !handleClosedByStream) await tempHandle.close().catch(() => void 0);
	}
}
async function extractZip(params) {
	const limits = resolveExtractLimits(params.limits);
	const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
	if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
	const buffer = await fs$1.readFile(params.archivePath);
	const zip = await JSZip.loadAsync(buffer);
	const entries = Object.values(zip.files);
	const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
	assertArchiveEntryCountWithinLimit(entries.length, limits);
	const budget = createByteBudgetTracker(limits);
	for (const entry of entries) {
		const output = resolveZipOutputPath({
			entryPath: entry.name,
			strip,
			destinationDir: params.destDir
		});
		if (!output) continue;
		await prepareZipOutputPath({
			destinationDir: params.destDir,
			destinationRealDir,
			relPath: output.relPath,
			outPath: output.outPath,
			originalPath: entry.name,
			isDirectory: entry.dir
		});
		if (entry.dir) continue;
		await writeZipFileEntry({
			entry,
			relPath: output.relPath,
			destinationRealDir,
			budget
		});
	}
}
const BLOCKED_TAR_ENTRY_TYPES = new Set([
	"SymbolicLink",
	"Link",
	"BlockDevice",
	"CharacterDevice",
	"FIFO",
	"Socket"
]);
function readTarEntryInfo(entry) {
	return {
		path: typeof entry === "object" && entry !== null && "path" in entry ? String(entry.path) : "",
		type: typeof entry === "object" && entry !== null && "type" in entry ? String(entry.type) : "",
		size: typeof entry === "object" && entry !== null && "size" in entry && typeof entry.size === "number" && Number.isFinite(entry.size) ? Math.max(0, Math.floor(entry.size)) : 0
	};
}
function createTarEntryPreflightChecker(params) {
	const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
	const limits = resolveExtractLimits(params.limits);
	let entryCount = 0;
	const budget = createByteBudgetTracker(limits);
	return (entry) => {
		validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
		const relPath = stripArchivePath(entry.path, strip);
		if (!relPath) return;
		validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
		resolveArchiveOutputPath({
			rootDir: params.rootDir,
			relPath,
			originalPath: entry.path,
			escapeLabel: params.escapeLabel
		});
		if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) throw new Error(`tar entry is a link: ${entry.path}`);
		entryCount += 1;
		assertArchiveEntryCountWithinLimit(entryCount, limits);
		budget.addEntrySize(entry.size);
	};
}
async function extractArchive(params) {
	const kind = params.kind ?? resolveArchiveKind(params.archivePath);
	if (!kind) throw new Error(`unsupported archive: ${params.archivePath}`);
	const label = kind === "zip" ? "extract zip" : "extract tar";
	if (kind === "tar") {
		await withTimeout((async () => {
			const limits = resolveExtractLimits(params.limits);
			if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
			const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
			await withStagedArchiveDestination({
				destinationRealDir,
				run: async (stagingDir) => {
					const checkTarEntrySafety = createTarEntryPreflightChecker({
						rootDir: destinationRealDir,
						stripComponents: params.stripComponents,
						limits
					});
					await tar.x({
						file: params.archivePath,
						cwd: stagingDir,
						strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
						gzip: params.tarGzip,
						preservePaths: false,
						strict: true,
						onReadEntry(entry) {
							try {
								checkTarEntrySafety(readTarEntryInfo(entry));
							} catch (err) {
								const error = err instanceof Error ? err : new Error(String(err));
								this.abort?.(error);
							}
						}
					});
					await mergeExtractedTreeIntoDestination({
						sourceDir: stagingDir,
						destinationDir: destinationRealDir,
						destinationRealDir
					});
				}
			});
		})(), params.timeoutMs, label);
		return;
	}
	await withTimeout(extractZip({
		archivePath: params.archivePath,
		destDir: params.destDir,
		stripComponents: params.stripComponents,
		limits: params.limits
	}), params.timeoutMs, label);
}
//#endregion
//#region src/infra/brew.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function normalizePathValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function resolveBrewExecutable(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const env = opts?.env ?? process.env;
	const candidates = [];
	const brewFile = normalizePathValue(env.HOMEBREW_BREW_FILE);
	if (brewFile) candidates.push(brewFile);
	const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
	if (prefix) candidates.push(path.join(prefix, "bin", "brew"));
	candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
	candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");
	candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");
	for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
}
//#endregion
//#region src/commands/signal-install.ts
/** @internal Exported for testing. */
async function extractSignalCliArchive(archivePath, installRoot, timeoutMs) {
	await extractArchive({
		archivePath,
		destDir: installRoot,
		timeoutMs
	});
}
/** @internal Exported for testing. */
function looksLikeArchive(name) {
	return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}
/**
* Pick a native release asset from the official GitHub releases.
*
* The official signal-cli releases only publish native (GraalVM) binaries for
* x86-64 Linux.  On architectures where no native asset is available this
* returns `undefined` so the caller can fall back to a different install
* strategy (e.g. Homebrew).
*/
/** @internal Exported for testing. */
function pickAsset(assets, platform, arch) {
	const archives = assets.filter((asset) => Boolean(asset.name && asset.browser_download_url)).filter((a) => looksLikeArchive(a.name.toLowerCase()));
	const byName = (pattern) => archives.find((asset) => pattern.test(asset.name.toLowerCase()));
	if (platform === "linux") {
		if (arch === "x64") return byName(/linux-native/) || byName(/linux/) || archives[0];
		return;
	}
	if (platform === "darwin") return byName(/macos|osx|darwin/) || archives[0];
	if (platform === "win32") return byName(/windows|win/) || archives[0];
	return archives[0];
}
async function downloadToFile(url, dest, maxRedirects = 5) {
	await new Promise((resolve, reject) => {
		const req = request(url, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
				const location = res.headers.location;
				if (!location || maxRedirects <= 0) {
					reject(/* @__PURE__ */ new Error("Redirect loop or missing Location header"));
					return;
				}
				const redirectUrl = new URL(location, url).href;
				resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
				return;
			}
			if (!res.statusCode || res.statusCode >= 400) {
				reject(/* @__PURE__ */ new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
				return;
			}
			pipeline(res, createWriteStream(dest)).then(resolve).catch(reject);
		});
		req.on("error", reject);
		req.end();
	});
}
async function findSignalCliBinary(root) {
	const candidates = [];
	const enqueue = async (dir, depth) => {
		if (depth > 3) return;
		const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await enqueue(full, depth + 1);
			else if (entry.isFile() && entry.name === "signal-cli") candidates.push(full);
		}
	};
	await enqueue(root, 0);
	return candidates[0] ?? null;
}
async function resolveBrewSignalCliPath(brewExe) {
	try {
		const result = await runCommandWithTimeout([
			brewExe,
			"--prefix",
			"signal-cli"
		], { timeoutMs: 1e4 });
		if (result.code === 0 && result.stdout.trim()) {
			const prefix = result.stdout.trim();
			const candidate = path.join(prefix, "bin", "signal-cli");
			try {
				await fs$1.access(candidate);
				return candidate;
			} catch {
				return findSignalCliBinary(prefix);
			}
		}
	} catch {}
	return null;
}
async function installSignalCliViaBrew(runtime) {
	const brewExe = resolveBrewExecutable();
	if (!brewExe) return {
		ok: false,
		error: `No native signal-cli build is available for ${process.arch}. Install Homebrew (https://brew.sh) and try again, or install signal-cli manually.`
	};
	runtime.log(`Installing signal-cli via Homebrew (${brewExe})…`);
	const result = await runCommandWithTimeout([
		brewExe,
		"install",
		"signal-cli"
	], { timeoutMs: 15 * 6e4 });
	if (result.code !== 0) return {
		ok: false,
		error: `brew install signal-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`
	};
	const cliPath = await resolveBrewSignalCliPath(brewExe);
	if (!cliPath) return {
		ok: false,
		error: "brew install succeeded but signal-cli binary was not found."
	};
	let version;
	try {
		version = (await runCommandWithTimeout([cliPath, "--version"], { timeoutMs: 1e4 })).stdout.trim().replace(/^signal-cli\s+/, "") || void 0;
	} catch {}
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCliFromRelease(runtime) {
	const response = await fetch("https://api.github.com/repos/AsamK/signal-cli/releases/latest", { headers: {
		"User-Agent": "openclaw",
		Accept: "application/vnd.github+json"
	} });
	if (!response.ok) return {
		ok: false,
		error: `Failed to fetch release info (${response.status})`
	};
	const payload = await response.json();
	const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
	const asset = pickAsset(payload.assets ?? [], process.platform, process.arch);
	if (!asset) return {
		ok: false,
		error: "No compatible release asset found for this platform."
	};
	const tmpDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-"));
	const archivePath = path.join(tmpDir, asset.name);
	runtime.log(`Downloading signal-cli ${version} (${asset.name})…`);
	await downloadToFile(asset.browser_download_url, archivePath);
	const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
	await fs$1.mkdir(installRoot, { recursive: true });
	if (!looksLikeArchive(asset.name.toLowerCase())) return {
		ok: false,
		error: `Unsupported archive type: ${asset.name}`
	};
	try {
		await extractSignalCliArchive(archivePath, installRoot, 6e4);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Failed to extract ${asset.name}: ${message}`
		};
	}
	const cliPath = await findSignalCliBinary(installRoot);
	if (!cliPath) return {
		ok: false,
		error: `signal-cli binary not found after extracting ${asset.name}`
	};
	await fs$1.chmod(cliPath, 493).catch(() => {});
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCli(runtime) {
	if (process.platform === "win32") return {
		ok: false,
		error: "Signal CLI auto-install is not supported on Windows yet."
	};
	if (process.platform !== "linux" || process.arch === "x64") return installSignalCliFromRelease(runtime);
	return installSignalCliViaBrew(runtime);
}
//#endregion
//#region src/channels/plugins/onboarding/signal.ts
const channel$1 = "signal";
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR = "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
function normalizeSignalAccountInput(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const digits = normalizeE164(trimmed).slice(1);
	if (!DIGITS_ONLY.test(digits)) return null;
	if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
	return `+${digits}`;
}
function isUuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function parseSignalAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		if (entry.toLowerCase().startsWith("uuid:")) {
			const id = entry.slice(5).trim();
			if (!id) return { error: "Invalid uuid entry" };
			return { value: `uuid:${id}` };
		}
		if (isUuidLike(entry)) return { value: `uuid:${entry}` };
		const normalized = normalizeSignalAccountInput(entry);
		if (!normalized) return { error: `Invalid entry: ${entry}` };
		return { value: normalized };
	});
}
async function promptSignalAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "signal",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "Signal allowlist",
		noteLines: [
			"Allowlist Signal DMs by sender id.",
			"Examples:",
			"- +15555550123",
			"- uuid:123e4567-e89b-12d3-a456-426614174000",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/signal", "signal")}`
		],
		message: "Signal allowFrom (E.164 or uuid)",
		placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
		parseEntries: parseSignalAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveSignalAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const signalOnboardingAdapter = {
	channel: channel$1,
	getStatus: async ({ cfg }) => {
		const configured = listSignalAccountIds(cfg).some((accountId) => resolveSignalAccount({
			cfg,
			accountId
		}).configured);
		const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
		const signalCliDetected = await detectBinary(signalCliPath);
		return {
			channel: channel$1,
			configured,
			statusLines: [`Signal: ${configured ? "configured" : "needs setup"}`, `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`],
			selectionHint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
			quickstartScore: signalCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, runtime, prompter, accountOverrides, shouldPromptAccountIds, options }) => {
		const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
		const signalAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Signal",
			accountOverride: accountOverrides.signal,
			shouldPromptAccountIds,
			listAccountIds: listSignalAccountIds,
			defaultAccountId: defaultSignalAccountId
		});
		let next = cfg;
		const accountConfig = resolveSignalAccount({
			cfg: next,
			accountId: signalAccountId
		}).config;
		let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
		let cliDetected = await detectBinary(resolvedCliPath);
		if (options?.allowSignalInstall) {
			if (await prompter.confirm({
				message: cliDetected ? "signal-cli detected. Reinstall/update now?" : "signal-cli not found. Install now?",
				initialValue: !cliDetected
			})) try {
				const result = await installSignalCli(runtime);
				if (result.ok && result.cliPath) {
					cliDetected = true;
					resolvedCliPath = result.cliPath;
					await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
				} else if (!result.ok) await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
			} catch (err) {
				await prompter.note(`signal-cli install failed: ${String(err)}`, "Signal");
			}
		}
		if (!cliDetected) await prompter.note("signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.", "Signal");
		let account = accountConfig.account ?? "";
		if (account) {
			const normalizedExisting = normalizeSignalAccountInput(account);
			if (!normalizedExisting) {
				await prompter.note("Existing Signal account isn't a valid E.164 number. Please enter it again.", "Signal");
				account = "";
			} else {
				account = normalizedExisting;
				if (!await prompter.confirm({
					message: `Signal account set (${account}). Keep it?`,
					initialValue: true
				})) account = "";
			}
		}
		if (!account) account = normalizeSignalAccountInput(String(await prompter.text({
			message: "Signal bot number (E.164)",
			validate: (value) => normalizeSignalAccountInput(String(value ?? "")) ? void 0 : INVALID_SIGNAL_ACCOUNT_ERROR
		}))) ?? "";
		if (account) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "signal",
			accountId: signalAccountId,
			patch: {
				account,
				cliPath: resolvedCliPath ?? "signal-cli"
			}
		});
		await prompter.note([
			"Link device with: signal-cli link -n \"OpenClaw\"",
			"Scan QR in Signal → Linked Devices",
			`Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
			`Docs: ${formatDocsLink("/signal", "signal")}`
		].join("\n"), "Signal next steps");
		return {
			cfg: next,
			accountId: signalAccountId
		};
	},
	dmPolicy: {
		label: "Signal",
		channel: channel$1,
		policyKey: "channels.signal.dmPolicy",
		allowFromKey: "channels.signal.allowFrom",
		getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "signal",
			dmPolicy: policy
		}),
		promptAllowFrom: promptSignalAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$1, false)
};
//#endregion
//#region src/config/merge-config.ts
function mergeConfigSection(base, patch, options = {}) {
	const next = { ...base ?? void 0 };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) {
			if (options.unsetOnUndefined?.includes(key)) delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}
function mergeWhatsAppConfig(cfg, patch, options) {
	return {
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options)
		}
	};
}
//#endregion
//#region src/channels/plugins/onboarding/whatsapp.ts
const channel = "whatsapp";
function setWhatsAppDmPolicy(cfg, dmPolicy) {
	return mergeWhatsAppConfig(cfg, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, allowFrom) {
	return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, selfChatMode) {
	return mergeWhatsAppConfig(cfg, { selfChatMode });
}
async function detectWhatsAppLinked(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await pathExists(path.join(authDir, "creds.json"));
}
async function promptWhatsAppOwnerAllowFrom(params) {
	const { prompter, existingAllowFrom } = params;
	await prompter.note("We need the sender/owner number so OpenClaw can allowlist you.", "WhatsApp number");
	const entry = await prompter.text({
		message: "Your personal WhatsApp number (the phone you will message from)",
		placeholder: "+15555550123",
		initialValue: existingAllowFrom[0],
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			if (!normalizeE164(raw)) return `Invalid number: ${raw}`;
		}
	});
	const normalized = normalizeE164(String(entry).trim());
	if (!normalized) throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
	return {
		normalized,
		allowFrom: normalizeAllowFromEntries([...existingAllowFrom.filter((item) => item !== "*"), normalized], normalizeE164)
	};
}
async function applyWhatsAppOwnerAllowlist(params) {
	const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
		prompter: params.prompter,
		existingAllowFrom: params.existingAllowFrom
	});
	let next = setWhatsAppSelfChatMode(params.cfg, true);
	next = setWhatsAppDmPolicy(next, "allowlist");
	next = setWhatsAppAllowFrom(next, allowFrom);
	await params.prompter.note([...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"), params.title);
	return next;
}
function parseWhatsAppAllowFromEntries(raw) {
	const parts = splitOnboardingEntries(raw);
	if (parts.length === 0) return { entries: [] };
	const entries = [];
	for (const part of parts) {
		if (part === "*") {
			entries.push("*");
			continue;
		}
		const normalized = normalizeE164(part);
		if (!normalized) return {
			entries: [],
			invalidEntry: part
		};
		entries.push(normalized);
	}
	return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}
async function promptWhatsAppAllowFrom(cfg, _runtime, prompter, options) {
	const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
	const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	if (options?.forceAllowlist) return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp allowlist",
		messageLines: ["Allowlist mode enabled."]
	});
	await prompter.note([
		"WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
		"- pairing (default): unknown senders get a pairing code; owner approves",
		"- allowlist: unknown senders are blocked",
		"- open: public inbound DMs (requires allowFrom to include \"*\")",
		"- disabled: ignore WhatsApp DMs",
		"",
		`Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
		`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
	].join("\n"), "WhatsApp DM access");
	if (await prompter.select({
		message: "WhatsApp phone setup",
		options: [{
			value: "personal",
			label: "This is my personal phone number"
		}, {
			value: "separate",
			label: "Separate phone just for OpenClaw"
		}]
	}) === "personal") return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp personal phone",
		messageLines: ["Personal phone mode enabled.", "- dmPolicy set to allowlist (pairing skipped)"]
	});
	const policy = await prompter.select({
		message: "WhatsApp DM policy",
		options: [
			{
				value: "pairing",
				label: "Pairing (recommended)"
			},
			{
				value: "allowlist",
				label: "Allowlist only (block unknown senders)"
			},
			{
				value: "open",
				label: "Open (public inbound DMs)"
			},
			{
				value: "disabled",
				label: "Disabled (ignore WhatsApp DMs)"
			}
		]
	});
	let next = setWhatsAppSelfChatMode(cfg, false);
	next = setWhatsAppDmPolicy(next, policy);
	if (policy === "open") {
		const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
		next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
		return next;
	}
	if (policy === "disabled") return next;
	const allowOptions = existingAllowFrom.length > 0 ? [
		{
			value: "keep",
			label: "Keep current allowFrom"
		},
		{
			value: "unset",
			label: "Unset allowFrom (use pairing approvals only)"
		},
		{
			value: "list",
			label: "Set allowFrom to specific numbers"
		}
	] : [{
		value: "unset",
		label: "Unset allowFrom (default)"
	}, {
		value: "list",
		label: "Set allowFrom to specific numbers"
	}];
	const mode = await prompter.select({
		message: "WhatsApp allowFrom (optional pre-allowlist)",
		options: allowOptions.map((opt) => ({
			value: opt.value,
			label: opt.label
		}))
	});
	if (mode === "keep") {} else if (mode === "unset") next = setWhatsAppAllowFrom(next, void 0);
	else {
		const allowRaw = await prompter.text({
			message: "Allowed sender numbers (comma-separated, E.164)",
			placeholder: "+15555550123, +447700900123",
			validate: (value) => {
				const raw = String(value ?? "").trim();
				if (!raw) return "Required";
				const parsed = parseWhatsAppAllowFromEntries(raw);
				if (parsed.entries.length === 0 && !parsed.invalidEntry) return "Required";
				if (parsed.invalidEntry) return `Invalid number: ${parsed.invalidEntry}`;
			}
		});
		const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
		next = setWhatsAppAllowFrom(next, parsed.entries);
	}
	return next;
}
const whatsappOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg, accountOverrides }) => {
		const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
		const accountId = resolveOnboardingAccountId({
			accountId: accountOverrides.whatsapp,
			defaultAccountId
		});
		const linked = await detectWhatsAppLinked(cfg, accountId);
		return {
			channel,
			configured: linked,
			statusLines: [`WhatsApp (${accountId === "default" ? "default" : accountId}): ${linked ? "linked" : "not linked"}`],
			selectionHint: linked ? "linked" : "not linked",
			quickstartScore: linked ? 5 : 4
		};
	},
	configure: async ({ cfg, runtime, prompter, options, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
		const accountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "WhatsApp",
			accountOverride: accountOverrides.whatsapp,
			shouldPromptAccountIds: Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
			listAccountIds: listWhatsAppAccountIds,
			defaultAccountId: resolveDefaultWhatsAppAccountId(cfg)
		});
		let next = cfg;
		if (accountId !== "default") next = {
			...next,
			channels: {
				...next.channels,
				whatsapp: {
					...next.channels?.whatsapp,
					accounts: {
						...next.channels?.whatsapp?.accounts,
						[accountId]: {
							...next.channels?.whatsapp?.accounts?.[accountId],
							enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true
						}
					}
				}
			}
		};
		const linked = await detectWhatsAppLinked(next, accountId);
		const { authDir } = resolveWhatsAppAuthDir({
			cfg: next,
			accountId
		});
		if (!linked) await prompter.note([
			"Scan the QR with WhatsApp on your phone.",
			`Credentials are stored under ${authDir}/ for future runs.`,
			`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
		].join("\n"), "WhatsApp linking");
		if (await prompter.confirm({
			message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
			initialValue: !linked
		})) try {
			await loginWeb(false, void 0, runtime, accountId);
		} catch (err) {
			runtime.error(`WhatsApp login failed: ${String(err)}`);
			await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
		}
		else if (!linked) await prompter.note(`Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`, "WhatsApp");
		next = await promptWhatsAppAllowFrom(next, runtime, prompter, { forceAllowlist: forceAllowFrom });
		return {
			cfg: next,
			accountId
		};
	},
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};
//#endregion
//#region src/channels/plugins/status-issues/whatsapp.ts
function readWhatsAppAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		linked: value.linked,
		connected: value.connected,
		running: value.running,
		reconnectAttempts: value.reconnectAttempts,
		lastError: value.lastError
	};
}
function collectWhatsAppStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readWhatsAppAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const linked = account.linked === true;
			const running = account.running === true;
			const connected = account.connected === true;
			const reconnectAttempts = typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
			const lastError = asString(account.lastError);
			if (!linked) {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: "Not linked (no WhatsApp Web session).",
					fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`
				});
				return;
			}
			if (running && !connected) issues.push({
				channel: "whatsapp",
				accountId,
				kind: "runtime",
				message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
				fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
			});
		}
	});
}
//#endregion
//#region src/channels/plugins/status-issues/bluebubbles.ts
function readBlueBubblesAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		configured: value.configured,
		running: value.running,
		baseUrl: value.baseUrl,
		lastError: value.lastError,
		probe: value.probe
	};
}
function readBlueBubblesProbeResult(value) {
	if (!isRecord(value)) return null;
	return {
		ok: typeof value.ok === "boolean" ? value.ok : void 0,
		status: typeof value.status === "number" ? value.status : null,
		error: asString(value.error) ?? null
	};
}
function collectBlueBubblesStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readBlueBubblesAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const configured = account.configured === true;
			const running = account.running === true;
			const lastError = asString(account.lastError);
			const probe = readBlueBubblesProbeResult(account.probe);
			if (!configured) {
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "config",
					message: "Not configured (missing serverUrl or password).",
					fix: "Run: openclaw channels add bluebubbles --http-url <server-url> --password <password>"
				});
				return;
			}
			if (probe && probe.ok === false) {
				const errorDetail = probe.error ? `: ${probe.error}` : probe.status ? ` (HTTP ${probe.status})` : "";
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "runtime",
					message: `BlueBubbles server unreachable${errorDetail}`,
					fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config."
				});
			}
			if (running && lastError) issues.push({
				channel: "bluebubbles",
				accountId,
				kind: "runtime",
				message: `Channel error: ${lastError}`,
				fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings."
			});
		}
	});
}
//#endregion
//#region src/line/config-schema.ts
const DmPolicySchema$1 = z.enum([
	"open",
	"allowlist",
	"pairing",
	"disabled"
]);
const GroupPolicySchema$1 = z.enum([
	"open",
	"allowlist",
	"disabled"
]);
const LineCommonConfigSchema = z.object({
	enabled: z.boolean().optional(),
	channelAccessToken: z.string().optional(),
	channelSecret: z.string().optional(),
	tokenFile: z.string().optional(),
	secretFile: z.string().optional(),
	name: z.string().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	dmPolicy: DmPolicySchema$1.optional().default("pairing"),
	groupPolicy: GroupPolicySchema$1.optional().default("allowlist"),
	responsePrefix: z.string().optional(),
	mediaMaxMb: z.number().optional(),
	webhookPath: z.string().optional()
});
const LineGroupConfigSchema = z.object({
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	requireMention: z.boolean().optional(),
	systemPrompt: z.string().optional(),
	skills: z.array(z.string()).optional()
}).strict();
const LineAccountConfigSchema = LineCommonConfigSchema.extend({ groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional() }).strict();
const LineConfigSchema = LineCommonConfigSchema.extend({
	accounts: z.record(z.string(), LineAccountConfigSchema.optional()).optional(),
	defaultAccount: z.string().optional(),
	groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional()
}).strict();
`${QIANFAN_DEFAULT_MODEL_ID}`;
//#endregion
//#region src/commands/onboard-auth.config-shared.ts
function extractAgentDefaultModelFallbacks(model) {
	if (!model || typeof model !== "object") return;
	if (!("fallbacks" in model)) return;
	const fallbacks = model.fallbacks;
	return Array.isArray(fallbacks) ? fallbacks.map((v) => String(v)) : void 0;
}
function applyAgentDefaultModelPrimary(cfg, primary) {
	const existingFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				model: {
					...existingFallbacks ? { fallbacks: existingFallbacks } : void 0,
					primary
				}
			}
		}
	};
}
createSubsystemLogger("opencode-zen-models");
//#endregion
//#region src/commands/self-hosted-provider-setup.ts
const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128e3;
const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
const SELF_HOSTED_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function applyProviderDefaultModel(cfg, modelRef) {
	const existingModel = cfg.agents?.defaults?.model;
	const fallbacks = existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? existingModel.fallbacks : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: modelRef
				}
			}
		}
	};
}
function buildOpenAICompatibleSelfHostedProviderConfig(params) {
	const modelRef = `${params.providerId}/${params.modelId}`;
	const profileId = `${params.providerId}:default`;
	return {
		config: {
			...params.cfg,
			models: {
				...params.cfg.models,
				mode: params.cfg.models?.mode ?? "merge",
				providers: {
					...params.cfg.models?.providers,
					[params.providerId]: {
						baseUrl: params.baseUrl,
						api: "openai-completions",
						apiKey: params.providerApiKey,
						models: [{
							id: params.modelId,
							name: params.modelId,
							reasoning: params.reasoning ?? false,
							input: params.input ?? ["text"],
							cost: SELF_HOSTED_DEFAULT_COST,
							contextWindow: params.contextWindow ?? 128e3,
							maxTokens: params.maxTokens ?? 8192
						}]
					}
				}
			}
		},
		modelId: params.modelId,
		modelRef,
		profileId
	};
}
async function promptAndConfigureOpenAICompatibleSelfHostedProvider(params) {
	const baseUrlRaw = await params.prompter.text({
		message: `${params.providerLabel} base URL`,
		initialValue: params.defaultBaseUrl,
		placeholder: params.defaultBaseUrl,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const apiKeyRaw = await params.prompter.text({
		message: `${params.providerLabel} API key`,
		placeholder: "sk-... (or any non-empty string)",
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const modelIdRaw = await params.prompter.text({
		message: `${params.providerLabel} model`,
		placeholder: params.modelPlaceholder,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const baseUrl = String(baseUrlRaw ?? "").trim().replace(/\/+$/, "");
	const apiKey = String(apiKeyRaw ?? "").trim();
	const modelId = String(modelIdRaw ?? "").trim();
	const credential = {
		type: "api_key",
		provider: params.providerId,
		key: apiKey
	};
	const configured = buildOpenAICompatibleSelfHostedProviderConfig({
		cfg: params.cfg,
		providerId: params.providerId,
		baseUrl,
		providerApiKey: params.defaultApiKeyEnvVar,
		modelId,
		input: params.input,
		reasoning: params.reasoning,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	});
	return {
		config: configured.config,
		credential,
		modelId: configured.modelId,
		modelRef: configured.modelRef,
		profileId: configured.profileId
	};
}
//#endregion
//#region src/wizard/prompts.ts
var WizardCancelledError = class extends Error {
	constructor(message = "wizard cancelled") {
		super(message);
		this.name = "WizardCancelledError";
	}
};
//#endregion
//#region src/commands/oauth-env.ts
function isRemoteEnvironment() {
	if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
	if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true;
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSLEnv()) return true;
	return false;
}
//#endregion
//#region src/commands/ollama-setup.ts
const OLLAMA_DEFAULT_MODEL = "glm-4.7-flash";
const OLLAMA_SUGGESTED_MODELS_LOCAL = ["glm-4.7-flash"];
const OLLAMA_SUGGESTED_MODELS_CLOUD = [
	"kimi-k2.5:cloud",
	"minimax-m2.5:cloud",
	"glm-5:cloud"
];
function normalizeOllamaModelName(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	if (trimmed.toLowerCase().startsWith("ollama/")) return trimmed.slice(7).trim() || void 0;
	return trimmed;
}
function isOllamaCloudModel(modelName) {
	return Boolean(modelName?.trim().toLowerCase().endsWith(":cloud"));
}
function formatOllamaPullStatus(status) {
	const trimmed = status.trim();
	const partStatusMatch = trimmed.match(/^([a-z-]+)\s+(?:sha256:)?[a-f0-9]{8,}$/i);
	if (partStatusMatch) return {
		text: `${partStatusMatch[1]} part`,
		hidePercent: false
	};
	if (/^verifying\b.*\bdigest\b/i.test(trimmed)) return {
		text: "verifying digest",
		hidePercent: true
	};
	return {
		text: trimmed,
		hidePercent: false
	};
}
/** Check if the user is signed in to Ollama cloud via /api/me. */
async function checkOllamaCloudAuth(baseUrl) {
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/me`, {
			method: "POST",
			signal: AbortSignal.timeout(5e3)
		});
		if (response.status === 401) return {
			signedIn: false,
			signinUrl: (await response.json()).signin_url
		};
		if (!response.ok) return { signedIn: false };
		return { signedIn: true };
	} catch {
		return { signedIn: false };
	}
}
async function pullOllamaModelCore(params) {
	const { onStatus } = params;
	const baseUrl = resolveOllamaApiBase(params.baseUrl);
	const modelName = normalizeOllamaModelName(params.modelName) ?? params.modelName.trim();
	try {
		const response = await fetch(`${baseUrl}/api/pull`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelName })
		});
		if (!response.ok) return {
			ok: false,
			kind: "http",
			message: `Failed to download ${modelName} (HTTP ${response.status})`
		};
		if (!response.body) return {
			ok: false,
			kind: "no-body",
			message: `Failed to download ${modelName} (no response body)`
		};
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const layers = /* @__PURE__ */ new Map();
		const parseLine = (line) => {
			const trimmed = line.trim();
			if (!trimmed) return { ok: true };
			try {
				const chunk = JSON.parse(trimmed);
				if (chunk.error) return {
					ok: false,
					kind: "chunk-error",
					message: `Download failed: ${chunk.error}`
				};
				if (!chunk.status) return { ok: true };
				if (chunk.total && chunk.completed !== void 0) {
					layers.set(chunk.status, {
						total: chunk.total,
						completed: chunk.completed
					});
					let totalSum = 0;
					let completedSum = 0;
					for (const layer of layers.values()) {
						totalSum += layer.total;
						completedSum += layer.completed;
					}
					const percent = totalSum > 0 ? Math.round(completedSum / totalSum * 100) : null;
					onStatus?.(chunk.status, percent);
				} else onStatus?.(chunk.status, null);
			} catch {}
			return { ok: true };
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const parsed = parseLine(line);
				if (!parsed.ok) return parsed;
			}
		}
		const trailing = buffer.trim();
		if (trailing) {
			const parsed = parseLine(trailing);
			if (!parsed.ok) return parsed;
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			kind: "network",
			message: `Failed to download ${modelName}: ${err instanceof Error ? err.message : String(err)}`
		};
	}
}
/** Pull a model from Ollama, streaming progress updates. */
async function pullOllamaModel(baseUrl, modelName, prompter) {
	const spinner = prompter.progress(`Downloading ${modelName}...`);
	const result = await pullOllamaModelCore({
		baseUrl,
		modelName,
		onStatus: (status, percent) => {
			const displayStatus = formatOllamaPullStatus(status);
			if (displayStatus.hidePercent) spinner.update(`Downloading ${modelName} - ${displayStatus.text}`);
			else spinner.update(`Downloading ${modelName} - ${displayStatus.text} - ${percent ?? 0}%`);
		}
	});
	if (!result.ok) {
		spinner.stop(result.message);
		return false;
	}
	spinner.stop(`Downloaded ${modelName}`);
	return true;
}
async function pullOllamaModelNonInteractive(baseUrl, modelName, runtime) {
	runtime.log(`Downloading ${modelName}...`);
	const result = await pullOllamaModelCore({
		baseUrl,
		modelName
	});
	if (!result.ok) {
		runtime.error(result.message);
		return false;
	}
	runtime.log(`Downloaded ${modelName}`);
	return true;
}
function buildOllamaModelsConfig(modelNames, discoveredModelsByName) {
	return modelNames.map((name) => buildOllamaModelDefinition(name, discoveredModelsByName?.get(name)?.contextWindow));
}
function applyOllamaProviderConfig(cfg, baseUrl, modelNames, discoveredModelsByName) {
	return {
		...cfg,
		models: {
			...cfg.models,
			mode: cfg.models?.mode ?? "merge",
			providers: {
				...cfg.models?.providers,
				ollama: {
					baseUrl,
					api: "ollama",
					apiKey: "OLLAMA_API_KEY",
					models: buildOllamaModelsConfig(modelNames, discoveredModelsByName)
				}
			}
		}
	};
}
async function storeOllamaCredential(agentDir) {
	await upsertAuthProfileWithLock({
		profileId: "ollama:default",
		credential: {
			type: "api_key",
			provider: "ollama",
			key: "ollama-local"
		},
		agentDir
	});
}
/**
* Interactive: prompt for base URL, discover models, configure provider.
* Model selection is handled by the standard model picker downstream.
*/
async function promptAndConfigureOllama(params) {
	const { prompter } = params;
	const baseUrlRaw = await prompter.text({
		message: "Ollama base URL",
		initialValue: OLLAMA_DEFAULT_BASE_URL,
		placeholder: OLLAMA_DEFAULT_BASE_URL,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const baseUrl = resolveOllamaApiBase(String(baseUrlRaw ?? "").trim().replace(/\/+$/, ""));
	const { reachable, models } = await fetchOllamaModels(baseUrl);
	if (!reachable) {
		await prompter.note([
			`Ollama could not be reached at ${baseUrl}.`,
			"Download it at https://ollama.com/download",
			"",
			"Start Ollama and re-run onboarding."
		].join("\n"), "Ollama");
		throw new WizardCancelledError("Ollama not reachable");
	}
	const enrichedModels = await enrichOllamaModelsWithContext(baseUrl, models.slice(0, 50));
	const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
	const modelNames = models.map((m) => m.name);
	const mode = await prompter.select({
		message: "Ollama mode",
		options: [{
			value: "remote",
			label: "Cloud + Local",
			hint: "Ollama cloud models + local models"
		}, {
			value: "local",
			label: "Local",
			hint: "Local models only"
		}]
	});
	let cloudAuthVerified = false;
	if (mode === "remote") {
		const authResult = await checkOllamaCloudAuth(baseUrl);
		if (!authResult.signedIn) if (authResult.signinUrl) {
			if (!isRemoteEnvironment()) await openUrl(authResult.signinUrl);
			await prompter.note(["Sign in to Ollama Cloud:", authResult.signinUrl].join("\n"), "Ollama Cloud");
			if (!await prompter.confirm({ message: "Have you signed in?" })) throw new WizardCancelledError("Ollama cloud sign-in cancelled");
			if (!(await checkOllamaCloudAuth(baseUrl)).signedIn) throw new WizardCancelledError("Ollama cloud sign-in required");
			cloudAuthVerified = true;
		} else {
			await prompter.note(["Could not verify Ollama Cloud authentication.", "Cloud models may not work until you sign in at https://ollama.com."].join("\n"), "Ollama Cloud");
			if (!await prompter.confirm({ message: "Continue without cloud auth?" })) throw new WizardCancelledError("Ollama cloud auth could not be verified");
		}
		else cloudAuthVerified = true;
	}
	const suggestedModels = mode === "local" || !cloudAuthVerified ? OLLAMA_SUGGESTED_MODELS_LOCAL : OLLAMA_SUGGESTED_MODELS_CLOUD;
	const orderedModelNames = [...suggestedModels, ...modelNames.filter((name) => !suggestedModels.includes(name))];
	const defaultModelId = suggestedModels[0] ?? "glm-4.7-flash";
	return {
		config: applyOllamaProviderConfig(params.cfg, baseUrl, orderedModelNames, discoveredModelsByName),
		defaultModelId
	};
}
/** Non-interactive: auto-discover models and configure provider. */
async function configureOllamaNonInteractive(params) {
	const { opts, runtime } = params;
	const baseUrl = resolveOllamaApiBase((opts.customBaseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, ""));
	const { reachable, models } = await fetchOllamaModels(baseUrl);
	const explicitModel = normalizeOllamaModelName(opts.customModelId);
	if (!reachable) {
		runtime.error([`Ollama could not be reached at ${baseUrl}.`, "Download it at https://ollama.com/download"].join("\n"));
		runtime.exit(1);
		return params.nextConfig;
	}
	await storeOllamaCredential();
	const enrichedModels = await enrichOllamaModelsWithContext(baseUrl, models.slice(0, 50));
	const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
	const modelNames = models.map((m) => m.name);
	const suggestedModels = OLLAMA_SUGGESTED_MODELS_LOCAL;
	const orderedModelNames = [...suggestedModels, ...modelNames.filter((name) => !suggestedModels.includes(name))];
	const requestedDefaultModelId = explicitModel ?? suggestedModels[0];
	let pulledRequestedModel = false;
	const availableModelNames = new Set(modelNames);
	const requestedCloudModel = isOllamaCloudModel(requestedDefaultModelId);
	if (requestedCloudModel) availableModelNames.add(requestedDefaultModelId);
	if (!requestedCloudModel && !modelNames.includes(requestedDefaultModelId)) {
		pulledRequestedModel = await pullOllamaModelNonInteractive(baseUrl, requestedDefaultModelId, runtime);
		if (pulledRequestedModel) availableModelNames.add(requestedDefaultModelId);
	}
	let allModelNames = orderedModelNames;
	let defaultModelId = requestedDefaultModelId;
	if ((pulledRequestedModel || requestedCloudModel) && !allModelNames.includes(requestedDefaultModelId)) allModelNames = [...allModelNames, requestedDefaultModelId];
	if (!availableModelNames.has(requestedDefaultModelId)) if (availableModelNames.size > 0) {
		defaultModelId = allModelNames.find((name) => availableModelNames.has(name)) ?? Array.from(availableModelNames)[0];
		runtime.log(`Ollama model ${requestedDefaultModelId} was not available; using ${defaultModelId} instead.`);
	} else {
		runtime.error([`No Ollama models are available at ${baseUrl}.`, "Pull a model first, then re-run onboarding."].join("\n"));
		runtime.exit(1);
		return params.nextConfig;
	}
	const config = applyOllamaProviderConfig(params.nextConfig, baseUrl, allModelNames, discoveredModelsByName);
	const modelRef = `ollama/${defaultModelId}`;
	runtime.log(`Default Ollama model: ${defaultModelId}`);
	return applyAgentDefaultModelPrimary(config, modelRef);
}
/** Pull the configured default Ollama model if it isn't already available locally. */
async function ensureOllamaModelPulled(params) {
	const modelCfg = params.config.agents?.defaults?.model;
	const modelId = typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
	if (!modelId?.startsWith("ollama/")) return;
	const baseUrl = params.config.models?.providers?.ollama?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
	const modelName = modelId.slice(7);
	if (isOllamaCloudModel(modelName)) return;
	const { models } = await fetchOllamaModels(baseUrl);
	if (models.some((m) => m.name === modelName)) return;
	if (!await pullOllamaModel(baseUrl, modelName, params.prompter)) throw new WizardCancelledError("Failed to download selected Ollama model");
}
//#endregion
//#region src/commands/vllm-setup.ts
const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const VLLM_DEFAULT_CONTEXT_WINDOW = SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
const VLLM_DEFAULT_MAX_TOKENS = SELF_HOSTED_DEFAULT_MAX_TOKENS;
const VLLM_DEFAULT_COST = SELF_HOSTED_DEFAULT_COST;
async function promptAndConfigureVllm(params) {
	const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider({
		cfg: params.cfg,
		prompter: params.prompter,
		providerId: "vllm",
		providerLabel: "vLLM",
		defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
		defaultApiKeyEnvVar: "VLLM_API_KEY",
		modelPlaceholder: "meta-llama/Meta-Llama-3-8B-Instruct"
	});
	return {
		config: result.config,
		modelId: result.modelId,
		modelRef: result.modelRef
	};
}
//#endregion
export { ACP_ERROR_CODES, AcpRuntimeError, AllowFromEntrySchema, AllowFromListSchema, BLUEBUBBLES_ACTIONS, BLUEBUBBLES_ACTION_NAMES, BLUEBUBBLES_GROUP_ACTIONS, BlockStreamingCoalesceSchema, CHANNEL_MESSAGE_ACTION_NAMES, DEFAULT_ACCOUNT_ID, DEFAULT_GROUP_HISTORY_LIMIT, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS, DEFAULT_WEBHOOK_MAX_BODY_BYTES, DM_GROUP_ACCESS_REASON, DiscordConfigSchema, DmConfigSchema, DmPolicySchema, GROUP_POLICY_BLOCKED_LABEL, GoogleChatConfigSchema, GroupPolicySchema, IMessageConfigSchema, KeyedAsyncQueue, LineConfigSchema, MSTeamsConfigSchema, MarkdownConfigSchema, MarkdownTableModeSchema, OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, PAIRING_APPROVED_MESSAGE, ReplyRuntimeConfigSchemaShape, RequestBodyLimitError, SELF_HOSTED_DEFAULT_CONTEXT_WINDOW, SELF_HOSTED_DEFAULT_COST, SELF_HOSTED_DEFAULT_MAX_TOKENS, SILENT_REPLY_TOKEN, SecretInputSchema, SignalConfigSchema, SlackConfigSchema, SsrFBlockedError, TelegramConfigSchema, ToolPolicySchema, TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema, VLLM_DEFAULT_BASE_URL, VLLM_DEFAULT_CONTEXT_WINDOW, VLLM_DEFAULT_COST, VLLM_DEFAULT_MAX_TOKENS, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_ANOMALY_STATUS_CODES, WEBHOOK_BODY_READ_DEFAULTS, WEBHOOK_IN_FLIGHT_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, WhatsAppConfigSchema, acquireFileLock, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applyProviderDefaultModel, applySetupAccountConfigPatch, applyWindowsSpawnProgramPolicy, approveDevicePairing, assertSecretInputResolved, autoBindSpawnedDiscordSubagent, beginWebhookRequestPipelineOrReject, buildAccountScopedDmSecurityPolicy, buildAgentMediaPayload, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildCatchallMultiAccountChannelSchema, buildChannelConfigSchema, buildChannelKeyCandidates, buildChannelSendResult, buildComputedAccountStatusSnapshot, buildDiscordSendMediaOptions, buildDiscordSendOptions, buildHostnameAllowlistPolicyFromSuffixAllowlist, buildInboundReplyDispatchBase, buildMediaPayload, buildNestedDmConfigSchema, buildOauthProviderAuthResult, buildOllamaProvider, buildOpenGroupPolicyConfigureRouteAllowlistWarning, buildOpenGroupPolicyNoRouteAllowlistWarning, buildOpenGroupPolicyRestrictSendersWarning, buildOpenGroupPolicyWarning, buildPendingHistoryContextFromMap, buildProbeChannelStatusSummary, buildRandomTempFilePath, buildRuntimeAccountStatusSnapshot, buildSglangProvider, buildSlackThreadingToolContext, buildTokenChannelStatusSummary, buildVllmProvider, chunkTextForOutbound, clamp, clearAccountEntryFields, clearHistoryEntries, clearHistoryEntriesIfEnabled, collectAllowlistProviderGroupPolicyWarnings, collectAllowlistProviderRestrictSendersWarnings, collectBlueBubblesStatusIssues, collectDiscordAuditChannelIds, collectDiscordStatusIssues, collectOpenGroupPolicyConfiguredRouteWarnings, collectOpenGroupPolicyRestrictSendersWarnings, collectOpenGroupPolicyRouteAllowlistWarnings, collectOpenProviderGroupPolicyWarnings, collectStatusIssuesFromLastError, collectTelegramStatusIssues, collectWhatsAppStatusIssues, compileAllowlist, configureOllamaNonInteractive, createAccountListHelpers, createAccountStatusSink, createActionCard, createActionGate, createAllowedChatSenderMatcher, createBoundedCounter, createDedupeCache, createDefaultChannelRuntimeState, createFixedWindowRateLimiter, createImageCard, createInboundEnvelopeBuilder, createInfoCard, createListCard, createLoggerBackedRuntime, createNormalizedOutboundDeliverer, createPersistentDedupe, createPluginRuntimeStore, createReceiptCard, createReplyPrefixContext, createReplyPrefixOptions, createScopedAccountConfigAccessors, createScopedChannelConfigBase, createScopedDmSecurityResolver, createScopedPairingAccess, createTypingCallbacks, createWebhookAnomalyTracker, createWebhookInFlightLimiter, deleteAccountFromConfigSection, detectMime, discordOnboardingAdapter, dispatchInboundReplyWithBase, dispatchReplyFromConfigWithSettledDispatcher, emitDiagnosticEvent, emptyPluginConfigSchema, enqueueKeyedTask, ensureOllamaModelPulled, escapeRegExp, evaluateGroupRouteAccessForPolicy, evaluateMatchedGroupAccessForPolicy, evaluateSenderGroupAccess, evaluateSenderGroupAccessForPolicy, evictOldHistoryKeys, extensionForMime, extractOriginalFilename, extractSlackToolSend, extractToolSend, fetchWithBearerAuthScopeFallback, fetchWithSsrFGuard, formatAllowFromLowercase, formatAllowlistMatchMeta, formatDocsLink, formatErrorMessage, formatInboundFromLabel, formatLocationText, formatNormalizedAllowFromEntries, formatPairingApproveHint, formatResolvedUnresolvedNote, formatTextWithAttachmentLinks, formatTrimmedAllowFromEntries, formatUtcTimestamp, formatWhatsAppConfigAllowFromEntries, formatZonedTimestamp, generatePkceVerifierChallenge, getAcpRuntimeBackend, getChatChannelMeta, getFileExtension, handleSlackMessageAction, hasConfiguredSecretInput, hasMarkdownToConvert, imessageOnboardingAdapter, inspectDiscordAccount, inspectSlackAccount, inspectTelegramAccount, installRequestBodyLimitGuard, isAllowedParsedChatSender, isBlockedHostname, isBlockedHostnameOrIp, isDangerousNameMatchingEnabled, isDiagnosticsEnabled, isHttpsUrlAllowedByHostnameSuffixAllowlist, isJsonContentType, isNormalizedSenderAllowed, isNumericTargetId, isPrivateIpAddress, isRequestBodyLimitError, isSecretRef, isSilentReplyText, isTruthyEnvValue, isWSL2Sync, isWSLEnv, isWSLSync, isWhatsAppGroupJid, issuePairingChallenge, jsonResult, keepHttpServerTaskAlive, listConfiguredAccountIds, listDevicePairing, listDirectoryGroupEntriesFromMapKeys, listDirectoryGroupEntriesFromMapKeysAndAllowFrom, listDirectoryUserEntriesFromAllowFrom, listDirectoryUserEntriesFromAllowFromAndMapKeys, listDiscordAccountIds, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listEnabledSlackAccounts, listIMessageAccountIds, listLineAccountIds, listSignalAccountIds, listSkillCommandsForAgents, listSlackAccountIds, listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig, listSlackMessageActions, listTelegramAccountIds, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, listThreadBindingsBySessionKey, listWhatsAppAccountIds, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, loadOutboundMediaFromUrl, loadWebMedia, logAckFailure, logInboundDrop, logTypingFailure, looksLikeDiscordTargetId, looksLikeIMessageTargetId, looksLikeSignalTargetId, looksLikeSlackTargetId, looksLikeTelegramTargetId, looksLikeWhatsAppTargetId, mapAllowFromEntries, mapAllowlistResolutionInputs, mapBasicAllowlistResolutionEntries, materializeWindowsSpawnProgram, mergeAllowFromEntries, mergeAllowlist, migrateBaseNameToDefaultAccount, missingTargetError, normalizeAccountId, normalizeAgentId, normalizeAllowFrom, normalizeChannelSlug, normalizeDiscordMessagingTarget, normalizeDiscordOutboundTarget, normalizeE164, normalizeHostnameSuffixAllowlist, normalizeIMessageMessagingTarget, normalizeAccountId$1 as normalizeLineAccountId, normalizeOutboundReplyPayload, normalizePluginHttpPath, normalizeResolvedSecretInputString, normalizeSecretInputString, normalizeSignalMessagingTarget, normalizeSlackMessagingTarget, normalizeTelegramMessagingTarget, normalizeWebhookPath, normalizeWhatsAppAllowFromEntries, normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget, onDiagnosticEvent, optionalStringEnum, parseChatAllowTargetPrefixes, parseChatTargetPrefixesOrThrow, parseTelegramReplyToMessageId, parseTelegramThreadId, patchScopedAccountConfig, processLineMessage, promptAccountId, promptAndConfigureOllama, promptAndConfigureOpenAICompatibleSelfHostedProvider, promptAndConfigureVllm, promptChannelAccessConfig, promptSingleChannelSecretInput, rawDataToString, readBooleanParam, readJsonBodyWithLimit, readJsonFileWithFallback, readJsonWebhookBodyOrReject, readNumberParam, readReactionParams, readRequestBodyWithLimit, readStoreAllowFromForDmPolicy, readStringParam, readWebhookBodyOrReject, recordInboundSession, recordInboundSessionAndDispatchReply, recordPendingHistoryEntry, recordPendingHistoryEntryIfEnabled, redactSensitiveText, registerAcpRuntimeBackend, registerContextEngine, registerLogTransport, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, rejectDevicePairing, rejectNonPostWebhookRequest, removeAckReactionAfterReply, requestBodyErrorToText, requireAcpRuntimeBackend, requireApiKey, requireOpenAllowFrom, resetMissingProviderGroupPolicyFallbackWarningsForTesting, resolveAccountIdForConfigure, resolveAccountWithDefaultFallback, resolveAckReaction, resolveAllowlistCandidates, resolveAllowlistMatchByCandidates, resolveAllowlistMatchSimple, resolveAllowlistProviderRuntimeGroupPolicy, resolveBlueBubblesGroupRequireMention, resolveBlueBubblesGroupToolPolicy, resolveChannelAccountConfigBasePath, resolveChannelEntryMatch, resolveChannelEntryMatchWithFallback, resolveChannelGroupRequireMention, resolveChannelMediaMaxBytes, resolveControlCommandGate, resolveDefaultDiscordAccountId, resolveDefaultGroupPolicy, resolveDefaultIMessageAccountId, resolveDefaultLineAccountId, resolveDefaultSignalAccountId, resolveDefaultSlackAccountId, resolveDefaultTelegramAccountId, resolveDefaultWhatsAppAccountId, resolveDirectDmAuthorizationOutcome, resolveDiscordAccount, resolveDiscordGroupRequireMention, resolveDiscordGroupToolPolicy, resolveDmAllowState, resolveDmGroupAccessDecision, resolveDmGroupAccessWithCommandGate, resolveDmGroupAccessWithLists, resolveEffectiveAllowFromLists, resolveGatewayBindUrl, resolveGoogleChatGroupRequireMention, resolveGoogleChatGroupToolPolicy, resolveIMessageAccount, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, resolveInboundRouteEnvelopeBuilder, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveInboundSessionEnvelopeContext, resolveLineAccount, resolveMentionGating, resolveMentionGatingWithBypass, resolveNestedAllowlistDecision, resolveOpenProviderRuntimeGroupPolicy, resolveOptionalConfigString, resolveOutboundMediaUrls, resolvePreferredOpenClawTmpDir, resolveRequestUrl, resolveRuntimeEnv, resolveRuntimeEnvWithUnavailableExit, resolveRuntimeGroupPolicy, resolveSenderCommandAuthorization, resolveSenderCommandAuthorizationWithRuntime, resolveSenderScopedGroupPolicy, resolveServicePrefixedAllowTarget, resolveServicePrefixedChatTarget, resolveServicePrefixedOrChatAllowTarget, resolveServicePrefixedTarget, resolveSignalAccount, resolveSingleWebhookTarget, resolveSingleWebhookTargetAsync, resolveSlackAccount, resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy, resolveSlackReplyToMode, resolveTailnetHostWithRunner, resolveTelegramAccount, resolveTelegramGroupRequireMention, resolveTelegramGroupToolPolicy, resolveThreadSessionKeys, resolveTimezone, resolveToolsBySender, resolveWebhookPath, resolveWebhookTargetWithAuthOrReject, resolveWebhookTargetWithAuthOrRejectSync, resolveWebhookTargets, resolveWhatsAppAccount, resolveWhatsAppConfigAllowFrom, resolveWhatsAppConfigDefaultTo, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppHeartbeatRecipients, resolveWhatsAppMentionStripPatterns, resolveWhatsAppOutboundTarget, resolveWindowsExecutablePath, resolveWindowsSpawnProgram, resolveWindowsSpawnProgramCandidate, runPassiveAccountLifecycle, runPluginCommandWithTimeout, safeParseJson, sendMediaWithLeadingCaption, sendPayloadWithChunkedTextAndMedia, setAccountEnabledInConfigSection, setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom, setTopLevelChannelGroupPolicy, shouldAckReaction, shouldAckReactionForWhatsApp, signalOnboardingAdapter, slackOnboardingAdapter, sleep, stringEnum, stripAnsi, stripMarkdown, summarizeMapping, tagDiscordChannelResult, telegramOnboardingAdapter, toFormUrlEncoded, toLocationContext, unbindThreadBindingsBySessionKey, unregisterAcpRuntimeBackend, waitUntilAbort, warnMissingProviderGroupPolicyFallbackOnce, whatsappOnboardingAdapter, withFileLock, withResolvedWebhookRequestPipeline, withTempDownloadPath, writeJsonFileAtomically };
