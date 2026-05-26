import { c as isRecord } from "./utils-sBTEdeml.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { t as inspectReadOnlyChannelAccount } from "./read-only-account-inspect-DY5drRrW.js";
import { i as projectSafeChannelAccountSnapshotFields, n as hasResolvedCredentialValue, t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-YzCGlwrq.js";
//#region src/channels/account-summary.ts
function buildChannelAccountSnapshot(params) {
	const described = params.plugin.config.describeAccount?.(params.account, params.cfg);
	return {
		enabled: params.enabled,
		configured: params.configured,
		...projectSafeChannelAccountSnapshotFields(params.account),
		...described,
		accountId: params.accountId
	};
}
function formatChannelAllowFrom(params) {
	if (params.plugin.config.formatAllowFrom) return params.plugin.config.formatAllowFrom({
		cfg: params.cfg,
		accountId: params.accountId,
		allowFrom: params.allowFrom
	});
	return normalizeStringEntries(params.allowFrom);
}
function resolveChannelAccountEnabled(params) {
	if (params.plugin.config.isEnabled) return params.plugin.config.isEnabled(params.account, params.cfg);
	return (isRecord(params.account) ? params.account.enabled : void 0) !== false;
}
async function resolveChannelAccountConfigured(params) {
	if (params.plugin.config.isConfigured) return await params.plugin.config.isConfigured(params.account, params.cfg);
	if (params.readAccountConfiguredField) return (isRecord(params.account) ? params.account.configured : void 0) !== false;
	return true;
}
//#endregion
//#region src/channels/account-inspection.ts
async function inspectChannelAccount(params) {
	return params.plugin.config.inspectAccount?.(params.cfg, params.accountId) ?? await inspectReadOnlyChannelAccount({
		channelId: params.plugin.id,
		cfg: params.cfg,
		accountId: params.accountId
	});
}
async function resolveInspectedChannelAccount(params) {
	const sourceInspectedAccount = await inspectChannelAccount({
		plugin: params.plugin,
		cfg: params.sourceConfig,
		accountId: params.accountId
	});
	const resolvedInspectedAccount = await inspectChannelAccount({
		plugin: params.plugin,
		cfg: params.cfg,
		accountId: params.accountId
	});
	const resolvedInspection = resolvedInspectedAccount;
	const sourceInspection = sourceInspectedAccount;
	const resolvedAccount = resolvedInspectedAccount ?? params.plugin.config.resolveAccount(params.cfg, params.accountId);
	const useSourceUnavailableAccount = Boolean(sourceInspectedAccount && hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) && (!hasResolvedCredentialValue(resolvedAccount) || sourceInspection?.configured === true && resolvedInspection?.configured === false));
	const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
	const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
	return {
		account,
		enabled: selectedInspection?.enabled ?? resolveChannelAccountEnabled({
			plugin: params.plugin,
			account,
			cfg: params.cfg
		}),
		configured: selectedInspection?.configured ?? await resolveChannelAccountConfigured({
			plugin: params.plugin,
			account,
			cfg: params.cfg,
			readAccountConfiguredField: true
		})
	};
}
//#endregion
export { resolveChannelAccountConfigured as a, formatChannelAllowFrom as i, resolveInspectedChannelAccount as n, resolveChannelAccountEnabled as o, buildChannelAccountSnapshot as r, inspectChannelAccount as t };
