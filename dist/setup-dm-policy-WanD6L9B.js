import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as normalizeSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as applyAccountNameToChannelSection } from "./setup-helpers-BC9z9VvG.js";
import "./routing-79DRZvfm.js";
import { t as addWildcardAllowFrom, y as normalizeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import { r as resolveMatrixEnvAuthReadiness } from "./env-auth-RoZX59IM.js";
import { n as updateMatrixAccountConfig } from "./config-update-yy_QFIrd.js";
import { i as isSupportedMatrixAvatarSource } from "./profile-BO10xyfU.js";
//#region extensions/matrix/src/setup-contract.ts
const matrixSingleAccountKeysToMove = [
	"deviceId",
	"avatarUrl",
	"initialSyncLimit",
	"encryption",
	"allowlistOnly",
	"dangerouslyAllowNameMatching",
	"allowBots",
	"blockStreaming",
	"replyToMode",
	"threadReplies",
	"textChunkLimit",
	"chunkMode",
	"responsePrefix",
	"ackReaction",
	"ackReactionScope",
	"reactionNotifications",
	"threadBindings",
	"startupVerification",
	"startupVerificationCooldownHours",
	"mediaMaxMb",
	"autoJoin",
	"autoJoinAllowlist",
	"dm",
	"groups",
	"rooms",
	"actions"
];
const matrixNamedAccountPromotionKeys = [
	"name",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceId",
	"deviceName",
	"avatarUrl",
	"initialSyncLimit",
	"encryption"
];
const singleAccountKeysToMove = [...matrixSingleAccountKeysToMove];
const namedAccountPromotionKeys = [...matrixNamedAccountPromotionKeys];
function resolveSingleAccountPromotionTarget(params) {
	const accounts = typeof params.channel.accounts === "object" && params.channel.accounts ? params.channel.accounts : {};
	const normalizedDefaultAccount = typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim() ? normalizeAccountId(params.channel.defaultAccount) : void 0;
	const matchedAccountId = normalizedDefaultAccount ? Object.entries(accounts).find(([accountId, value]) => accountId && value && typeof value === "object" && normalizeAccountId(accountId) === normalizedDefaultAccount)?.[0] : void 0;
	if (matchedAccountId) return matchedAccountId;
	if (normalizedDefaultAccount) return DEFAULT_ACCOUNT_ID;
	const namedAccounts = Object.entries(accounts).filter(([accountId, value]) => accountId && typeof value === "object" && value);
	if (namedAccounts.length === 1) return namedAccounts[0][0];
	if (namedAccounts.length > 1 && accounts["default"] && typeof accounts["default"] === "object") return DEFAULT_ACCOUNT_ID;
	return DEFAULT_ACCOUNT_ID;
}
//#endregion
//#region extensions/matrix/src/setup-config.ts
const channel = "matrix";
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"enabled",
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
const MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set(matrixSingleAccountKeysToMove);
const MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS = new Set(matrixNamedAccountPromotionKeys);
function cloneIfObject(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function resolveSetupAvatarUrl(input) {
	const avatarUrl = input.avatarUrl;
	if (typeof avatarUrl !== "string") return;
	return avatarUrl.trim() || void 0;
}
function resolveExistingMatrixAccountKey(accounts, targetAccountId) {
	const normalizedTargetAccountId = normalizeAccountId(targetAccountId);
	return Object.keys(accounts).find((accountId) => normalizeAccountId(accountId) === normalizedTargetAccountId) ?? targetAccountId;
}
function moveSingleMatrixAccountConfigToNamedAccount(cfg) {
	const baseConfig = cfg.channels?.[channel];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!base) return cfg;
	const accounts = typeof base.accounts === "object" && base.accounts ? base.accounts : {};
	const hasNamedAccounts = Object.keys(accounts).some(Boolean);
	const keysToMove = Object.entries(base).filter(([key, value]) => {
		if (key === "accounts" || key === "enabled" || value === void 0) return false;
		if (!COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key) && !MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key)) return false;
		if (hasNamedAccounts && !MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS.has(key)) return false;
		return true;
	}).map(([key]) => key);
	if (keysToMove.length === 0) return cfg;
	const resolvedTargetAccountId = resolveExistingMatrixAccountKey(accounts, resolveSingleAccountPromotionTarget({ channel: base }));
	const nextAccount = { ...accounts[resolvedTargetAccountId] };
	for (const key of keysToMove) nextAccount[key] = cloneIfObject(base[key]);
	const nextChannel = { ...base };
	for (const key of keysToMove) delete nextChannel[key];
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...nextChannel,
				accounts: {
					...accounts,
					[resolvedTargetAccountId]: nextAccount
				}
			}
		}
	};
}
function validateMatrixSetupInput(params) {
	const avatarUrl = resolveSetupAvatarUrl(params.input);
	if (avatarUrl && !isSupportedMatrixAvatarSource(avatarUrl)) return "Matrix avatar URL must be an mxc:// URI or an http(s) URL.";
	if (params.input.useEnv) {
		const envReadiness = resolveMatrixEnvAuthReadiness(params.accountId, process.env);
		return envReadiness.ready ? null : envReadiness.missingMessage;
	}
	if (!params.input.homeserver?.trim()) return "Matrix requires --homeserver";
	const accessToken = params.input.accessToken?.trim();
	const password = normalizeSecretInputString(params.input.password);
	const userId = params.input.userId?.trim();
	if (!accessToken && !password) return "Matrix requires --access-token or --password";
	if (!accessToken) {
		if (!userId) return "Matrix requires --user-id when using --password";
		if (!password) return "Matrix requires --password when using --user-id";
	}
	return null;
}
function applyMatrixSetupAccountConfig(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const next = applyAccountNameToChannelSection({
		cfg: normalizedAccountId !== "default" ? moveSingleMatrixAccountConfigToNamedAccount(params.cfg) : params.cfg,
		channelKey: channel,
		accountId: normalizedAccountId,
		name: params.input.name
	});
	const avatarUrl = resolveSetupAvatarUrl(params.input);
	if (params.input.useEnv) return updateMatrixAccountConfig(next, normalizedAccountId, {
		enabled: true,
		homeserver: null,
		allowPrivateNetwork: null,
		proxy: null,
		userId: null,
		accessToken: null,
		password: null,
		deviceId: null,
		deviceName: null,
		avatarUrl
	});
	const accessToken = params.input.accessToken?.trim();
	const password = normalizeSecretInputString(params.input.password);
	const userId = params.input.userId?.trim();
	return updateMatrixAccountConfig(next, normalizedAccountId, {
		enabled: true,
		homeserver: params.input.homeserver?.trim(),
		allowPrivateNetwork: typeof params.input.dangerouslyAllowPrivateNetwork === "boolean" ? params.input.dangerouslyAllowPrivateNetwork : typeof params.input.allowPrivateNetwork === "boolean" ? params.input.allowPrivateNetwork : void 0,
		proxy: normalizeOptionalString(params.input.proxy),
		userId: password && !userId ? null : userId,
		accessToken: accessToken || (password ? null : void 0),
		password: password || (accessToken ? null : void 0),
		deviceName: params.input.deviceName?.trim(),
		avatarUrl,
		initialSyncLimit: params.input.initialSyncLimit
	});
}
//#endregion
//#region extensions/matrix/src/setup-dm-policy.ts
function resolveMatrixSetupDmAllowFrom(policy, allowFrom) {
	if (policy === "open") return addWildcardAllowFrom(allowFrom);
	return normalizeAllowFromEntries(allowFrom ?? []).filter((entry) => entry !== "*");
}
//#endregion
export { namedAccountPromotionKeys as a, validateMatrixSetupInput as i, applyMatrixSetupAccountConfig as n, resolveSingleAccountPromotionTarget as o, moveSingleMatrixAccountConfigToNamedAccount as r, singleAccountKeysToMove as s, resolveMatrixSetupDmAllowFrom as t };
