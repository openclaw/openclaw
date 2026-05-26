import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { c as formatUnknownChannelMessage } from "./error-format-BfFDdqsq.js";
import { o as normalizeChannelId } from "./registry-CtWyD2pE.js";
import { a as getBundledChannelSetupPlugin } from "./bundled-0oTAwz0N.js";
import { n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as listManifestChannelContributionIds } from "./manifest-contribution-ids-tozuTTjv.js";
import { i as listRouteBindings, t as isRouteBinding } from "./bindings-D1F1bOgs.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-CswdXPdi.js";
//#region src/commands/agents.bindings.ts
function bindingMatchKey(match) {
	const accountId = normalizeOptionalString(match.accountId) || "default";
	const identityKey = bindingMatchIdentityKey(match);
	return JSON.stringify([identityKey, accountId]);
}
function bindingMatchIdentityKey(match) {
	const roles = Array.isArray(match.roles) ? Array.from(new Set(normalizeStringEntries(match.roles).toSorted())) : [];
	return JSON.stringify([
		match.channel,
		match.peer?.kind ?? "",
		match.peer?.id ?? "",
		match.guildId ?? "",
		match.teamId ?? "",
		roles.join(",")
	]);
}
function canUpgradeBindingAccountScope(params) {
	if (!normalizeOptionalString(params.incoming.match.accountId)) return false;
	if (normalizeOptionalString(params.existing.match.accountId)) return false;
	if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) return false;
	return bindingMatchIdentityKey(params.existing.match) === bindingMatchIdentityKey(params.incoming.match);
}
function applyAgentBindings(cfg, bindings) {
	const existingRoutes = [...listRouteBindings(cfg)];
	const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
	const existingMatchMap = /* @__PURE__ */ new Map();
	for (const binding of existingRoutes) {
		const key = bindingMatchKey(binding.match);
		if (!existingMatchMap.has(key)) existingMatchMap.set(key, normalizeAgentId(binding.agentId));
	}
	const added = [];
	const updated = [];
	const skipped = [];
	const conflicts = [];
	for (const binding of bindings) {
		const agentId = normalizeAgentId(binding.agentId);
		const key = bindingMatchKey(binding.match);
		const existingAgentId = existingMatchMap.get(key);
		if (existingAgentId) {
			if (existingAgentId === agentId) skipped.push(binding);
			else conflicts.push({
				binding,
				existingAgentId
			});
			continue;
		}
		const upgradeIndex = existingRoutes.findIndex((candidate) => canUpgradeBindingAccountScope({
			existing: candidate,
			incoming: binding,
			normalizedIncomingAgentId: agentId
		}));
		if (upgradeIndex >= 0) {
			const current = existingRoutes[upgradeIndex];
			if (!current) continue;
			const previousKey = bindingMatchKey(current.match);
			const upgradedBinding = {
				...current,
				agentId,
				match: {
					...current.match,
					accountId: binding.match.accountId?.trim()
				}
			};
			existingRoutes[upgradeIndex] = upgradedBinding;
			existingMatchMap.delete(previousKey);
			existingMatchMap.set(bindingMatchKey(upgradedBinding.match), agentId);
			updated.push(upgradedBinding);
			continue;
		}
		existingMatchMap.set(key, agentId);
		added.push({
			...binding,
			agentId
		});
	}
	if (added.length === 0 && updated.length === 0) return {
		config: cfg,
		added,
		updated,
		skipped,
		conflicts
	};
	return {
		config: {
			...cfg,
			bindings: [
				...existingRoutes,
				...added,
				...nonRouteBindings
			]
		},
		added,
		updated,
		skipped,
		conflicts
	};
}
function removeAgentBindings(cfg, bindings) {
	const existingRoutes = listRouteBindings(cfg);
	const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
	const removeIndexes = /* @__PURE__ */ new Set();
	const removed = [];
	const missing = [];
	const conflicts = [];
	for (const binding of bindings) {
		const desiredAgentId = normalizeAgentId(binding.agentId);
		const key = bindingMatchKey(binding.match);
		let matchedIndex = -1;
		let conflictingAgentId = null;
		for (let i = 0; i < existingRoutes.length; i += 1) {
			if (removeIndexes.has(i)) continue;
			const current = existingRoutes[i];
			if (!current || bindingMatchKey(current.match) !== key) continue;
			const currentAgentId = normalizeAgentId(current.agentId);
			if (currentAgentId === desiredAgentId) {
				matchedIndex = i;
				break;
			}
			conflictingAgentId = currentAgentId;
		}
		if (matchedIndex >= 0) {
			const matched = existingRoutes[matchedIndex];
			if (matched) {
				removeIndexes.add(matchedIndex);
				removed.push(matched);
			}
			continue;
		}
		if (conflictingAgentId) {
			conflicts.push({
				binding,
				existingAgentId: conflictingAgentId
			});
			continue;
		}
		missing.push(binding);
	}
	if (removeIndexes.size === 0) return {
		config: cfg,
		removed,
		missing,
		conflicts
	};
	const nextBindings = [...existingRoutes.filter((_, index) => !removeIndexes.has(index)), ...nonRouteBindings];
	return {
		config: {
			...cfg,
			bindings: nextBindings.length > 0 ? nextBindings : void 0
		},
		removed,
		missing,
		conflicts
	};
}
function resolveDefaultAccountId(cfg, provider) {
	const plugin = getBindingChannelPlugin(provider);
	if (!plugin) return DEFAULT_ACCOUNT_ID;
	return resolveChannelDefaultAccountId({
		plugin,
		cfg
	});
}
function listManifestChannelIds(config) {
	return new Set(listManifestChannelContributionIds({
		includeDisabled: true,
		config,
		env: process.env
	}));
}
function normalizeBindingChannelId(raw, config) {
	const bundled = normalizeChannelId(raw);
	if (bundled) return bundled;
	const normalized = normalizeOptionalString(raw)?.toLowerCase();
	if (!normalized) return null;
	return listManifestChannelIds(config).has(normalized) ? normalized : null;
}
function getBindingChannelPlugin(channel) {
	return getLoadedChannelPlugin(channel) ?? getBundledChannelSetupPlugin(channel);
}
function resolveBindingAccountId(params) {
	const explicitAccountId = params.explicitAccountId?.trim();
	if (explicitAccountId) return explicitAccountId;
	const plugin = getBindingChannelPlugin(params.channel);
	const pluginAccountId = plugin?.setup?.resolveBindingAccountId?.({
		cfg: params.config,
		agentId: params.agentId
	});
	if (pluginAccountId?.trim()) return pluginAccountId.trim();
	if (plugin && plugin.config.listAccountIds(params.config).length > 1) return "*";
	if (plugin?.meta.forceAccountBinding) return resolveDefaultAccountId(params.config, params.channel);
}
function buildChannelBindings(params) {
	const bindings = [];
	const agentId = normalizeAgentId(params.agentId);
	for (const channel of params.selection) {
		const match = { channel };
		const accountId = resolveBindingAccountId({
			channel,
			config: params.config,
			agentId,
			explicitAccountId: params.accountIds?.[channel]
		});
		if (accountId) match.accountId = accountId;
		bindings.push({
			type: "route",
			agentId,
			match
		});
	}
	return bindings;
}
function parseBindingSpecs(params) {
	const bindings = [];
	const errors = [];
	const specs = params.specs ?? [];
	const agentId = normalizeAgentId(params.agentId);
	for (const raw of specs) {
		const trimmed = raw?.trim();
		if (!trimmed) continue;
		const [channelRaw, accountRaw] = trimmed.split(":", 2);
		const channel = normalizeBindingChannelId(channelRaw, params.config);
		if (!channel) {
			errors.push(formatUnknownChannelMessage({ channel: channelRaw }));
			continue;
		}
		let accountId = accountRaw?.trim();
		if (accountRaw !== void 0 && !accountId) {
			errors.push(`Invalid binding "${trimmed}". Account id is empty. Use <channel>:<account>, for example telegram:default.`);
			continue;
		}
		accountId = resolveBindingAccountId({
			channel,
			config: params.config,
			agentId,
			explicitAccountId: accountId
		});
		const match = { channel };
		if (accountId) match.accountId = accountId;
		bindings.push({
			type: "route",
			agentId,
			match
		});
	}
	return {
		bindings,
		errors
	};
}
//#endregion
export { removeAgentBindings as i, buildChannelBindings as n, parseBindingSpecs as r, applyAgentBindings as t };
