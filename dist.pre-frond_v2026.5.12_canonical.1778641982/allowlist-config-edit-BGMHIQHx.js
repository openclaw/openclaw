import { t as isBlockedObjectKey } from "./prototype-keys-BWjW0VW8.js";
import { n as normalizeAccountId } from "./account-id-Bj7l9NI7.js";
//#region src/plugin-sdk/allowlist-config-edit.ts
const DM_ALLOWLIST_CONFIG_PATHS = {
	readPaths: [["allowFrom"]],
	writePath: ["allowFrom"]
};
const GROUP_ALLOWLIST_CONFIG_PATHS = {
	readPaths: [["groupAllowFrom"]],
	writePath: ["groupAllowFrom"]
};
const LEGACY_DM_ALLOWLIST_CONFIG_PATHS = {
	readPaths: [["allowFrom"], ["dm", "allowFrom"]],
	writePath: ["allowFrom"],
	cleanupPaths: [["dm", "allowFrom"]]
};
function resolveDmGroupAllowlistConfigPaths(scope) {
	return scope === "dm" ? DM_ALLOWLIST_CONFIG_PATHS : GROUP_ALLOWLIST_CONFIG_PATHS;
}
function resolveLegacyDmAllowlistConfigPaths(scope) {
	return scope === "dm" ? LEGACY_DM_ALLOWLIST_CONFIG_PATHS : null;
}
/** Coerce stored allowlist entries into presentable non-empty strings. */
function readConfiguredAllowlistEntries(entries) {
	return (entries ?? []).map(String).filter(Boolean);
}
/** Collect labeled allowlist overrides from a flat keyed record. */
function collectAllowlistOverridesFromRecord(params) {
	const overrides = [];
	for (const [key, value] of Object.entries(params.record ?? {})) {
		if (!value) continue;
		const entries = readConfiguredAllowlistEntries(params.resolveEntries(value));
		if (entries.length === 0) continue;
		overrides.push({
			label: params.label(key, value),
			entries
		});
	}
	return overrides;
}
/** Collect labeled allowlist overrides from an outer record with nested child records. */
function collectNestedAllowlistOverridesFromRecord(params) {
	const overrides = [];
	for (const [outerKey, outerValue] of Object.entries(params.record ?? {})) {
		if (!outerValue) continue;
		const outerEntries = readConfiguredAllowlistEntries(params.resolveOuterEntries(outerValue));
		if (outerEntries.length > 0) overrides.push({
			label: params.outerLabel(outerKey, outerValue),
			entries: outerEntries
		});
		overrides.push(...collectAllowlistOverridesFromRecord({
			record: params.resolveChildren(outerValue),
			label: (innerKey, innerValue) => params.innerLabel(outerKey, innerKey, innerValue),
			resolveEntries: params.resolveInnerEntries
		}));
	}
	return overrides;
}
/** Build an account-scoped flat override resolver from a keyed allowlist record. */
function createFlatAllowlistOverrideResolver(params) {
	return (account) => collectAllowlistOverridesFromRecord({
		record: params.resolveRecord(account),
		label: params.label,
		resolveEntries: params.resolveEntries
	});
}
/** Build an account-scoped nested override resolver from hierarchical allowlist records. */
function createNestedAllowlistOverrideResolver(params) {
	return (account) => collectNestedAllowlistOverridesFromRecord({
		record: params.resolveRecord(account),
		outerLabel: params.outerLabel,
		resolveOuterEntries: params.resolveOuterEntries,
		resolveChildren: params.resolveChildren,
		innerLabel: params.innerLabel,
		resolveInnerEntries: params.resolveInnerEntries
	});
}
/** Build the common account-scoped token-gated allowlist name resolver. */
function createAccountScopedAllowlistNameResolver(params) {
	return async ({ cfg, accountId, entries }) => {
		const account = params.resolveAccount({
			cfg,
			accountId
		});
		const token = params.resolveToken(account)?.trim();
		if (!token) return [];
		return await params.resolveNames({
			token,
			entries
		});
	};
}
function resolveAccountScopedWriteTarget(parsed, channelId, accountId) {
	const channels = parsed.channels ??= {};
	const channel = channels[channelId] ??= {};
	const normalizedAccountId = normalizeAccountId(accountId);
	if (isBlockedObjectKey(normalizedAccountId)) return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};
	const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
	if (!(normalizedAccountId !== "default" || hasAccounts)) return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};
	const accounts = channel.accounts ??= {};
	const existingAccount = Object.hasOwn(accounts, normalizedAccountId) ? accounts[normalizedAccountId] : void 0;
	if (!existingAccount || typeof existingAccount !== "object") accounts[normalizedAccountId] = {};
	return {
		target: accounts[normalizedAccountId],
		pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
		writeTarget: {
			kind: "account",
			scope: {
				channelId,
				accountId: normalizedAccountId
			}
		}
	};
}
function getNestedValue(root, path) {
	let current = root;
	for (const key of path) {
		if (!current || typeof current !== "object") return;
		current = current[key];
	}
	return current;
}
function ensureNestedObject(root, path) {
	let current = root;
	for (const key of path) {
		const existing = current[key];
		if (!existing || typeof existing !== "object") current[key] = {};
		current = current[key];
	}
	return current;
}
function setNestedValue(root, path, value) {
	if (path.length === 0) return;
	if (path.length === 1) {
		root[path[0]] = value;
		return;
	}
	const parent = ensureNestedObject(root, path.slice(0, -1));
	parent[path[path.length - 1]] = value;
}
function deleteNestedValue(root, path) {
	if (path.length === 0) return;
	if (path.length === 1) {
		delete root[path[0]];
		return;
	}
	const parent = getNestedValue(root, path.slice(0, -1));
	if (!parent || typeof parent !== "object") return;
	delete parent[path[path.length - 1]];
}
function applyAccountScopedAllowlistConfigEdit(params) {
	const resolvedTarget = resolveAccountScopedWriteTarget(params.parsedConfig, params.channelId, params.accountId);
	const existing = [];
	for (const path of params.paths.readPaths) {
		const existingRaw = getNestedValue(resolvedTarget.target, path);
		if (!Array.isArray(existingRaw)) continue;
		for (const entry of existingRaw) {
			const value = String(entry).trim();
			if (!value || existing.includes(value)) continue;
			existing.push(value);
		}
	}
	const normalizedEntry = params.normalize([params.entry]);
	if (normalizedEntry.length === 0) return { kind: "invalid-entry" };
	const existingNormalized = params.normalize(existing);
	const shouldMatch = (value) => normalizedEntry.includes(value);
	let changed = false;
	let next = existing;
	const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
	if (params.action === "add") {
		if (!configHasEntry) {
			next = [...existing, params.entry.trim()];
			changed = true;
		}
	} else {
		const keep = [];
		for (const entry of existing) {
			if (params.normalize([entry]).some((value) => shouldMatch(value))) {
				changed = true;
				continue;
			}
			keep.push(entry);
		}
		next = keep;
	}
	if (changed) {
		if (next.length === 0) deleteNestedValue(resolvedTarget.target, params.paths.writePath);
		else setNestedValue(resolvedTarget.target, params.paths.writePath, next);
		for (const path of params.paths.cleanupPaths ?? []) deleteNestedValue(resolvedTarget.target, path);
	}
	return {
		kind: "ok",
		changed,
		pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
		writeTarget: resolvedTarget.writeTarget
	};
}
/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
function buildAccountScopedAllowlistConfigEditor(params) {
	return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
		const paths = params.resolvePaths(scope);
		if (!paths) return null;
		return applyAccountScopedAllowlistConfigEdit({
			parsedConfig,
			channelId: params.channelId,
			accountId,
			action,
			entry,
			normalize: (values) => params.normalize({
				cfg,
				accountId,
				values
			}),
			paths
		});
	};
}
function buildAccountAllowlistAdapter(params) {
	return {
		supportsScope: params.supportsScope,
		readConfig: ({ cfg, accountId }) => params.readConfig(params.resolveAccount({
			cfg,
			accountId
		}), {
			cfg,
			accountId
		}),
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: params.channelId,
			normalize: params.normalize,
			resolvePaths: params.resolvePaths
		})
	};
}
/** Build the common DM/group allowlist adapter used by channels that store both lists in config. */
function buildDmGroupAccountAllowlistAdapter(params) {
	return buildAccountAllowlistAdapter({
		channelId: params.channelId,
		resolveAccount: params.resolveAccount,
		normalize: params.normalize,
		supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
		resolvePaths: resolveDmGroupAllowlistConfigPaths,
		readConfig: (account, context) => ({
			dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account, context)),
			groupAllowFrom: readConfiguredAllowlistEntries(params.resolveGroupAllowFrom(account)),
			dmPolicy: params.resolveDmPolicy?.(account) ?? void 0,
			groupPolicy: params.resolveGroupPolicy?.(account) ?? void 0,
			groupOverrides: params.resolveGroupOverrides?.(account)
		})
	});
}
/** Build the common DM-only allowlist adapter for channels with legacy dm.allowFrom fallback paths. */
function buildLegacyDmAccountAllowlistAdapter(params) {
	return buildAccountAllowlistAdapter({
		channelId: params.channelId,
		resolveAccount: params.resolveAccount,
		normalize: params.normalize,
		supportsScope: ({ scope }) => scope === "dm",
		resolvePaths: resolveLegacyDmAllowlistConfigPaths,
		readConfig: (account, context) => ({
			dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account, context)),
			groupPolicy: params.resolveGroupPolicy?.(account) ?? void 0,
			groupOverrides: params.resolveGroupOverrides?.(account)
		})
	});
}
//#endregion
export { collectNestedAllowlistOverridesFromRecord as a, createNestedAllowlistOverrideResolver as c, resolveLegacyDmAllowlistConfigPaths as d, collectAllowlistOverridesFromRecord as i, readConfiguredAllowlistEntries as l, buildDmGroupAccountAllowlistAdapter as n, createAccountScopedAllowlistNameResolver as o, buildLegacyDmAccountAllowlistAdapter as r, createFlatAllowlistOverrideResolver as s, buildAccountScopedAllowlistConfigEditor as t, resolveDmGroupAllowlistConfigPaths as u };
