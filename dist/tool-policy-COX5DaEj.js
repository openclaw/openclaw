import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy-A1J2EpRM.js";
import { a as resolveCoreToolProfilePolicy, t as CORE_TOOL_GROUPS } from "./tool-catalog-8X_kZYZC.js";
//#region src/agents/tool-policy-shared.ts
const TOOL_NAME_ALIASES = {
	bash: "exec",
	"apply-patch": "apply_patch"
};
const TOOL_GROUPS = { ...CORE_TOOL_GROUPS };
function normalizeToolName(name) {
	const normalized = normalizeLowercaseStringOrEmpty(name);
	return TOOL_NAME_ALIASES[normalized] ?? normalized;
}
function normalizeToolList(list) {
	if (!list) return [];
	return list.map(normalizeToolName).filter(Boolean);
}
function expandToolGroups(list) {
	const normalized = normalizeToolList(list);
	const expanded = [];
	for (const value of normalized) {
		const group = TOOL_GROUPS[value];
		if (group) {
			expanded.push(...group);
			continue;
		}
		expanded.push(value);
	}
	return Array.from(new Set(expanded));
}
function resolveToolProfilePolicy(profile) {
	return resolveCoreToolProfilePolicy(profile);
}
//#endregion
//#region src/agents/tool-policy.ts
const DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY = "__openclaw_default_plugin_tools__";
function hasRestrictiveAllowPolicy(policy) {
	return Array.isArray(policy?.allow) && policy.allow.some((entry) => {
		const normalized = normalizeToolName(entry);
		return Boolean(normalized) && normalized !== "*" && normalized !== "__openclaw_default_plugin_tools__";
	});
}
function replaceWithEffectiveToolAllowlist(target, tools) {
	target.length = 0;
	const seen = /* @__PURE__ */ new Set();
	for (const tool of tools) {
		const normalized = normalizeToolName(tool.name);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		target.push(normalized);
	}
}
function collectExplicitAllowlist(policies) {
	const entries = [];
	for (const policy of policies) {
		if (!policy?.allow) continue;
		for (const value of policy.allow) {
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed === "*" && policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) continue;
			if (trimmed) entries.push(trimmed);
		}
		if (policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) entries.push(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY);
	}
	return Array.from(new Set(entries));
}
function collectExplicitDenylist(policies) {
	const entries = [];
	for (const policy of policies) {
		if (!policy?.deny) continue;
		for (const value of policy.deny) {
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed) entries.push(trimmed);
		}
	}
	return entries;
}
function buildPluginToolGroups(params) {
	const all = [];
	const byPlugin = /* @__PURE__ */ new Map();
	for (const tool of params.tools) {
		const meta = params.toolMeta(tool);
		if (!meta) continue;
		const name = normalizeToolName(tool.name);
		all.push(name);
		const pluginId = normalizeOptionalLowercaseString(meta.pluginId);
		if (!pluginId) continue;
		const list = byPlugin.get(pluginId) ?? [];
		list.push(name);
		byPlugin.set(pluginId, list);
	}
	return {
		all,
		byPlugin
	};
}
function expandPluginGroups(list, groups) {
	if (!list || list.length === 0) return list;
	const expanded = [];
	for (const entry of list) {
		const normalized = normalizeToolName(entry);
		if (normalized === "group:plugins") {
			if (groups.all.length > 0) expanded.push(...groups.all);
			else expanded.push(normalized);
			continue;
		}
		const tools = groups.byPlugin.get(normalized);
		if (tools && tools.length > 0) {
			expanded.push(...tools);
			continue;
		}
		expanded.push(normalized);
	}
	return Array.from(new Set(expanded));
}
function expandPolicyWithPluginGroups(policy, groups) {
	if (!policy) return;
	return {
		allow: expandPluginGroups(policy.allow, groups),
		deny: expandPluginGroups(policy.deny, groups)
	};
}
function analyzeAllowlistByToolType(policy, groups, coreTools) {
	if (!policy?.allow || policy.allow.length === 0) return {
		policy,
		unknownAllowlist: [],
		pluginOnlyAllowlist: false
	};
	const normalized = normalizeToolList(policy.allow);
	if (normalized.length === 0) return {
		policy,
		unknownAllowlist: [],
		pluginOnlyAllowlist: false
	};
	const pluginIds = new Set(groups.byPlugin.keys());
	const pluginTools = new Set(groups.all);
	const unknownAllowlist = [];
	let hasOnlyPluginEntries = true;
	for (const entry of normalized) {
		if (entry === "*") {
			hasOnlyPluginEntries = false;
			continue;
		}
		const isPluginEntry = entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
		const isCoreEntry = expandToolGroups([entry]).some((tool) => coreTools.has(tool));
		if (!isPluginEntry) hasOnlyPluginEntries = false;
		if (!isCoreEntry && !isPluginEntry) unknownAllowlist.push(entry);
	}
	const pluginOnlyAllowlist = hasOnlyPluginEntries;
	return {
		policy,
		unknownAllowlist: Array.from(new Set(unknownAllowlist)),
		pluginOnlyAllowlist
	};
}
function mergeAlsoAllowPolicy(policy, alsoAllow) {
	if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
	return {
		...policy,
		allow: Array.from(new Set([...policy.allow, ...alsoAllow]))
	};
}
//#endregion
export { collectExplicitDenylist as a, hasRestrictiveAllowPolicy as c, TOOL_GROUPS as d, expandToolGroups as f, resolveToolProfilePolicy as h, collectExplicitAllowlist as i, mergeAlsoAllowPolicy as l, normalizeToolName as m, analyzeAllowlistByToolType as n, expandPluginGroups as o, normalizeToolList as p, buildPluginToolGroups as r, expandPolicyWithPluginGroups as s, DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY as t, replaceWithEffectiveToolAllowlist as u };
