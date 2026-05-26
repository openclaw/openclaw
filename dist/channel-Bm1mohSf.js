import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { s as hasConfiguredSecretInput, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { a as tryReadSecretFileSync } from "./secret-file-DsUhZ-Ug.js";
import { a as createAuthRateLimiter } from "./auth-rate-limit-DA3xJNFz.js";
import { R as requireOpenAllowFrom, b as ReplyRuntimeConfigSchemaShape, h as MarkdownConfigSchema, l as GroupPolicySchema, o as DmPolicySchema } from "./zod-schema.core-D7Y_eqdd.js";
import { u as ToolPolicySchema } from "./zod-schema.agent-runtime-Bq5CXVVg.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { a as resolveChannelEntryMatchWithFallback, n as buildChannelKeyCandidates, r as normalizeChannelSlug, s as resolveNestedAllowlistDecision } from "./channel-config-BI04LRnO.js";
import { r as deliverFormattedTextWithAttachments } from "./reply-payload-DMPQsrQC.js";
import { c as jsonResult, g as readStringParam } from "./common-E9YpX7pB.js";
import { o as resolveStableChannelMessageIngress, t as channelIngressRoutes } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy, t as GROUP_POLICY_BLOCKED_LABEL } from "./runtime-group-policy-CmZDlIwd.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { t as clearAccountEntryFields } from "./config-helpers-a_k3n5UT.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-xZ4-bv2H.js";
import { m as readProviderJsonResponse } from "./provider-http-errors-C90BH-le.js";
import { t as buildOutboundBaseSessionKey } from "./base-session-key-jTw5jqgt.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, i as hasConfiguredAccountValue, r as describeWebhookAccountSnapshot, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import { t as resolveAccountWithDefaultFallback } from "./account-core-DdyIQODw.js";
import { a as createSetupInputPresenceValidator, l as patchScopedAccountConfig, t as applyAccountNameToChannelSection } from "./setup-helpers-BC9z9VvG.js";
import { i as createChatChannelPlugin } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import "./routing-79DRZvfm.js";
import { r as buildSecretInputSchema } from "./secret-input-CWnTb0tw.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { t as createAccountStatusSink } from "./channel-lifecycle.core-CDt0hRZR.js";
import { t as formatAllowFromLowercase } from "./allow-from-CvE3rvhy.js";
import "./channel-config-schema-BBVXL5oD.js";
import { y as createAllowlistProviderRouteAllowlistWarningCollector } from "./channel-policy-pv8ZpZxj.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { J as setSetupChannelEnabled, f as createStandardChannelSetupStatus, j as promptParsedAllowFromForAccount, v as mergeAllowFromEntries, z as resolveSetupAccountId } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import "./setup-runtime-BRbeJqWD.js";
import "./setup-tools-DuiMNzp5.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-dxinAe5Y.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DF4N8x5q.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "./http-body-BfDL157U.js";
import { d as ssrfPolicyFromPrivateNetworkOptIn } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./text-chunking-C154U6-i.js";
import "./secret-file-runtime-C3e0r_CO.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import "./channel-plugin-common-fWZhnLoH.js";
import { d as createDefaultChannelRuntimeState, s as buildWebhookChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { f as requireChannelOpenAllowFrom, h as runStoppablePassiveMonitor, m as resolveLoggerBackedRuntime } from "./extension-shared-DSIp8QS_.js";
import { r as resolveReactionMessageId } from "./channel-actions-DMN7G5RZ.js";
import { n as logInboundDrop } from "./logging-Dr3f0mtP.js";
import "./channel-lifecycle-B7VOl7bW.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { i as createPairingPrefixStripper, n as createChannelPairingController, r as createLoggedPairingApprovalNotifier } from "./channel-pairing-N4dBc-K-.js";
import "./channel-targets-DLOcH73y.js";
import "./provider-http-CYBE-CBM.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-DaB2erKZ.js";
import { r as WEBHOOK_RATE_LIMIT_DEFAULTS } from "./webhook-ingress-R0qMwT4u.js";
import { t as getNextcloudTalkRuntime } from "./runtime-api-CDwiUOk1.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-ClyXS-qv.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-DUgvUrah.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
//#region extensions/nextcloud-talk/src/accounts.ts
function isTruthyEnvValue(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}
const debugAccounts = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_NEXTCLOUD_TALK_ACCOUNTS)) console.warn("[nextcloud-talk:accounts]", ...args);
};
const { listAccountIds: listNextcloudTalkAccountIdsInternal, resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId } = createAccountListHelpers("nextcloud-talk", {
	normalizeAccountId,
	hasImplicitDefaultAccount: (cfg) => {
		const channel = cfg.channels?.["nextcloud-talk"];
		return Boolean(channel?.baseUrl?.trim() && (hasConfiguredAccountValue(channel.botSecret) || channel.botSecretFile?.trim() || process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()));
	}
});
function listNextcloudTalkAccountIds(cfg) {
	const ids = listNextcloudTalkAccountIdsInternal(cfg);
	debugAccounts("listNextcloudTalkAccountIds", ids);
	return ids;
}
function mergeNextcloudTalkAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.["nextcloud-talk"],
		accounts: cfg.channels?.["nextcloud-talk"]?.accounts,
		accountId,
		omitKeys: ["defaultAccount"],
		normalizeAccountId
	});
}
function resolveNextcloudTalkSecret(cfg, opts) {
	const resolvedAccountId = opts.accountId ?? resolveDefaultNextcloudTalkAccountId(cfg);
	const merged = mergeNextcloudTalkAccountConfig(cfg, resolvedAccountId);
	const envSecret = normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET);
	if (envSecret && resolvedAccountId === "default") return {
		secret: envSecret,
		source: "env"
	};
	if (merged.botSecretFile) {
		const fileSecret = tryReadSecretFileSync(merged.botSecretFile, "Nextcloud Talk bot secret file", { rejectSymlink: true });
		if (fileSecret) return {
			secret: fileSecret,
			source: "secretFile"
		};
	}
	const inlineSecret = normalizeResolvedSecretInputString({
		value: merged.botSecret,
		path: `channels.nextcloud-talk.accounts.${resolvedAccountId}.botSecret`
	});
	if (inlineSecret) return {
		secret: inlineSecret,
		source: "config"
	};
	return {
		secret: "",
		source: "none"
	};
}
function resolveNextcloudTalkAccount(params) {
	const baseEnabled = params.cfg.channels?.["nextcloud-talk"]?.enabled !== false;
	const resolvedAccountId = params.accountId ?? resolveDefaultNextcloudTalkAccountId(params.cfg);
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
			name: normalizeOptionalString(merged.name),
			baseUrl,
			secret: secretResolution.secret,
			secretSource: secretResolution.source,
			config: merged
		};
	};
	return resolveAccountWithDefaultFallback({
		accountId: resolvedAccountId,
		normalizeAccountId,
		resolvePrimary: resolve,
		hasCredential: (account) => account.secretSource !== "none",
		resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg)
	});
}
//#endregion
//#region extensions/nextcloud-talk/src/approval-auth.ts
function normalizeNextcloudTalkApproverId(value) {
	return normalizeOptionalLowercaseString(String(value).trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, ""));
}
const nextcloudTalkApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Nextcloud Talk",
	resolveApprovers: ({ cfg, accountId }) => {
		return resolveApprovalApprovers({
			allowFrom: resolveNextcloudTalkAccount({
				cfg,
				accountId
			}).config.allowFrom,
			normalizeApprover: normalizeNextcloudTalkApproverId
		});
	},
	normalizeSenderId: (value) => normalizeNextcloudTalkApproverId(value)
});
//#endregion
//#region extensions/nextcloud-talk/src/api-credentials.ts
function resolveNextcloudTalkApiCredentials(params) {
	const apiUser = params.apiUser?.trim();
	if (!apiUser) return;
	const inlinePassword = normalizeResolvedSecretInputString({
		value: params.apiPassword,
		path: "channels.nextcloud-talk.apiPassword"
	});
	if (inlinePassword) return {
		apiUser,
		apiPassword: inlinePassword
	};
	if (!params.apiPasswordFile) return;
	try {
		const filePassword = readFileSync(params.apiPasswordFile, "utf-8").trim();
		return filePassword ? {
			apiUser,
			apiPassword: filePassword
		} : void 0;
	} catch {
		return;
	}
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
	if (!signature || !random || !secret) return false;
	const expected = createHmac("sha256", secret).update(random + body).digest("hex");
	const expectedBuf = Buffer.from(expected, "utf8");
	const signatureBuf = Buffer.from(signature, "utf8");
	const maxLen = Math.max(expectedBuf.length, signatureBuf.length);
	const paddedExpected = Buffer.alloc(maxLen);
	const paddedSignature = Buffer.alloc(maxLen);
	expectedBuf.copy(paddedExpected);
	signatureBuf.copy(paddedSignature);
	const timingResult = timingSafeEqual(paddedExpected, paddedSignature);
	return expectedBuf.length === signatureBuf.length && timingResult;
}
/**
* Extract webhook headers from an incoming request.
*/
function extractNextcloudTalkHeaders(headers) {
	const getHeader = (name) => {
		const value = headers[name] ?? headers[normalizeLowercaseStringOrEmpty(name)];
		return Array.isArray(value) ? value[0] : value;
	};
	const signature = getHeader(SIGNATURE_HEADER);
	const random = getHeader(RANDOM_HEADER);
	const backend = getHeader(BACKEND_HEADER);
	if (!signature || !random || !backend) return null;
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
//#region extensions/nextcloud-talk/src/bot-preflight.ts
const BOT_FEATURE_RESPONSE = 2;
function normalizeUrlForMatch(value) {
	if (!value?.trim()) return "";
	try {
		const url = new URL(value.trim());
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return value.trim().replace(/\/$/, "");
	}
}
function coerceFeatureMask(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function formatMissingResponseFeatureMessage(bot, features) {
	const id = bot.id == null ? "unknown" : String(bot.id);
	return `Nextcloud Talk bot "${bot.name?.trim() || "matching bot"}" (${id}) is missing the response feature${typeof features === "number" ? ` (features=${features})` : ""}; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction ${id} 1 or reinstall the bot with --feature response.`;
}
async function probeNextcloudTalkBotResponseFeature(params) {
	const { account, timeoutMs } = params;
	const baseUrl = account.baseUrl?.trim();
	if (!baseUrl) return {
		ok: true,
		skipped: true,
		code: "missing_base_url",
		message: "Nextcloud Talk bot response feature probe skipped: baseUrl is not configured."
	};
	const webhookUrl = normalizeUrlForMatch(account.config.webhookPublicUrl);
	if (!webhookUrl) return {
		ok: true,
		skipped: true,
		code: "missing_webhook_url",
		message: "Nextcloud Talk bot response feature probe skipped: webhookPublicUrl is not configured."
	};
	const credentials = resolveNextcloudTalkApiCredentials({
		apiUser: account.config.apiUser,
		apiPassword: account.config.apiPassword,
		apiPasswordFile: account.config.apiPasswordFile
	});
	if (!credentials) return {
		ok: true,
		skipped: true,
		code: "missing_api_credentials",
		message: "Nextcloud Talk bot response feature probe skipped: apiUser/apiPassword are not configured."
	};
	const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/admin`;
	const auth = Buffer.from(`${credentials.apiUser}:${credentials.apiPassword}`, "utf-8").toString("base64");
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
			auditContext: "nextcloud-talk.bot-response-preflight",
			policy: ssrfPolicyFromPrivateNetworkOptIn(account.config),
			timeoutMs
		});
		try {
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					ok: false,
					code: "api_error",
					status: response.status,
					message: `Nextcloud Talk bot response feature probe failed (${response.status})${body ? `: ${body}` : ""}`
				};
			}
			const payload = await readProviderJsonResponse(response, "Nextcloud Talk bot response feature probe failed");
			const bot = (Array.isArray(payload.ocs?.data) ? payload.ocs.data : []).find((entry) => normalizeUrlForMatch(entry.url) === webhookUrl);
			if (!bot) return {
				ok: false,
				code: "bot_not_found",
				message: `Nextcloud Talk bot response feature probe could not find a bot with webhook URL ${webhookUrl}.`
			};
			const features = coerceFeatureMask(bot.features);
			if (features == null || (features & BOT_FEATURE_RESPONSE) !== BOT_FEATURE_RESPONSE) return {
				ok: false,
				code: "missing_response_feature",
				botId: bot.id == null ? void 0 : String(bot.id),
				botName: bot.name,
				features,
				message: formatMissingResponseFeatureMessage(bot, features)
			};
			return {
				ok: true,
				code: "ok",
				botId: bot.id == null ? void 0 : String(bot.id),
				botName: bot.name,
				features,
				message: `Nextcloud Talk bot "${bot.name ?? bot.id ?? "matching bot"}" has the response feature.`
			};
		} finally {
			await release();
		}
	} catch (error) {
		return {
			ok: false,
			code: "request_failed",
			message: `Nextcloud Talk bot response feature probe failed: ${error instanceof Error ? error.message : formatErrorMessage(error)}`
		};
	}
}
//#endregion
//#region extensions/nextcloud-talk/src/channel.adapters.ts
const nextcloudTalkConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "nextcloud-talk",
	listAccountIds: listNextcloudTalkAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
	defaultAccountId: resolveDefaultNextcloudTalkAccountId,
	clearBaseFields: [
		"botSecret",
		"botSecretFile",
		"baseUrl",
		"name"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({
		allowFrom,
		stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i
	})
});
const nextcloudTalkSecurityAdapter = { resolveDmPolicy: createScopedDmSecurityResolver({
	channelKey: "nextcloud-talk",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => normalizeLowercaseStringOrEmpty(raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, ""))
}) };
const nextcloudTalkPairingTextAdapter = {
	idLabel: "nextcloudUserId",
	message: "OpenClaw: your access has been approved.",
	normalizeAllowEntry: createPairingPrefixStripper(/^(nextcloud-talk|nc-talk|nc):/i, (entry) => normalizeLowercaseStringOrEmpty(entry))
};
//#endregion
//#region extensions/nextcloud-talk/src/config-schema.ts
const NextcloudTalkRoomSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(string()).optional(),
	systemPrompt: string().optional()
}).strict();
const NextcloudTalkNetworkSchema = object({ 
/** Dangerous opt-in for self-hosted Nextcloud Talk on trusted private/internal hosts. */
dangerouslyAllowPrivateNetwork: boolean().optional() }).strict().optional();
const NextcloudTalkAccountSchemaBase = object({
	name: string().optional(),
	enabled: boolean().optional(),
	markdown: MarkdownConfigSchema,
	baseUrl: string().optional(),
	botSecret: buildSecretInputSchema().optional(),
	botSecretFile: string().optional(),
	apiUser: string().optional(),
	apiPassword: buildSecretInputSchema().optional(),
	apiPasswordFile: string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	webhookPort: number().int().positive().optional(),
	webhookHost: string().optional(),
	webhookPath: string().optional(),
	webhookPublicUrl: string().optional(),
	allowFrom: array(string()).optional(),
	groupAllowFrom: array(string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	rooms: record(string(), NextcloudTalkRoomSchema.optional()).optional(),
	/** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
	network: NextcloudTalkNetworkSchema,
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
	accounts: record(string(), NextcloudTalkAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
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
//#region extensions/nextcloud-talk/src/doctor.ts
async function collectNextcloudTalkBotResponseWarnings(params) {
	const warnings = [];
	for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
		const account = resolveNextcloudTalkAccount({
			cfg: params.cfg,
			accountId
		});
		if (!account.enabled || !account.secret || !account.baseUrl) continue;
		const result = await probeNextcloudTalkBotResponseFeature({
			account,
			timeoutMs: 5e3
		});
		if (result.code === "missing_response_feature" || result.code === "bot_not_found" || result.code === "api_error" || result.code === "request_failed") warnings.push(`- channels.nextcloud-talk.${account.accountId}: ${result.message}`);
	}
	return warnings;
}
const nextcloudTalkDoctor = {
	legacyConfigRules,
	normalizeCompatibilityConfig,
	collectPreviewWarnings: async ({ cfg }) => await collectNextcloudTalkBotResponseWarnings({ cfg })
};
//#endregion
//#region extensions/nextcloud-talk/src/policy.ts
function normalizeNextcloudTalkAllowEntry(raw) {
	return raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase();
}
function normalizeNextcloudTalkAllowlist(values) {
	return (values ?? []).map((value) => normalizeNextcloudTalkAllowEntry(String(value))).filter(Boolean);
}
function resolveNextcloudTalkAllowlistMatch(params) {
	const allowFrom = normalizeNextcloudTalkAllowlist(params.allowFrom);
	if (allowFrom.length === 0) return { allowed: false };
	if (allowFrom.includes("*")) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	const senderId = normalizeNextcloudTalkAllowEntry(params.senderId);
	if (allowFrom.includes(senderId)) return {
		allowed: true,
		matchKey: senderId,
		matchSource: "id"
	};
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
	if (!roomToken) return;
	const match = resolveNextcloudTalkRoomMatch({
		rooms: cfg.channels?.["nextcloud-talk"]?.rooms,
		roomToken
	});
	return match.roomConfig?.tools ?? match.wildcardConfig?.tools;
}
function resolveNextcloudTalkRequireMention(params) {
	if (typeof params.roomConfig?.requireMention === "boolean") return params.roomConfig.requireMention;
	if (typeof params.wildcardConfig?.requireMention === "boolean") return params.wildcardConfig.requireMention;
	return true;
}
//#endregion
//#region extensions/nextcloud-talk/src/room-info.ts
const ROOM_CACHE_TTL_MS = 300 * 1e3;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1e3;
const roomCache = /* @__PURE__ */ new Map();
function resolveRoomCacheKey(params) {
	return `${params.accountId}:${params.roomToken}`;
}
function coerceRoomType(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function resolveRoomKindFromType(type) {
	if (!type) return;
	if (type === 1 || type === 5 || type === 6) return "direct";
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
		if (cached.kind && age < ROOM_CACHE_TTL_MS) return cached.kind;
		if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) return;
	}
	const apiCredentials = resolveNextcloudTalkApiCredentials({
		apiUser: account.config.apiUser,
		apiPassword: account.config.apiPassword,
		apiPasswordFile: account.config.apiPasswordFile
	});
	if (!apiCredentials) return;
	const baseUrl = account.baseUrl?.trim();
	if (!baseUrl) return;
	const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`;
	const auth = Buffer.from(`${apiCredentials.apiUser}:${apiCredentials.apiPassword}`, "utf-8").toString("base64");
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
			auditContext: "nextcloud-talk.room-info",
			policy: ssrfPolicyFromPrivateNetworkOptIn(account.config)
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
			const kind = resolveRoomKindFromType(coerceRoomType((await readProviderJsonResponse(response, "Nextcloud Talk room info failed")).ocs?.data?.type));
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
			error: formatErrorMessage(err)
		});
		runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
		return;
	}
}
//#endregion
//#region extensions/nextcloud-talk/src/normalize.ts
function stripNextcloudTalkTargetPrefix(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	let normalized = trimmed;
	if (normalized.startsWith("nextcloud-talk:")) normalized = normalized.slice(15).trim();
	else if (normalized.startsWith("nc-talk:")) normalized = normalized.slice(8).trim();
	else if (normalized.startsWith("nc:")) normalized = normalized.slice(3).trim();
	if (normalized.startsWith("room:")) normalized = normalized.slice(5).trim();
	if (!normalized) return;
	return normalized;
}
function normalizeNextcloudTalkMessagingTarget(raw) {
	const normalized = stripNextcloudTalkTargetPrefix(raw);
	return normalized ? `nextcloud-talk:${normalized}`.toLowerCase() : void 0;
}
function looksLikeNextcloudTalkTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (/^(nextcloud-talk|nc-talk|nc):/i.test(trimmed)) return true;
	return /^[a-z0-9]{8,}$/i.test(trimmed);
}
//#endregion
//#region extensions/nextcloud-talk/src/send.ts
function resolveCredentials(explicit, account) {
	const baseUrl = explicit.baseUrl?.trim() ?? account.baseUrl;
	const secret = explicit.secret?.trim() ?? account.secret;
	if (!baseUrl) throw new Error(`Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk.baseUrl).`);
	if (!secret) throw new Error(`Nextcloud Talk bot secret missing for account "${account.accountId}" (set channels.nextcloud-talk.botSecret/botSecretFile or NEXTCLOUD_TALK_BOT_SECRET for default).`);
	return {
		baseUrl,
		secret
	};
}
function normalizeRoomToken(to) {
	const normalized = stripNextcloudTalkTargetPrefix(to);
	if (!normalized) throw new Error("Room token is required for Nextcloud Talk sends");
	return normalized;
}
function resolveNextcloudTalkSendContext(opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Nextcloud Talk send");
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
function recordNextcloudTalkOutboundActivity(accountId) {
	try {
		getNextcloudTalkRuntime().channel.activity.record({
			channel: "nextcloud-talk",
			accountId,
			direction: "outbound"
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "Nextcloud Talk runtime not initialized") throw error;
	}
}
function createNextcloudTalkSendReceipt(params) {
	const messageId = params.messageId.trim();
	return createMessageReceiptFromOutboundResults({
		results: messageId && messageId !== "unknown" ? [{
			channel: "nextcloud-talk",
			messageId,
			conversationId: params.roomToken
		}] : [],
		kind: "text",
		...params.replyTo ? { replyToId: params.replyTo } : {}
	});
}
async function sendMessageNextcloudTalk(to, text, opts) {
	const { cfg, account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
	const roomToken = normalizeRoomToken(to);
	if (!text?.trim()) throw new Error("Message must be non-empty for Nextcloud Talk sends");
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "nextcloud-talk",
		accountId: account.accountId
	});
	const message = convertMarkdownTables(text.trim(), tableMode);
	const body = { message };
	if (opts.replyTo) body.replyTo = opts.replyTo;
	const bodyStr = JSON.stringify(body);
	const { random, signature } = generateNextcloudTalkSignature({
		body: message,
		secret
	});
	const { response, release } = await fetchWithSsrFGuard({
		url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"OCS-APIRequest": "true",
				"X-Nextcloud-Talk-Bot-Random": random,
				"X-Nextcloud-Talk-Bot-Signature": signature
			},
			body: bodyStr
		},
		auditContext: "nextcloud-talk-send",
		policy: ssrfPolicyFromPrivateNetworkOptIn(account.config)
	});
	try {
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			const status = response.status;
			let errorMsg = `Nextcloud Talk send failed (${status})`;
			if (status === 400) errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
			else if (status === 401) errorMsg = "Nextcloud Talk: bot send was rejected - check the bot secret and ensure the bot was installed with --feature response";
			else if (status === 403) errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";
			else if (status === 404) errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;
			else if (errorBody) errorMsg = `Nextcloud Talk send failed: ${errorBody}`;
			throw new Error(errorMsg);
		}
		let messageId = "unknown";
		let timestamp;
		try {
			const data = await response.json();
			if (data.ocs?.data?.id != null) messageId = String(data.ocs.data.id);
			if (typeof data.ocs?.data?.timestamp === "number") timestamp = data.ocs.data.timestamp;
		} catch {}
		if (opts.verbose) console.log(`[nextcloud-talk] Sent message ${messageId} to room ${roomToken}`);
		recordNextcloudTalkOutboundActivity(account.accountId);
		return {
			messageId,
			roomToken,
			receipt: createNextcloudTalkSendReceipt({
				messageId,
				roomToken,
				...opts.replyTo ? { replyTo: opts.replyTo } : {}
			}),
			timestamp
		};
	} finally {
		await release();
	}
}
async function sendReactionNextcloudTalk(roomToken, messageId, reaction, opts) {
	const { account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
	const normalizedToken = normalizeRoomToken(roomToken);
	const body = JSON.stringify({ reaction });
	const { random, signature } = generateNextcloudTalkSignature({
		body: reaction,
		secret
	});
	const { response, release } = await fetchWithSsrFGuard({
		url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${normalizedToken}/reaction/${messageId}`,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"OCS-APIRequest": "true",
				"X-Nextcloud-Talk-Bot-Random": random,
				"X-Nextcloud-Talk-Bot-Signature": signature
			},
			body
		},
		auditContext: "nextcloud-talk-reaction",
		policy: ssrfPolicyFromPrivateNetworkOptIn(account.config)
	});
	try {
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
		}
		return { ok: true };
	} finally {
		await release();
	}
}
//#endregion
//#region extensions/nextcloud-talk/src/inbound.ts
const CHANNEL_ID = "nextcloud-talk";
function hasAllowEntries(entries) {
	return normalizeNextcloudTalkAllowlist(entries).length > 0;
}
function roomRoutes(params) {
	if (!params.isGroup) return [];
	const roomSenderConfigured = params.groupPolicy === "allowlist" && hasAllowEntries(params.roomAllowFrom);
	return channelIngressRoutes(params.roomMatch.allowlistConfigured && {
		id: "nextcloud-talk:room",
		allowed: params.roomMatch.allowed,
		precedence: 0,
		matchId: "nextcloud-talk-room",
		blockReason: "room_not_allowlisted"
	}, params.roomConfig?.enabled === false && {
		id: "nextcloud-talk:room-enabled",
		enabled: false,
		precedence: 10,
		blockReason: "room_disabled"
	}, roomSenderConfigured && {
		id: "nextcloud-talk:room-sender",
		kind: "nestedAllowlist",
		precedence: 20,
		blockReason: "room_sender_not_allowlisted",
		...!hasAllowEntries(params.outerGroupAllowFrom) ? {
			senderPolicy: "replace",
			senderAllowFrom: params.roomAllowFrom
		} : {
			allowed: resolveNextcloudTalkAllowlistMatch({
				allowFrom: params.roomAllowFrom,
				senderId: params.senderId
			}).allowed,
			matchId: "nextcloud-talk-room-sender"
		}
	});
}
async function deliverNextcloudTalkReply(params) {
	const { cfg, payload, roomToken, accountId, statusSink } = params;
	await deliverFormattedTextWithAttachments({
		payload,
		send: async ({ text, replyToId }) => {
			await sendMessageNextcloudTalk(roomToken, text, {
				cfg,
				accountId,
				replyTo: replyToId
			});
			statusSink?.({ lastOutboundAt: Date.now() });
		}
	});
}
async function handleNextcloudTalkInbound(params) {
	const { message, account, config, runtime, statusSink } = params;
	const core = getNextcloudTalkRuntime();
	const pairing = createChannelPairingController({
		core,
		channel: CHANNEL_ID,
		accountId: account.accountId
	});
	const rawBody = message.text?.trim() ?? "";
	if (!rawBody) return;
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
	const roomMatch = resolveNextcloudTalkRoomMatch({
		rooms: account.config.rooms,
		roomToken
	});
	const roomConfig = roomMatch.roomConfig;
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg: config,
		surface: CHANNEL_ID
	});
	const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
	const shouldRequireMention = isGroup ? resolveNextcloudTalkRequireMention({
		roomConfig,
		wildcardConfig: roomMatch.wildcardConfig
	}) : false;
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: (config.channels?.[CHANNEL_ID] ?? void 0) !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy: resolveDefaultGroupPolicy(config)
	});
	const allowFrom = normalizeStringEntries(account.config.allowFrom);
	const outerGroupAllowFrom = account.config.groupAllowFrom?.length ? normalizeStringEntries(account.config.groupAllowFrom) : allowFrom;
	const roomAllowFrom = normalizeStringEntries(roomConfig?.allowFrom);
	const resolveAccess = async (wasMentioned) => await resolveStableChannelMessageIngress({
		channelId: CHANNEL_ID,
		accountId: account.accountId,
		identity: {
			key: "nextcloud-talk-user-id",
			normalize: (value) => normalizeNextcloudTalkAllowEntry(value) || null,
			sensitivity: "pii",
			entryIdPrefix: "nextcloud-talk-entry"
		},
		cfg: config,
		readStoreAllowFrom: async () => await pairing.readStoreForDmPolicy(CHANNEL_ID, account.accountId),
		subject: { stableId: senderId },
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: isGroup ? roomToken : senderId
		},
		route: roomRoutes({
			isGroup,
			groupPolicy,
			roomMatch,
			roomConfig,
			senderId,
			outerGroupAllowFrom,
			roomAllowFrom
		}),
		dmPolicy: account.config.dmPolicy ?? "pairing",
		groupPolicy,
		policy: {
			groupAllowFromFallbackToAllowFrom: true,
			activation: {
				requireMention: isGroup && shouldRequireMention,
				allowTextCommands
			}
		},
		mentionFacts: isGroup && wasMentioned !== void 0 ? {
			canDetectMention: true,
			wasMentioned,
			hasAnyMention: wasMentioned
		} : void 0,
		allowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		command: {
			allowTextCommands,
			hasControlCommand
		}
	});
	let access = await resolveAccess();
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "nextcloud-talk",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
		log: (message) => runtime.log?.(message)
	});
	const commandAuthorized = access.commandAccess.authorized;
	const accessReason = access.ingress.reasonCode === "route_blocked" ? "route blocked" : access.senderAccess.reasonCode;
	if (isGroup) {
		if (access.routeAccess.reason === "room_not_allowlisted") {
			runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
			return;
		}
		if (access.routeAccess.reason === "room_disabled") {
			runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
			return;
		}
		if (access.routeAccess.reason === "room_sender_not_allowlisted") {
			runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
			return;
		}
		if (access.senderAccess.decision !== "allow") {
			runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${accessReason})`);
			return;
		}
	} else if (access.senderAccess.decision !== "allow") {
		if (access.senderAccess.decision === "pairing") await pairing.issueChallenge({
			senderId,
			senderIdLine: `Your Nextcloud user id: ${senderId}`,
			meta: { name: senderName || void 0 },
			sendPairingReply: async (text) => {
				await sendMessageNextcloudTalk(roomToken, text, {
					cfg: config,
					accountId: account.accountId
				});
				statusSink?.({ lastOutboundAt: Date.now() });
			},
			onReplyError: (err) => {
				runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
			}
		});
		runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${accessReason})`);
		return;
	}
	if (access.commandAccess.shouldBlockControlCommand) {
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
	if (isGroup) access = await resolveAccess(wasMentioned);
	if (isGroup && access.activationAccess.shouldSkip) {
		runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
		return;
	}
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: isGroup ? roomToken : senderId
		},
		runtime: core.channel,
		sessionStore: config.session?.store
	});
	const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
	const { storePath, body } = buildEnvelope({
		channel: "Nextcloud Talk",
		from: fromLabel,
		timestamp: message.timestamp,
		body: rawBody
	});
	const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);
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
	await core.channel.turn.runAssembled({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
			deliver: async (payload) => {
				await deliverNextcloudTalkReply({
					cfg: config,
					payload,
					roomToken,
					accountId: account.accountId,
					statusSink
				});
			},
			onError: (err, info) => {
				runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyPipeline: {},
		replyOptions: {
			skillFilter: roomConfig?.skills,
			disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
		},
		record: { onRecordError: (err) => {
			runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
		} }
	});
}
//#endregion
//#region extensions/nextcloud-talk/src/monitor.ts
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5e3;
const HEALTH_PATH = "/healthz";
const WEBHOOK_AUTH_RATE_LIMIT_SCOPE = "nextcloud-talk-webhook-auth";
const NextcloudTalkWebhookPayloadSchema = object({
	type: _enum([
		"Create",
		"Update",
		"Delete"
	]),
	actor: object({
		type: literal("Person"),
		id: string().min(1),
		name: string()
	}),
	object: object({
		type: literal("Note"),
		id: string().min(1),
		name: string(),
		content: string(),
		mediaType: string()
	}),
	target: object({
		type: literal("Collection"),
		id: string().min(1),
		name: string()
	})
});
const WEBHOOK_ERRORS = {
	missingSignatureHeaders: "Missing signature headers",
	invalidBackend: "Invalid backend",
	invalidSignature: "Invalid signature",
	invalidPayloadFormat: "Invalid payload format",
	payloadTooLarge: "Payload too large",
	internalServerError: "Internal server error"
};
var NextcloudTalkRetryableWebhookError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "NextcloudTalkRetryableWebhookError";
	}
};
async function processNextcloudTalkReplayGuardedMessage(params) {
	if (await params.replayGuard.claimMessage({
		accountId: params.accountId,
		roomToken: params.message.roomToken,
		messageId: params.message.messageId
	}) !== "claimed") return "duplicate";
	try {
		await params.handleMessage();
		await params.replayGuard.commitMessage({
			accountId: params.accountId,
			roomToken: params.message.roomToken,
			messageId: params.message.messageId
		});
		return "processed";
	} catch (error) {
		if (error instanceof NextcloudTalkRetryableWebhookError) params.replayGuard.releaseMessage({
			accountId: params.accountId,
			roomToken: params.message.roomToken,
			messageId: params.message.messageId,
			error
		});
		else await params.replayGuard.commitMessage({
			accountId: params.accountId,
			roomToken: params.message.roomToken,
			messageId: params.message.messageId
		});
		throw error;
	}
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : JSON.stringify(err);
}
function parseWebhookPayload(body) {
	return safeParseJsonWithSchema(NextcloudTalkWebhookPayloadSchema, body);
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
	if (res.headersSent) return;
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
		params.authRateLimiter.recordFailure(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
		writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
		return false;
	}
	params.authRateLimiter.reset(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
	return true;
}
function decodeWebhookCreateMessage(params) {
	const payload = parseWebhookPayload(params.body);
	if (!payload) {
		writeWebhookError(params.res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
		return { kind: "invalid" };
	}
	if (payload.type !== "Create") return { kind: "ignore" };
	return {
		kind: "message",
		message: payloadToInboundMessage(payload)
	};
}
function payloadToInboundMessage(payload) {
	return {
		messageId: payload.object.id,
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
	const processMessage = opts.processMessage;
	const authRateLimitMaxRequests = typeof opts.authRateLimit?.maxRequests === "number" ? opts.authRateLimit.maxRequests : WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests;
	const authRateLimitWindowMs = typeof opts.authRateLimit?.windowMs === "number" ? opts.authRateLimit.windowMs : WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs;
	const webhookAuthRateLimiter = createAuthRateLimiter({
		maxAttempts: authRateLimitMaxRequests,
		windowMs: authRateLimitWindowMs,
		lockoutMs: authRateLimitWindowMs,
		exemptLoopback: false,
		pruneIntervalMs: authRateLimitWindowMs
	});
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
		const clientIp = req.socket.remoteAddress ?? "unknown";
		if (!webhookAuthRateLimiter.check(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE).allowed) {
			res.writeHead(429);
			res.end("Too Many Requests");
			return;
		}
		try {
			const headers = validateWebhookHeaders({
				req,
				res,
				isBackendAllowed
			});
			if (!headers) return;
			const body = await readBody(req, maxBodyBytes);
			if (!verifyWebhookSignature({
				headers,
				body,
				secret,
				res,
				clientIp,
				authRateLimiter: webhookAuthRateLimiter
			})) return;
			const decoded = decodeWebhookCreateMessage({
				body,
				res
			});
			if (decoded.kind === "invalid") return;
			if (decoded.kind === "ignore") {
				writeJsonResponse(res, 200);
				return;
			}
			const message = decoded.message;
			if (processMessage) {
				writeJsonResponse(res, 200);
				try {
					await processMessage(message);
				} catch (err) {
					onError?.(err instanceof Error ? err : new Error(formatError(err)));
				}
				return;
			}
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
		if (stopped) return;
		stopped = true;
		try {
			server.close();
		} catch {}
	};
	if (abortSignal) if (abortSignal.aborted) stop();
	else abortSignal.addEventListener("abort", stop, { once: true });
	return {
		server,
		start,
		stop
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/replay-guard.ts
const DEFAULT_REPLAY_TTL_MS = 1440 * 60 * 1e3;
const DEFAULT_MEMORY_MAX_SIZE = 1e3;
const DEFAULT_FILE_MAX_ENTRIES = 1e4;
function sanitizeSegment(value) {
	const trimmed = value.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function buildReplayKey(params) {
	const roomToken = params.roomToken.trim();
	const messageId = params.messageId.trim();
	if (!roomToken || !messageId) return null;
	return `${roomToken}:${messageId}`;
}
function createNextcloudTalkReplayGuard(options) {
	const stateDir = options.stateDir?.trim();
	const baseOptions = {
		ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
		memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE
	};
	const dedupe = createClaimableDedupe(stateDir ? {
		...baseOptions,
		fileMaxEntries: options.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES,
		resolveFilePath: (namespace) => path.join(stateDir, "nextcloud-talk", "replay-dedupe", `${sanitizeSegment(namespace)}.json`),
		onDiskError: options.onDiskError
	} : baseOptions);
	return {
		claimMessage: async ({ accountId, roomToken, messageId }) => {
			const replayKey = buildReplayKey({
				roomToken,
				messageId
			});
			if (!replayKey) return "invalid";
			return (await dedupe.claim(replayKey, { namespace: accountId })).kind;
		},
		commitMessage: async ({ accountId, roomToken, messageId }) => {
			const replayKey = buildReplayKey({
				roomToken,
				messageId
			});
			if (!replayKey) return true;
			return await dedupe.commit(replayKey, { namespace: accountId });
		},
		releaseMessage: ({ accountId, roomToken, messageId, error }) => {
			const replayKey = buildReplayKey({
				roomToken,
				messageId
			});
			if (!replayKey) return;
			dedupe.release(replayKey, {
				namespace: accountId,
				error
			});
		},
		shouldProcessMessage: async ({ accountId, roomToken, messageId }) => {
			const replayKey = buildReplayKey({
				roomToken,
				messageId
			});
			if (!replayKey) return true;
			if ((await dedupe.claim(replayKey, { namespace: accountId })).kind !== "claimed") return false;
			return await dedupe.commit(replayKey, { namespace: accountId });
		}
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/monitor-runtime.ts
const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";
function normalizeOrigin(value) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(value).origin);
	} catch {
		return null;
	}
}
async function monitorNextcloudTalkProvider(opts) {
	const core = getNextcloudTalkRuntime();
	const cfg = opts.config ?? core.config.current();
	const account = resolveNextcloudTalkAccount({
		cfg,
		accountId: opts.accountId
	});
	const runtime = resolveLoggerBackedRuntime(opts.runtime, core.logging.getChildLogger());
	if (!account.secret) throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);
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
			if (!expectedBackendOrigin) return true;
			return normalizeOrigin(backend) === expectedBackendOrigin;
		},
		processMessage: async (message) => {
			if (await processNextcloudTalkReplayGuardedMessage({
				replayGuard,
				accountId: account.accountId,
				message,
				handleMessage: async () => {
					core.channel.activity.record({
						channel: "nextcloud-talk",
						accountId: account.accountId,
						direction: "inbound",
						at: message.timestamp
					});
					if (opts.onMessage) await opts.onMessage(message);
					else await handleNextcloudTalkInbound({
						message,
						account,
						config: cfg,
						runtime,
						statusSink: opts.statusSink
					});
				}
			}) === "duplicate") {
				logger.warn(`[nextcloud-talk:${account.accountId}] replayed webhook ignored room=${message.roomToken} messageId=${message.messageId}`);
				return;
			}
		},
		onMessage: async () => {},
		onError: (error) => {
			logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
		},
		abortSignal: opts.abortSignal
	});
	if (opts.abortSignal?.aborted) return { stop };
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
//#region extensions/nextcloud-talk/src/gateway.ts
const nextcloudTalkGatewayAdapter = {
	startAccount: async (ctx) => {
		const account = ctx.account;
		if (!account.secret || !account.baseUrl) throw new Error(`Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`);
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
				if (accountCleanup.cleared) cleared = true;
				if (accountCleanup.nextAccounts) nextSection.accounts = accountCleanup.nextAccounts;
				else delete nextSection.accounts;
			}
		}
		if (changed) if (nextSection && Object.keys(nextSection).length > 0) nextCfg.channels = {
			...nextCfg.channels,
			"nextcloud-talk": nextSection
		};
		else {
			const nextChannels = { ...nextCfg.channels };
			delete nextChannels["nextcloud-talk"];
			if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
			else delete nextCfg.channels;
		}
		const loggedOut = resolveNextcloudTalkAccount({
			cfg: changed ? nextCfg : cfg,
			accountId
		}).secretSource === "none";
		if (changed) await getNextcloudTalkRuntime().config.replaceConfigFile({
			nextConfig: nextCfg,
			afterWrite: { mode: "auto" }
		});
		return {
			cleared,
			envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
			loggedOut
		};
	}
};
//#endregion
//#region extensions/nextcloud-talk/src/message-actions.ts
const providerId = "nextcloud-talk";
function isAccountConfigured(account) {
	return Boolean(account.enabled && account.secret?.trim() && account.baseUrl?.trim());
}
function hasConfiguredAccount(cfg, accountId) {
	if (accountId) return isAccountConfigured(resolveNextcloudTalkAccount({
		cfg,
		accountId
	}));
	return listNextcloudTalkAccountIds(cfg).map((id) => resolveNextcloudTalkAccount({
		cfg,
		accountId: id
	})).some(isAccountConfigured);
}
const nextcloudTalkMessageActions = {
	describeMessageTool: ({ cfg, accountId }) => {
		if (!hasConfiguredAccount(cfg, accountId)) return null;
		return { actions: ["send", "react"] };
	},
	supportsAction: ({ action }) => action !== "send",
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		if (action === "send") throw new Error("Send should be handled by outbound, not actions handler.");
		if (action === "react") {
			const target = readStringParam(params, "to", {
				required: true,
				label: "to (room token)"
			});
			const messageIdRaw = resolveReactionMessageId({
				args: params,
				toolContext
			});
			if (messageIdRaw == null) throw new Error("messageId required");
			const messageId = String(messageIdRaw);
			const emoji = readStringParam(params, "emoji", { required: true });
			if (params.remove === true) throw new Error("Nextcloud Talk reaction removal is not supported yet; only adding reactions is implemented.");
			await sendReactionNextcloudTalk(target, messageId, emoji, {
				accountId: accountId ?? void 0,
				cfg
			});
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		throw new Error(`Action ${action} not supported for ${providerId}.`);
	}
};
//#endregion
//#region extensions/nextcloud-talk/src/message-adapter.ts
const nextcloudTalkMessageAdapter = defineChannelMessageAdapter({
	id: "nextcloud-talk",
	durableFinal: { capabilities: {
		text: true,
		media: true,
		replyTo: true
	} },
	send: {
		text: async ({ cfg, to, text, accountId, replyToId }) => await sendMessageNextcloudTalk(to, text, {
			accountId: accountId ?? void 0,
			replyTo: replyToId ?? void 0,
			cfg
		}),
		media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => await sendMessageNextcloudTalk(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
			accountId: accountId ?? void 0,
			replyTo: replyToId ?? void 0,
			cfg
		})
	}
});
//#endregion
//#region extensions/nextcloud-talk/src/session-route.ts
function resolveNextcloudTalkOutboundSessionRoute(params) {
	const roomId = stripNextcloudTalkTargetPrefix(params.target);
	if (!roomId) return null;
	const baseSessionKey = buildOutboundBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "nextcloud-talk",
		accountId: params.accountId,
		peer: {
			kind: "group",
			id: roomId
		}
	});
	return {
		sessionKey: baseSessionKey,
		baseSessionKey,
		peer: {
			kind: "group",
			id: roomId
		},
		chatType: "group",
		from: `nextcloud-talk:room:${roomId}`,
		to: `nextcloud-talk:${roomId}`
	};
}
//#endregion
//#region extensions/nextcloud-talk/src/setup-core.ts
const t$1 = createSetupTranslator();
const channel$1 = "nextcloud-talk";
function addWildcardAllowFrom(allowFrom) {
	return mergeAllowFromEntries(allowFrom, ["*"]);
}
function normalizeNextcloudTalkBaseUrl(value) {
	return value?.trim().replace(/\/+$/, "") ?? "";
}
function validateNextcloudTalkBaseUrl(value) {
	if (!value) return "Required";
	if (!value.startsWith("http://") && !value.startsWith("https://")) return "URL must start with http:// or https://";
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
	if (!section) return cfg;
	if (accountId === "default") {
		const nextSection = { ...section };
		for (const field of fields) delete nextSection[field];
		return {
			...cfg,
			channels: {
				...cfg.channels,
				"nextcloud-talk": nextSection
			}
		};
	}
	const currentAccount = section.accounts?.[accountId];
	if (!currentAccount) return cfg;
	const nextAccount = { ...currentAccount };
	for (const field of fields) delete nextAccount[field];
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
async function promptNextcloudTalkAllowFrom(params) {
	return await promptParsedAllowFromForAccount({
		cfg: params.cfg,
		accountId: params.accountId,
		defaultAccountId: params.accountId,
		prompter: params.prompter,
		noteTitle: t$1("wizard.nextcloudTalk.userIdTitle"),
		noteLines: [
			t$1("wizard.nextcloudTalk.userIdHelpAdmin"),
			t$1("wizard.nextcloudTalk.userIdHelpLogs"),
			t$1("wizard.nextcloudTalk.userIdHelpLowercase"),
			t$1("wizard.channels.docs", { link: formatDocsLink("/channels/nextcloud-talk", "nextcloud-talk") })
		],
		message: t$1("wizard.nextcloudTalk.allowFromPrompt"),
		placeholder: "username",
		parseEntries: (raw) => ({ entries: raw.split(/[\n,;]+/g).map(normalizeLowercaseStringOrEmpty).filter(Boolean) }),
		getExistingAllowFrom: ({ cfg, accountId }) => resolveNextcloudTalkAccount({
			cfg,
			accountId
		}).config.allowFrom ?? [],
		mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing.map((value) => normalizeLowercaseStringOrEmpty(String(value))), parsed),
		applyAllowFrom: ({ cfg, accountId, allowFrom }) => setNextcloudTalkAccountConfig(cfg, accountId, {
			dmPolicy: "allowlist",
			allowFrom
		})
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
	channel: channel$1,
	policyKey: "channels.nextcloud-talk.dmPolicy",
	allowFromKey: "channels.nextcloud-talk.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultNextcloudTalkAccountId(cfg)) !== "default" ? {
		policyKey: `channels.nextcloud-talk.accounts.${accountId ?? resolveDefaultNextcloudTalkAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.nextcloud-talk.accounts.${accountId ?? resolveDefaultNextcloudTalkAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.nextcloud-talk.dmPolicy",
		allowFromKey: "channels.nextcloud-talk.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveNextcloudTalkAccount({
		cfg,
		accountId: accountId ?? resolveDefaultNextcloudTalkAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => {
		const resolvedAccountId = accountId ?? resolveDefaultNextcloudTalkAccountId(cfg);
		const resolved = resolveNextcloudTalkAccount({
			cfg,
			accountId: resolvedAccountId
		});
		return setNextcloudTalkAccountConfig(cfg, resolvedAccountId, {
			dmPolicy: policy,
			...policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}
		});
	},
	promptAllowFrom: promptNextcloudTalkAllowFromForAccount
};
const nextcloudTalkSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: createSetupInputPresenceValidator({
		defaultAccountOnlyEnvError: "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.",
		validate: ({ input }) => {
			const setupInput = input;
			if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";
			if (!setupInput.baseUrl) return "Nextcloud Talk requires --base-url.";
			return null;
		}
	}),
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
const t = createSetupTranslator();
const channel = "nextcloud-talk";
const CONFIGURE_API_FLAG = "__nextcloudTalkConfigureApiCredentials";
const nextcloudTalkSetupWizard = {
	channel,
	stepOrder: "text-first",
	status: createStandardChannelSetupStatus({
		channelLabel: "Nextcloud Talk",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusSelfHostedChat"),
		configuredScore: 1,
		unconfiguredScore: 5,
		resolveConfigured: ({ cfg, accountId }) => {
			const account = resolveNextcloudTalkAccount({
				cfg,
				accountId
			});
			return Boolean(account.secret && account.baseUrl);
		}
	}),
	introNote: {
		title: t("wizard.nextcloudTalk.setupTitle"),
		lines: [
			t("wizard.nextcloudTalk.helpSsh"),
			t("wizard.nextcloudTalk.helpInstallCommand"),
			t("wizard.nextcloudTalk.helpCopySecret"),
			t("wizard.nextcloudTalk.helpEnableRoom"),
			t("wizard.nextcloudTalk.helpEnvTip"),
			t("wizard.channels.docs", { link: formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk") })
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
			message: t("wizard.nextcloudTalk.configureApiCredentials"),
			initialValue: hasApiCredentials
		})) return;
		return { credentialValues: {
			...credentialValues,
			[CONFIGURE_API_FLAG]: "1"
		} };
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: t("wizard.nextcloudTalk.botSecret"),
		preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
		envPrompt: t("wizard.nextcloudTalk.botSecretEnvPrompt"),
		keepPrompt: t("wizard.nextcloudTalk.botSecretKeep"),
		inputPrompt: t("wizard.nextcloudTalk.botSecretInput"),
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
				envValue: accountId === "default" ? normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET) : void 0
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
		credentialLabel: t("wizard.nextcloudTalk.apiPassword"),
		preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
		envPrompt: "",
		keepPrompt: t("wizard.nextcloudTalk.apiPasswordKeep"),
		inputPrompt: t("wizard.nextcloudTalk.apiPasswordInput"),
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
		message: t("wizard.nextcloudTalk.instanceUrlPrompt"),
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
		message: t("wizard.nextcloudTalk.apiUserPrompt"),
		currentValue: ({ cfg, accountId }) => resolveNextcloudTalkAccount({
			cfg,
			accountId
		}).config.apiUser?.trim() || void 0,
		shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
		validate: ({ value }) => value ? void 0 : t("common.required"),
		applySet: async (params) => setNextcloudTalkAccountConfig(params.cfg, params.accountId, { apiUser: params.value })
	}],
	dmPolicy: nextcloudTalkDmPolicy,
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
//#region extensions/nextcloud-talk/src/channel.ts
const meta = {
	id: "nextcloud-talk",
	label: "Nextcloud Talk",
	selectionLabel: "Nextcloud Talk (self-hosted)",
	docsPath: "/channels/nextcloud-talk",
	docsLabel: "nextcloud-talk",
	blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
	aliases: ["nc-talk", "nc"],
	order: 65,
	quickstartAllowFrom: true
};
const collectNextcloudTalkSecurityWarnings = createAllowlistProviderRouteAllowlistWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.["nextcloud-talk"] !== void 0,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	resolveRouteAllowlistConfigured: (account) => Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
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
});
const nextcloudTalkPlugin = createChatChannelPlugin({
	base: {
		id: "nextcloud-talk",
		meta,
		setupWizard: nextcloudTalkSetupWizard,
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
			...nextcloudTalkConfigAdapter,
			isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
			describeAccount: (account) => describeWebhookAccountSnapshot({
				account,
				configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
				extra: {
					secretSource: account.secretSource,
					baseUrl: account.baseUrl ? "[set]" : "[missing]"
				}
			})
		},
		approvalCapability: nextcloudTalkApprovalAuth,
		doctor: nextcloudTalkDoctor,
		groups: {
			resolveRequireMention: ({ cfg, accountId, groupId }) => {
				const rooms = resolveNextcloudTalkAccount({
					cfg,
					accountId
				}).config.rooms;
				if (!rooms || !groupId) return true;
				const roomConfig = rooms[groupId];
				if (roomConfig?.requireMention !== void 0) return roomConfig.requireMention;
				const wildcardConfig = rooms["*"];
				if (wildcardConfig?.requireMention !== void 0) return wildcardConfig.requireMention;
				return true;
			},
			resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy
		},
		messaging: {
			targetPrefixes: [
				"nextcloud-talk",
				"nc-talk",
				"nc"
			],
			normalizeTarget: normalizeNextcloudTalkMessagingTarget,
			resolveOutboundSessionRoute: (params) => resolveNextcloudTalkOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: looksLikeNextcloudTalkTargetId,
				hint: "<roomToken>"
			}
		},
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		setup: nextcloudTalkSetupAdapter,
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			buildChannelSummary: ({ snapshot }) => buildWebhookChannelStatusSummary(snapshot, { secretSource: snapshot.secretSource ?? "none" }),
			collectStatusIssues: (accounts) => accounts.flatMap((account) => {
				const probe = account.probe;
				if (!probe || probe.ok !== false || probe.code !== "missing_response_feature" || !probe.message) return [];
				return [{
					channel: "nextcloud-talk",
					accountId: account.accountId ?? "default",
					kind: "config",
					message: probe.message,
					fix: "Add --feature response to the Talk bot."
				}];
			}),
			probeAccount: async ({ account, timeoutMs }) => await probeNextcloudTalkBotResponseFeature({
				account,
				timeoutMs
			}),
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
				extra: {
					secretSource: account.secretSource,
					baseUrl: account.baseUrl ? "[set]" : "[missing]",
					mode: "webhook"
				}
			})
		}),
		gateway: nextcloudTalkGatewayAdapter,
		message: nextcloudTalkMessageAdapter,
		actions: nextcloudTalkMessageActions
	},
	pairing: { text: {
		...nextcloudTalkPairingTextAdapter,
		notify: createLoggedPairingApprovalNotifier(({ id }) => `[nextcloud-talk] User ${id} approved for pairing`)
	} },
	security: {
		...nextcloudTalkSecurityAdapter,
		collectWarnings: collectNextcloudTalkSecurityWarnings
	},
	outbound: {
		base: {
			deliveryMode: "direct",
			chunker: (text, limit) => getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
			chunkerMode: "markdown",
			textChunkLimit: 4e3
		},
		attachedResults: {
			channel: "nextcloud-talk",
			sendText: async ({ cfg, to, text, accountId, replyToId }) => await nextcloudTalkMessageAdapter.send.text({
				cfg,
				to,
				text,
				accountId,
				replyToId
			}),
			sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => await nextcloudTalkMessageAdapter.send.media({
				cfg,
				to,
				text,
				mediaUrl: mediaUrl ?? "",
				accountId,
				replyToId
			})
		}
	}
});
//#endregion
export { nextcloudTalkPlugin as t };
