import { c as isRecord } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import "./shared-Cv5g0_Ch.js";
import { a as isChannelAccountEffectivelyEnabled, i as hasOwnProperty, n as collectSecretInputAssignment, o as isEnabledFlag } from "./runtime-shared-CPFXAPqc.js";
//#region src/secrets/channel-secret-basic-runtime.ts
function getChannelRecord(config, channelKey) {
	const channels = config.channels;
	if (!isRecord(channels)) return;
	const channel = channels[channelKey];
	return isRecord(channel) ? channel : void 0;
}
function getChannelSurface(config, channelKey) {
	const channel = getChannelRecord(config, channelKey);
	if (!channel) return null;
	return {
		channel,
		surface: resolveChannelAccountSurface(channel)
	};
}
function resolveChannelAccountSurface(channel) {
	const channelEnabled = isEnabledFlag(channel);
	const accounts = channel.accounts;
	if (!isRecord(accounts) || Object.keys(accounts).length === 0) return {
		hasExplicitAccounts: false,
		channelEnabled,
		accounts: [{
			accountId: "default",
			account: channel,
			enabled: channelEnabled
		}]
	};
	const accountEntries = [];
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!isRecord(account)) continue;
		accountEntries.push({
			accountId,
			account,
			enabled: isChannelAccountEffectivelyEnabled(channel, account)
		});
	}
	return {
		hasExplicitAccounts: true,
		channelEnabled,
		accounts: accountEntries
	};
}
function isBaseFieldActiveForChannelSurface(surface, rootKey) {
	if (!surface.channelEnabled) return false;
	if (!surface.hasExplicitAccounts) return true;
	return surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, rootKey));
}
function normalizeSecretStringValue(value) {
	return typeof value === "string" ? value.trim() : "";
}
function hasConfiguredSecretInputValue(value, defaults) {
	return normalizeSecretStringValue(value).length > 0 || coerceSecretRef(value, defaults) !== null;
}
function collectSimpleChannelFieldAssignments(params) {
	collectSecretInputAssignment({
		value: params.channel[params.field],
		path: `channels.${params.channelKey}.${params.field}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: isBaseFieldActiveForChannelSurface(params.surface, params.field),
		inactiveReason: params.topInactiveReason,
		apply: (value) => {
			params.channel[params.field] = value;
		}
	});
	if (!params.surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of params.surface.accounts) {
		if (!hasOwnProperty(account, params.field)) continue;
		collectSecretInputAssignment({
			value: account[params.field],
			path: `channels.${params.channelKey}.accounts.${accountId}.${params.field}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: params.accountInactiveReason,
			apply: (value) => {
				account[params.field] = value;
			}
		});
	}
}
function isConditionalTopLevelFieldActive(params) {
	if (!params.surface.channelEnabled) return false;
	if (!params.surface.hasExplicitAccounts) return params.activeWithoutAccounts;
	return params.surface.accounts.some(params.inheritedAccountActive);
}
function collectConditionalChannelFieldAssignments(params) {
	collectSecretInputAssignment({
		value: params.channel[params.field],
		path: `channels.${params.channelKey}.${params.field}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: isConditionalTopLevelFieldActive({
			surface: params.surface,
			activeWithoutAccounts: params.topLevelActiveWithoutAccounts,
			inheritedAccountActive: params.topLevelInheritedAccountActive
		}),
		inactiveReason: params.topInactiveReason,
		apply: (value) => {
			params.channel[params.field] = value;
		}
	});
	if (!params.surface.hasExplicitAccounts) return;
	for (const entry of params.surface.accounts) {
		if (!hasOwnProperty(entry.account, params.field)) continue;
		collectSecretInputAssignment({
			value: entry.account[params.field],
			path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.field}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: params.accountActive(entry),
			inactiveReason: typeof params.accountInactiveReason === "function" ? params.accountInactiveReason(entry) : params.accountInactiveReason,
			apply: (value) => {
				entry.account[params.field] = value;
			}
		});
	}
}
function collectNestedChannelFieldAssignments(params) {
	const topLevelNested = params.channel[params.nestedKey];
	if (isRecord(topLevelNested)) collectSecretInputAssignment({
		value: topLevelNested[params.field],
		path: `channels.${params.channelKey}.${params.nestedKey}.${params.field}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: params.topLevelActive,
		inactiveReason: params.topInactiveReason,
		apply: (value) => {
			topLevelNested[params.field] = value;
		}
	});
	if (!params.surface.hasExplicitAccounts) return;
	for (const entry of params.surface.accounts) {
		const nested = entry.account[params.nestedKey];
		if (!isRecord(nested)) continue;
		collectSecretInputAssignment({
			value: nested[params.field],
			path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.${params.field}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: params.accountActive(entry),
			inactiveReason: typeof params.accountInactiveReason === "function" ? params.accountInactiveReason(entry) : params.accountInactiveReason,
			apply: (value) => {
				nested[params.field] = value;
			}
		});
	}
}
//#endregion
export { getChannelSurface as a, normalizeSecretStringValue as c, getChannelRecord as i, resolveChannelAccountSurface as l, collectNestedChannelFieldAssignments as n, hasConfiguredSecretInputValue as o, collectSimpleChannelFieldAssignments as r, isBaseFieldActiveForChannelSurface as s, collectConditionalChannelFieldAssignments as t };
