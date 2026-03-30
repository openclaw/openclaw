import { m as DEFAULT_ACCOUNT_ID, s as normalizeAgentId } from "./session-key-D5gwKk5E.js";
import { Vt as readConfigFileSnapshot } from "./model-selection-DILdVnl8.js";
import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { r as normalizeChannelId, t as getChannelPlugin } from "./plugins-B9xwwhdE.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-0pq6nLxP.js";

//#region src/commands/agents.bindings.ts
function bindingMatchKey(match) {
	const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
	return [bindingMatchIdentityKey(match), accountId].join("|");
}
function bindingMatchIdentityKey(match) {
	const roles = Array.isArray(match.roles) ? Array.from(new Set(match.roles.map((role) => role.trim()).filter(Boolean).toSorted())) : [];
	return [
		match.channel,
		match.peer?.kind ?? "",
		match.peer?.id ?? "",
		match.guildId ?? "",
		match.teamId ?? "",
		roles.join(",")
	].join("|");
}
function canUpgradeBindingAccountScope(params) {
	if (!params.incoming.match.accountId?.trim()) return false;
	if (params.existing.match.accountId?.trim()) return false;
	if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) return false;
	return bindingMatchIdentityKey(params.existing.match) === bindingMatchIdentityKey(params.incoming.match);
}
function describeBinding(binding) {
	const match = binding.match;
	const parts = [match.channel];
	if (match.accountId) parts.push(`accountId=${match.accountId}`);
	if (match.peer) parts.push(`peer=${match.peer.kind}:${match.peer.id}`);
	if (match.guildId) parts.push(`guild=${match.guildId}`);
	if (match.teamId) parts.push(`team=${match.teamId}`);
	return parts.join(" ");
}
function applyAgentBindings(cfg, bindings) {
	const existing = [...cfg.bindings ?? []];
	const existingMatchMap = /* @__PURE__ */ new Map();
	for (const binding of existing) {
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
		const upgradeIndex = existing.findIndex((candidate) => canUpgradeBindingAccountScope({
			existing: candidate,
			incoming: binding,
			normalizedIncomingAgentId: agentId
		}));
		if (upgradeIndex >= 0) {
			const current = existing[upgradeIndex];
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
			existing[upgradeIndex] = upgradedBinding;
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
			bindings: [...existing, ...added]
		},
		added,
		updated,
		skipped,
		conflicts
	};
}
function removeAgentBindings(cfg, bindings) {
	const existing = cfg.bindings ?? [];
	const removeIndexes = /* @__PURE__ */ new Set();
	const removed = [];
	const missing = [];
	const conflicts = [];
	for (const binding of bindings) {
		const desiredAgentId = normalizeAgentId(binding.agentId);
		const key = bindingMatchKey(binding.match);
		let matchedIndex = -1;
		let conflictingAgentId = null;
		for (let i = 0; i < existing.length; i += 1) {
			if (removeIndexes.has(i)) continue;
			const current = existing[i];
			if (!current || bindingMatchKey(current.match) !== key) continue;
			const currentAgentId = normalizeAgentId(current.agentId);
			if (currentAgentId === desiredAgentId) {
				matchedIndex = i;
				break;
			}
			conflictingAgentId = currentAgentId;
		}
		if (matchedIndex >= 0) {
			const matched = existing[matchedIndex];
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
	const nextBindings = existing.filter((_, index) => !removeIndexes.has(index));
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
	const plugin = getChannelPlugin(provider);
	if (!plugin) return DEFAULT_ACCOUNT_ID;
	return resolveChannelDefaultAccountId({
		plugin,
		cfg
	});
}
function resolveBindingAccountId(params) {
	const explicitAccountId = params.explicitAccountId?.trim();
	if (explicitAccountId) return explicitAccountId;
	const plugin = getChannelPlugin(params.channel);
	const pluginAccountId = plugin?.setup?.resolveBindingAccountId?.({
		cfg: params.config,
		agentId: params.agentId
	});
	if (pluginAccountId?.trim()) return pluginAccountId.trim();
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
		const channel = normalizeChannelId(channelRaw);
		if (!channel) {
			errors.push(`Unknown channel "${channelRaw}".`);
			continue;
		}
		let accountId = accountRaw?.trim();
		if (accountRaw !== void 0 && !accountId) {
			errors.push(`Invalid binding "${trimmed}" (empty account id).`);
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
//#region src/commands/config-validation.ts
async function requireValidConfigSnapshot(runtime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		const issues = snapshot.issues.length > 0 ? snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n") : "Unknown validation issue.";
		runtime.error(`Config invalid:\n${issues}`);
		runtime.error(`Fix the config or run ${formatCliCommand("openclaw doctor")}.`);
		runtime.exit(1);
		return null;
	}
	return snapshot.config;
}

//#endregion
export { parseBindingSpecs as a, describeBinding as i, applyAgentBindings as n, removeAgentBindings as o, buildChannelBindings as r, requireValidConfigSnapshot as t };