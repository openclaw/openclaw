import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as normalizeToolName, n as expandToolGroups, r as normalizeToolList } from "./tool-policy-shared-ywrO5Obc.js";
//#region src/agents/tool-policy.ts
function wrapOwnerOnlyToolExecution(tool, authorized) {
	if (tool.ownerOnly !== true || authorized || !tool.execute) return tool;
	return {
		...tool,
		execute: async () => {
			throw new Error("Tool restricted to owner senders.");
		}
	};
}
const OWNER_ONLY_TOOL_APPROVAL_CLASS_FALLBACKS = new Map([
	["cron", "control_plane"],
	["gateway", "control_plane"],
	["nodes", "exec_capable"]
]);
function resolveOwnerOnlyToolApprovalClass(name) {
	return OWNER_ONLY_TOOL_APPROVAL_CLASS_FALLBACKS.get(normalizeToolName(name));
}
function isOwnerOnlyToolName(name) {
	return resolveOwnerOnlyToolApprovalClass(name) !== void 0;
}
function isOwnerOnlyTool(tool) {
	return tool.ownerOnly === true || isOwnerOnlyToolName(tool.name);
}
/**
* Filters owner-only tools unless the sender is an owner or a server-side
* runtime grant authorizes a specific owner-only tool for this run.
*/
function applyOwnerOnlyToolPolicy(tools, senderIsOwner, ownerOnlyToolAllowlist) {
	const allowedOwnerOnlyTools = new Set(ownerOnlyToolAllowlist?.map((name) => normalizeToolName(name)) ?? []);
	const isAuthorized = (tool) => senderIsOwner || allowedOwnerOnlyTools.has(normalizeToolName(tool.name));
	const withGuard = tools.map((tool) => {
		if (!isOwnerOnlyTool(tool)) return tool;
		return wrapOwnerOnlyToolExecution(tool, isAuthorized(tool));
	});
	if (senderIsOwner) return withGuard;
	return withGuard.filter((tool) => !isOwnerOnlyTool(tool) || isAuthorized(tool));
}
function collectExplicitAllowlist(policies) {
	const entries = [];
	for (const policy of policies) {
		if (!policy?.allow) continue;
		for (const value of policy.allow) {
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
export { expandPluginGroups as a, mergeAlsoAllowPolicy as c, collectExplicitAllowlist as i, resolveOwnerOnlyToolApprovalClass as l, applyOwnerOnlyToolPolicy as n, expandPolicyWithPluginGroups as o, buildPluginToolGroups as r, isOwnerOnlyToolName as s, analyzeAllowlistByToolType as t };
