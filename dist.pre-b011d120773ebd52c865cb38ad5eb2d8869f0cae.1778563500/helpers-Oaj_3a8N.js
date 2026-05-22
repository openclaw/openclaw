import { t as formatCliCommand } from "./command-format-ut6bcRZg.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-Bj7l9NI7.js";
//#region src/channels/plugins/helpers.ts
function resolveChannelDefaultAccountId(params) {
	const accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
	return params.plugin.config.defaultAccountId?.(params.cfg) ?? accountIds[0] ?? "default";
}
function formatPairingApproveHint(channelId) {
	return `Approve via: ${formatCliCommand(`openclaw pairing list ${channelId}`)} / ${formatCliCommand(`openclaw pairing approve ${channelId} <code>`)}`;
}
function parseOptionalDelimitedEntries(value) {
	if (!value?.trim()) return;
	const parsed = value.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
	return parsed.length > 0 ? parsed : void 0;
}
function buildAccountScopedDmSecurityPolicy(params) {
	const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? "default";
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const rootBasePath = `channels.${params.channelKey}.`;
	const accountBasePath = `channels.${params.channelKey}.accounts.${resolvedAccountId}.`;
	const defaultBasePath = `channels.${params.channelKey}.accounts.${DEFAULT_ACCOUNT_ID}.`;
	const accountConfig = channelConfig?.accounts?.[resolvedAccountId];
	const defaultAccountConfig = params.inheritSharedDefaultsFromDefaultAccount && resolvedAccountId !== "default" ? channelConfig?.accounts?.[DEFAULT_ACCOUNT_ID] : void 0;
	const resolveFieldName = (suffix, fallbackField) => suffix == null || suffix === "" ? fallbackField : /^[A-Za-z0-9_-]+$/.test(suffix) ? suffix : null;
	const simplePolicyField = resolveFieldName(params.policyPathSuffix, "dmPolicy");
	const simpleAllowFromField = resolveFieldName(params.allowFromPathSuffix, "allowFrom");
	const matchesAnyField = (config, fields) => fields.some((field) => field != null && config?.[field] !== void 0);
	const basePath = simplePolicyField || simpleAllowFromField ? matchesAnyField(accountConfig, [simplePolicyField, simpleAllowFromField]) ? accountBasePath : matchesAnyField(defaultAccountConfig, [simplePolicyField, simpleAllowFromField]) ? defaultBasePath : matchesAnyField(channelConfig, [simplePolicyField, simpleAllowFromField]) ? rootBasePath : accountConfig ? accountBasePath : rootBasePath : accountConfig ? accountBasePath : rootBasePath;
	const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
	const policyPath = params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : void 0;
	return {
		policy: params.policy ?? params.defaultPolicy ?? "pairing",
		allowFrom: params.allowFrom ?? [],
		policyPath,
		allowFromPath,
		approveHint: params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
		normalizeEntry: params.normalizeEntry
	};
}
//#endregion
export { resolveChannelDefaultAccountId as i, formatPairingApproveHint as n, parseOptionalDelimitedEntries as r, buildAccountScopedDmSecurityPolicy as t };
