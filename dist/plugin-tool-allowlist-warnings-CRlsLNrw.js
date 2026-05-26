import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { o as normalizePluginId } from "./config-state-CjJBf8PG.js";
import "./defaults-mDjiWzE5.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as parseModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import { n as matchesAnyGlobPattern, t as compileGlobPatterns } from "./glob-pattern-CrqljM7B.js";
import { h as resolveToolProfilePolicy, l as mergeAlsoAllowPolicy, m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { r as sanitizeServerName } from "./pi-bundle-mcp-names-Dkhn57WY.js";
//#region src/commands/doctor/shared/plugin-tool-allowlist-warnings.ts
function hasRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizePluginIdMaybe(value) {
	return typeof value === "string" && value.trim() ? normalizePluginId(value) : void 0;
}
function collectListSource(params) {
	if (!Array.isArray(params.value)) return;
	const entries = params.value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
	if (entries.length > 0) params.out.push({
		label: params.label,
		entries
	});
}
function collectToolPolicySources(policy, label, out) {
	if (!hasRecord(policy)) return;
	collectListSource({
		out,
		value: policy.allow,
		label: `${label}.allow`
	});
	collectListSource({
		out,
		value: policy.alsoAllow,
		label: `${label}.alsoAllow`
	});
	if (hasRecord(policy.byProvider)) for (const [providerId, providerPolicy] of Object.entries(policy.byProvider)) collectToolPolicySources(providerPolicy, `${label}.byProvider.${providerId}`, out);
	collectToolPolicySources(hasRecord(policy.sandbox) ? policy.sandbox.tools : void 0, `${label}.sandbox.tools`, out);
	collectToolPolicySources(hasRecord(policy.subagents) ? policy.subagents.tools : void 0, `${label}.subagents.tools`, out);
}
function collectToolAllowlistSources(cfg) {
	const sources = [];
	collectToolPolicySources(cfg.tools, "tools", sources);
	const agentList = cfg.agents?.list;
	if (Array.isArray(agentList)) agentList.forEach((agent, index) => {
		if (!hasRecord(agent)) return;
		collectToolPolicySources(agent.tools, `agents.list[${index}].tools`, sources);
	});
	return sources;
}
function collectSortedSourceLabels(labels) {
	return [...new Set(labels)].toSorted((left, right) => left.localeCompare(right));
}
function formatSortedSourceLabels(sorted) {
	if (sorted.length <= 3) return sorted.join(", ");
	return `${sorted.slice(0, 3).join(", ")} (+${sorted.length - 3} more)`;
}
function formatSourceLabels(labels) {
	return formatSortedSourceLabels(collectSortedSourceLabels(labels));
}
function formatSourceLabelSubject(labels) {
	const sorted = collectSortedSourceLabels(labels);
	return {
		text: formatSortedSourceLabels(sorted),
		verb: sorted.length === 1 ? "does" : "do"
	};
}
function collectToolOwners(registry) {
	const owners = /* @__PURE__ */ new Map();
	for (const plugin of registry.plugins) {
		const pluginId = normalizePluginId(plugin.id);
		for (const toolNameRaw of plugin.contracts?.tools ?? []) {
			const toolName = normalizeToolName(toolNameRaw);
			if (!toolName) continue;
			owners.set(toolName, [...owners.get(toolName) ?? [], pluginId]);
		}
	}
	return owners;
}
function collectKnownPluginIds(registry) {
	return new Set(registry.plugins.map((plugin) => normalizePluginId(plugin.id)));
}
function collectConfiguredMcpServerNames(cfg) {
	const servers = cfg.mcp?.servers;
	if (!hasRecord(servers)) return [];
	return Object.entries(servers).filter(([, value]) => hasRecord(value)).map(([name]) => name.trim()).filter(Boolean).toSorted((left, right) => left.localeCompare(right));
}
function normalizeProviderKey(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	const slashIndex = normalized.indexOf("/");
	if (slashIndex <= 0) return normalizeProviderId(normalized);
	const provider = normalizeProviderId(normalized.slice(0, slashIndex));
	const modelId = normalized.slice(slashIndex + 1);
	return modelId ? `${provider}/${modelId}` : provider;
}
function isCanonicalProviderKey(value) {
	return normalizeLowercaseStringOrEmpty(value) === normalizeProviderKey(value);
}
function asToolPolicyConfig(value) {
	return hasRecord(value) ? value : void 0;
}
function resolveProviderToolPolicy(params) {
	if (!hasRecord(params.byProvider)) return;
	const provider = normalizeProviderId(params.modelProvider);
	const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
	const providerModel = modelId ? `${provider}/${modelId}` : void 0;
	const lookup = /* @__PURE__ */ new Map();
	for (const [key, value] of Object.entries(params.byProvider)) {
		const normalizedKey = normalizeProviderKey(key);
		const policy = asToolPolicyConfig(value);
		if (normalizedKey && policy) {
			const canonical = isCanonicalProviderKey(key);
			const existing = lookup.get(normalizedKey);
			if (!existing || canonical && !existing.canonical) lookup.set(normalizedKey, {
				canonical,
				policy
			});
		}
	}
	return (providerModel ? lookup.get(providerModel)?.policy : void 0) ?? lookup.get(provider)?.policy;
}
function resolvePrimaryModelRef(cfg, agentModel) {
	return parseModelRef(resolveAgentModelPrimaryValue(agentModel) ?? resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "gpt-5.5", "openai", { allowPluginNormalization: false }) ?? {
		provider: "openai",
		model: "gpt-5.5"
	};
}
function isSandboxModeActive(mode) {
	return mode === "all" || mode === "non-main";
}
function getList(value, key) {
	if (!hasRecord(value)) return;
	const raw = value[key];
	if (!Array.isArray(raw)) return;
	return raw.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}
function pickSandboxToolPolicyField(params) {
	const agentValue = hasRecord(params.agentPolicy) ? params.agentPolicy[params.key] : void 0;
	if (Array.isArray(agentValue)) return {
		value: agentValue,
		label: `${params.agentLabel}.${params.key}`,
		defined: true
	};
	const globalValue = hasRecord(params.globalPolicy) ? params.globalPolicy[params.key] : void 0;
	if (Array.isArray(globalValue)) return {
		value: globalValue,
		label: `tools.sandbox.tools.${params.key}`,
		defined: true
	};
	return {
		value: void 0,
		defined: false
	};
}
function buildEffectiveSandboxToolPolicy(params) {
	const agentLabel = params.agentLabel ?? "agents.list[].tools.sandbox.tools";
	const allow = pickSandboxToolPolicyField({
		agentPolicy: params.agentPolicy,
		globalPolicy: params.globalPolicy,
		key: "allow",
		agentLabel
	});
	const alsoAllow = pickSandboxToolPolicyField({
		agentPolicy: params.agentPolicy,
		globalPolicy: params.globalPolicy,
		key: "alsoAllow",
		agentLabel
	});
	const deny = pickSandboxToolPolicyField({
		agentPolicy: params.agentPolicy,
		globalPolicy: params.globalPolicy,
		key: "deny",
		agentLabel
	});
	const policy = {};
	if (allow.defined) policy.allow = allow.value;
	if (alsoAllow.defined) policy.alsoAllow = alsoAllow.value;
	if (deny.defined) policy.deny = deny.value;
	const allowLabels = [allow.label, alsoAllow.label].filter((label) => Boolean(label));
	const labels = allowLabels.length > 0 ? allowLabels : ["tools.sandbox.tools.alsoAllow (unset)"];
	return {
		labels,
		dedupeKey: Array.from(new Set([...labels, deny.label].filter(Boolean))).join("\0"),
		policy,
		nonSandboxToolPolicyBlocksMcp: params.nonSandboxToolPolicyBlocksMcp
	};
}
function collectActiveSandboxToolPolicies(cfg, serverNames) {
	const out = /* @__PURE__ */ new Map();
	const globalPolicy = cfg.tools?.sandbox?.tools;
	const globalToolPolicyBlocksMcp = nonSandboxToolPoliciesBlockMcp({
		cfg,
		serverNames
	});
	const addPolicy = (entry) => {
		const existing = out.get(entry.dedupeKey);
		if (existing && !existing.nonSandboxToolPolicyBlocksMcp) return;
		out.set(entry.dedupeKey, entry);
	};
	const addGlobalPolicy = () => {
		addPolicy(buildEffectiveSandboxToolPolicy({
			globalPolicy,
			nonSandboxToolPolicyBlocksMcp: globalToolPolicyBlocksMcp
		}));
	};
	const defaultSandboxActive = isSandboxModeActive(cfg.agents?.defaults?.sandbox?.mode);
	if (defaultSandboxActive) addGlobalPolicy();
	const agentList = cfg.agents?.list;
	if (Array.isArray(agentList)) agentList.forEach((agent, index) => {
		if (!hasRecord(agent)) return;
		const explicitMode = (hasRecord(agent.sandbox) ? agent.sandbox : void 0)?.mode;
		if (!(explicitMode === void 0 ? defaultSandboxActive : isSandboxModeActive(explicitMode))) return;
		const agentTools = hasRecord(agent.tools) ? agent.tools : void 0;
		const agentToolsSandbox = hasRecord(agentTools?.sandbox) ? agentTools.sandbox : void 0;
		addPolicy(buildEffectiveSandboxToolPolicy({
			agentPolicy: hasRecord(agentToolsSandbox?.tools) ? agentToolsSandbox.tools : void 0,
			agentLabel: `agents.list[${index}].tools.sandbox.tools`,
			globalPolicy,
			nonSandboxToolPolicyBlocksMcp: nonSandboxToolPoliciesBlockMcp({
				cfg,
				serverNames,
				agent
			})
		}));
	});
	return [...out.values()];
}
function buildMcpProbeToolNames(serverNames) {
	const usedNames = /* @__PURE__ */ new Set();
	return serverNames.map((serverName) => `${sanitizeServerName(serverName, usedNames)}__probe`);
}
function buildMcpToolNamePrefixes(serverNames) {
	const usedNames = /* @__PURE__ */ new Set();
	return serverNames.map((serverName) => normalizeToolName(`${sanitizeServerName(serverName, usedNames)}__`)).filter(Boolean);
}
function entriesMatchMcpTool(entries, serverNames, mode) {
	const normalizedEntries = entries.map(normalizeToolName).filter(Boolean);
	if (normalizedEntries.some((entry) => entry === "*" || entry === "bundle-mcp" || entry === "group:plugins")) return true;
	const serverPrefixes = buildMcpToolNamePrefixes(serverNames);
	const patterns = compileGlobPatterns({
		raw: normalizedEntries,
		normalize: normalizeToolName
	});
	const probeNames = buildMcpProbeToolNames(serverNames).map(normalizeToolName);
	const prefixOrPatternMatches = (prefix, index) => normalizedEntries.some((entry) => entry.length > prefix.length && entry.startsWith(prefix)) || matchesAnyGlobPattern(probeNames[index] ?? "", patterns);
	return mode === "every" ? serverPrefixes.every((prefix, index) => prefixOrPatternMatches(prefix, index)) : serverPrefixes.some((prefix, index) => prefixOrPatternMatches(prefix, index));
}
function entriesMatchAnyMcpTool(entries, serverNames) {
	return entriesMatchMcpTool(entries, serverNames, "any");
}
function entriesMatchEveryMcpTool(entries, serverNames) {
	return entriesMatchMcpTool(entries, serverNames, "every");
}
function sandboxPolicyAllowsAllMcpServers(policy, serverNames) {
	const allow = getList(policy, "allow");
	if (Array.isArray(allow) && allow.length === 0) return true;
	return entriesMatchEveryMcpTool([...allow ?? [], ...getList(policy, "alsoAllow") ?? []], serverNames);
}
function toolPolicyAllowsAnyMcpServer(policy, serverNames) {
	const allow = getList(policy, "allow");
	if (Array.isArray(allow) && allow.length === 0) return true;
	return entriesMatchAnyMcpTool([...allow ?? [], ...getList(policy, "alsoAllow") ?? []], serverNames);
}
function toolPolicyDeniesAllMcpServers(policy, serverNames) {
	return entriesMatchEveryMcpTool(getList(policy, "deny") ?? [], serverNames);
}
function sandboxPolicyIntentionallyDeniesAllMcpServers(policy, serverNames) {
	return toolPolicyDeniesAllMcpServers(policy, serverNames);
}
function nonSandboxToolPolicyBlocksMcp(policy, serverNames) {
	if (toolPolicyDeniesAllMcpServers(policy, serverNames)) return true;
	const allow = getList(policy, "allow");
	if (!Array.isArray(allow) || allow.length === 0) return false;
	return !entriesMatchAnyMcpTool([...allow, ...getList(policy, "alsoAllow") ?? []], serverNames);
}
function profileToolPolicyBlocksMcp(policy, serverNames) {
	const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(hasRecord(policy) && typeof policy.profile === "string" ? policy.profile : ""), getList(policy, "alsoAllow"));
	return Boolean(profilePolicy && !toolPolicyAllowsAnyMcpServer(profilePolicy, serverNames));
}
function nonSandboxToolPoliciesBlockMcp(params) {
	const globalTools = params.cfg.tools;
	const agentTools = asToolPolicyConfig(params.agent?.tools);
	const modelRef = resolvePrimaryModelRef(params.cfg, params.agent?.model);
	const globalProviderPolicy = resolveProviderToolPolicy({
		byProvider: globalTools?.byProvider,
		modelProvider: modelRef.provider,
		modelId: modelRef.model
	});
	const agentProviderPolicy = resolveProviderToolPolicy({
		byProvider: agentTools?.byProvider,
		modelProvider: modelRef.provider,
		modelId: modelRef.model
	});
	const profilePolicy = {
		profile: agentTools?.profile ?? globalTools?.profile,
		alsoAllow: agentTools?.alsoAllow ?? globalTools?.alsoAllow
	};
	const providerProfilePolicy = {
		profile: agentProviderPolicy?.profile ?? globalProviderPolicy?.profile,
		alsoAllow: agentProviderPolicy?.alsoAllow ?? globalProviderPolicy?.alsoAllow
	};
	return profileToolPolicyBlocksMcp(profilePolicy, params.serverNames) || profileToolPolicyBlocksMcp(providerProfilePolicy, params.serverNames) || nonSandboxToolPolicyBlocksMcp(globalTools, params.serverNames) || nonSandboxToolPolicyBlocksMcp(globalProviderPolicy, params.serverNames) || nonSandboxToolPolicyBlocksMcp(agentTools, params.serverNames) || nonSandboxToolPolicyBlocksMcp(agentProviderPolicy, params.serverNames);
}
function formatMcpServerSummary(serverNames) {
	const noun = serverNames.length === 1 ? "server" : "servers";
	const listed = serverNames.slice(0, 3).map((serverName) => `"${serverName}"`).join(", ");
	const suffix = serverNames.length > 3 ? `, +${serverNames.length - 3} more` : "";
	return `${serverNames.length} MCP ${noun}${listed ? ` (${listed}${suffix})` : ""}`;
}
function collectSandboxMcpAllowlistWarnings(cfg) {
	const serverNames = collectConfiguredMcpServerNames(cfg);
	if (serverNames.length === 0) return [];
	const sandboxPolicies = collectActiveSandboxToolPolicies(cfg, serverNames);
	if (sandboxPolicies.length === 0) return [];
	const issueSources = sandboxPolicies.filter(({ policy }) => !sandboxPolicyAllowsAllMcpServers(policy, serverNames) && !sandboxPolicyIntentionallyDeniesAllMcpServers(policy, serverNames)).filter(({ nonSandboxToolPolicyBlocksMcp }) => !nonSandboxToolPolicyBlocksMcp).flatMap(({ labels }) => labels);
	if (issueSources.length === 0) return [];
	const sourceSubject = formatSourceLabelSubject(issueSources);
	return [`- mcp.servers defines ${formatMcpServerSummary(serverNames)}, but ${sourceSubject.text} ${sourceSubject.verb} not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.`];
}
function formatPluginList(pluginIds) {
	if (pluginIds.length === 1) return `"${pluginIds[0]}"`;
	return pluginIds.map((pluginId) => `"${pluginId}"`).join(", ");
}
function addIssue(issues, key, sourceLabel) {
	const sources = issues.get(key) ?? /* @__PURE__ */ new Set();
	sources.add(sourceLabel);
	issues.set(key, sources);
}
function collectPluginToolAllowlistWarnings(params) {
	if (params.cfg.plugins?.enabled === false) return [];
	const warnings = collectSandboxMcpAllowlistWarnings(params.cfg);
	const allowedPluginIds = (params.cfg.plugins?.allow ?? []).map(normalizePluginIdMaybe).filter((pluginId) => Boolean(pluginId));
	const allowedPlugins = new Set(allowedPluginIds);
	if (allowedPlugins.size === 0) return warnings;
	const sources = collectToolAllowlistSources(params.cfg);
	if (sources.length === 0) return warnings;
	const wildcardSources = sources.filter((source) => source.entries.some((entry) => normalizeToolName(entry) === "*")).map((source) => source.label);
	if (wildcardSources.length > 0) warnings.push(`- plugins.allow is an exclusive plugin allowlist. ${formatSourceLabels(wildcardSources)} contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.`);
	const exactEntries = sources.flatMap((source) => source.entries.map((entry) => ({
		source: source.label,
		entry: normalizeToolName(entry)
	})).filter(({ entry }) => entry && entry !== "*" && entry !== "group:plugins"));
	if (exactEntries.length === 0) return warnings;
	const registry = params.manifestRegistry ?? loadManifestMetadataSnapshot({
		config: params.cfg,
		env: params.env ?? process.env
	}).manifestRegistry;
	const knownPluginIds = collectKnownPluginIds(registry);
	const toolOwners = collectToolOwners(registry);
	const missingPluginIssues = /* @__PURE__ */ new Map();
	const missingToolOwnerIssues = /* @__PURE__ */ new Map();
	for (const { source, entry } of exactEntries) {
		const pluginId = normalizePluginId(entry);
		if (knownPluginIds.has(pluginId) && !allowedPlugins.has(pluginId)) {
			addIssue(missingPluginIssues, pluginId, source);
			continue;
		}
		const owners = (toolOwners.get(entry) ?? []).filter((ownerPluginId) => !allowedPlugins.has(ownerPluginId));
		if (owners.length > 0 && owners.length === (toolOwners.get(entry) ?? []).length) addIssue(missingToolOwnerIssues, `${entry}\u0000${owners.join("\0")}`, source);
	}
	for (const [pluginId, issueSources] of [...missingPluginIssues.entries()].toSorted((left, right) => left[0].localeCompare(right[0]))) warnings.push(`- ${formatSourceLabels(issueSources)} references plugin "${pluginId}", but plugins.allow does not include it. Add "${pluginId}" to plugins.allow or remove plugins.allow.`);
	for (const [issueKey, issueSources] of [...missingToolOwnerIssues.entries()].toSorted((left, right) => left[0].localeCompare(right[0]))) {
		const [toolName, ...ownerPluginIds] = issueKey.split("\0");
		if (!toolName) continue;
		warnings.push(`- ${formatSourceLabels(issueSources)} references tool "${toolName}", owned by plugin ${formatPluginList(ownerPluginIds)}, but plugins.allow does not include the owning plugin. Add ${formatPluginList(ownerPluginIds)} to plugins.allow or remove plugins.allow.`);
	}
	return warnings;
}
function collectBundledProviderAllowlistPolicyWarnings(params) {
	if (params.cfg.plugins?.enabled === false) return [];
	const allow = params.cfg.plugins?.allow;
	if (!Array.isArray(allow) || allow.length === 0) return [];
	if (params.cfg.plugins?.bundledDiscovery !== "compat") return [];
	return ["- plugins.allow is restrictive, but bundled provider discovery is still in legacy compatibility mode. Bundled provider plugins can still appear in runtime provider inventories; set plugins.bundledDiscovery to \"allowlist\" after confirming omitted bundled providers are intentionally blocked."];
}
//#endregion
export { collectBundledProviderAllowlistPolicyWarnings, collectPluginToolAllowlistWarnings };
