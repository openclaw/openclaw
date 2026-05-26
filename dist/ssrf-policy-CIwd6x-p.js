import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import { _ as resolvePinnedHostnameWithPolicy, c as isBlockedHostnameOrIp, u as isPrivateIpAddress } from "./ssrf-DdDeGa5L.js";
//#region src/plugin-sdk/ssrf-policy.ts
function isPrivateNetworkOptInEnabled(input) {
	if (input === true) return true;
	const record = asNullableRecord(input);
	if (!record) return false;
	const network = asNullableRecord(record.network);
	return record.allowPrivateNetwork === true || record.dangerouslyAllowPrivateNetwork === true || network?.allowPrivateNetwork === true || network?.dangerouslyAllowPrivateNetwork === true;
}
function ssrfPolicyFromPrivateNetworkOptIn(input) {
	return isPrivateNetworkOptInEnabled(input) ? { allowPrivateNetwork: true } : void 0;
}
function ssrfPolicyFromDangerouslyAllowPrivateNetwork(dangerouslyAllowPrivateNetwork) {
	return ssrfPolicyFromPrivateNetworkOptIn(dangerouslyAllowPrivateNetwork);
}
function hasLegacyFlatAllowPrivateNetworkAlias(value) {
	const entry = asNullableRecord(value);
	return Boolean(entry && Object.prototype.hasOwnProperty.call(entry, "allowPrivateNetwork"));
}
function migrateLegacyFlatAllowPrivateNetworkAlias(params) {
	if (!hasLegacyFlatAllowPrivateNetworkAlias(params.entry)) return {
		entry: params.entry,
		changed: false
	};
	const legacyAllowPrivateNetwork = params.entry.allowPrivateNetwork;
	const currentNetworkRecord = asNullableRecord(params.entry.network);
	const currentNetwork = currentNetworkRecord ? { ...currentNetworkRecord } : {};
	const currentDangerousAllowPrivateNetwork = currentNetwork.dangerouslyAllowPrivateNetwork;
	let resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
	if (typeof currentDangerousAllowPrivateNetwork === "boolean") resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
	else if (typeof legacyAllowPrivateNetwork === "boolean") resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
	else if (currentDangerousAllowPrivateNetwork === void 0) resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
	delete currentNetwork.dangerouslyAllowPrivateNetwork;
	if (resolvedDangerousAllowPrivateNetwork !== void 0) currentNetwork.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
	const nextEntry = { ...params.entry };
	delete nextEntry.allowPrivateNetwork;
	if (Object.keys(currentNetwork).length > 0) nextEntry.network = currentNetwork;
	else delete nextEntry.network;
	params.changes.push(`Moved ${params.pathPrefix}.allowPrivateNetwork → ${params.pathPrefix}.network.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`);
	return {
		entry: nextEntry,
		changed: true
	};
}
function hasLegacyAllowPrivateNetworkInAccounts(value) {
	const accounts = asNullableRecord(value);
	return Boolean(accounts && Object.values(accounts).some((account) => hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(account) ?? {})));
}
function createLegacyPrivateNetworkDoctorContract(params) {
	const pathPrefix = `channels.${params.channelKey}`;
	return {
		legacyConfigRules: [{
			path: ["channels", params.channelKey],
			message: `${pathPrefix}.allowPrivateNetwork is legacy; use ${pathPrefix}.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
			match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(value) ?? {})
		}, {
			path: [
				"channels",
				params.channelKey,
				"accounts"
			],
			message: `${pathPrefix}.accounts.<id>.allowPrivateNetwork is legacy; use ${pathPrefix}.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
			match: hasLegacyAllowPrivateNetworkInAccounts
		}],
		normalizeCompatibilityConfig: ({ cfg }) => {
			const channelEntry = asNullableRecord(asNullableRecord(cfg.channels)?.[params.channelKey]);
			if (!channelEntry) return {
				config: cfg,
				changes: []
			};
			const changes = [];
			let updatedChannel = channelEntry;
			let changed = false;
			const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
				entry: updatedChannel,
				pathPrefix,
				changes
			});
			updatedChannel = topLevel.entry;
			changed = changed || topLevel.changed;
			const accounts = asNullableRecord(updatedChannel.accounts);
			if (accounts) {
				let accountsChanged = false;
				const nextAccounts = { ...accounts };
				for (const [accountId, accountValue] of Object.entries(accounts)) {
					const account = asNullableRecord(accountValue);
					if (!account) continue;
					const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
						entry: account,
						pathPrefix: `${pathPrefix}.accounts.${accountId}`,
						changes
					});
					if (!migrated.changed) continue;
					nextAccounts[accountId] = migrated.entry;
					accountsChanged = true;
				}
				if (accountsChanged) {
					updatedChannel = {
						...updatedChannel,
						accounts: nextAccounts
					};
					changed = true;
				}
			}
			if (!changed) return {
				config: cfg,
				changes: []
			};
			return {
				config: {
					...cfg,
					channels: {
						...cfg.channels,
						[params.channelKey]: updatedChannel
					}
				},
				changes
			};
		}
	};
}
function ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork) {
	return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);
}
async function assertHttpUrlTargetsPrivateNetwork(url, params = {}) {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:") return;
	const errorMessage = params.errorMessage ?? "HTTP URL must target a trusted private/internal host";
	const { hostname } = parsed;
	if (!hostname) throw new Error(errorMessage);
	if (isBlockedHostnameOrIp(hostname)) return;
	if ((typeof params.dangerouslyAllowPrivateNetwork === "boolean" ? params.dangerouslyAllowPrivateNetwork : params.allowPrivateNetwork) !== true) throw new Error(errorMessage);
	if (!(await resolvePinnedHostnameWithPolicy(hostname, {
		lookupFn: params.lookupFn,
		policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true)
	})).addresses.every((address) => isPrivateIpAddress(address))) throw new Error(errorMessage);
}
function normalizeHostnameSuffix(value) {
	const trimmed = normalizeLowercaseStringOrEmpty(value);
	if (!trimmed) return "";
	if (trimmed === "*" || trimmed === "*.") return "*";
	return trimmed.replace(/^\*\.?/, "").replace(/^\.+/, "").replace(/\.+$/, "");
}
function isHostnameAllowedBySuffixAllowlist(hostname, allowlist) {
	if (allowlist.includes("*")) return true;
	const normalized = normalizeLowercaseStringOrEmpty(hostname);
	return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}
/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
function normalizeHostnameSuffixAllowlist(input, defaults) {
	const source = input && input.length > 0 ? input : defaults;
	if (!source || source.length === 0) return [];
	const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
	if (normalized.includes("*")) return ["*"];
	return Array.from(new Set(normalized));
}
/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
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
export { isHttpsUrlAllowedByHostnameSuffixAllowlist as a, normalizeHostnameSuffixAllowlist as c, ssrfPolicyFromPrivateNetworkOptIn as d, hasLegacyFlatAllowPrivateNetworkAlias as i, ssrfPolicyFromAllowPrivateNetwork as l, buildHostnameAllowlistPolicyFromSuffixAllowlist as n, isPrivateNetworkOptInEnabled as o, createLegacyPrivateNetworkDoctorContract as r, migrateLegacyFlatAllowPrivateNetworkAlias as s, assertHttpUrlTargetsPrivateNetwork as t, ssrfPolicyFromDangerouslyAllowPrivateNetwork as u };
