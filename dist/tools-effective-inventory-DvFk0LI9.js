import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as normalizeStaticProviderModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { n as resolveEffectiveToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { n as extractModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import { i as getPluginToolMeta, t as buildPluginToolMetadataKey } from "./tools-KpflAzxD.js";
import { S as getChannelAgentToolMeta } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { t as createOpenClawCodingTools } from "./pi-tools-iVT6BGHc.js";
import { r as resolveToolDisplay } from "./tool-display-CN2B3x-5.js";
import { n as summarizeToolDescriptionText } from "./tool-description-summary-Dy6DgmPc.js";
//#region src/agents/tools-effective-inventory.ts
function resolveEffectiveToolLabel(tool) {
	const rawLabel = normalizeOptionalString(tool.label) ?? "";
	if (rawLabel && normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)) return rawLabel;
	return resolveToolDisplay({ name: tool.name }).title;
}
function resolveRawToolDescription(tool) {
	return normalizeOptionalString(tool.description) ?? "";
}
function summarizeToolDescription(tool) {
	return summarizeToolDescriptionText({
		rawDescription: resolveRawToolDescription(tool),
		displaySummary: tool.displaySummary
	});
}
function resolveEffectiveToolSource(tool) {
	const pluginMeta = getPluginToolMeta(tool);
	if (pluginMeta) return {
		source: "plugin",
		pluginId: pluginMeta.pluginId
	};
	const channelMeta = getChannelAgentToolMeta(tool);
	if (channelMeta) return {
		source: "channel",
		channelId: channelMeta.channelId
	};
	return { source: "core" };
}
function groupLabel(source) {
	switch (source) {
		case "plugin": return "Connected tools";
		case "channel": return "Channel tools";
		default: return "Built-in tools";
	}
}
function listIncludesTool(list, toolName) {
	if (!Array.isArray(list)) return false;
	const normalizedToolName = normalizeToolName(toolName);
	return list.some((entry) => normalizeToolName(entry) === normalizedToolName);
}
function policyDeniesTool(policy, toolName) {
	return listIncludesTool(policy?.deny, toolName) || listIncludesTool(policy?.deny, "group:ui") || listIncludesTool(policy?.deny, "group:openclaw");
}
function hasExplicitBrowserIntent(cfg) {
	return cfg.browser?.enabled !== false && Boolean(cfg.browser || cfg.plugins?.entries?.browser);
}
function buildToolInventoryNotices(params) {
	if (params.entries.some((entry) => normalizeToolName(entry.id) === "browser") || !hasExplicitBrowserIntent(params.cfg)) return;
	if ([
		params.effectivePolicy.globalPolicy,
		params.effectivePolicy.globalProviderPolicy,
		params.effectivePolicy.agentPolicy,
		params.effectivePolicy.agentProviderPolicy
	].some((policy) => policyDeniesTool(policy, "browser"))) return [{
		id: "browser-denied-by-policy",
		severity: "info",
		message: "Browser is configured, but this session does not expose the browser tool because tool policy denies it. Remove the browser deny entry to use browser automation."
	}];
	if (params.profile !== "full") return [{
		id: "browser-filtered-by-profile",
		severity: "info",
		message: "Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: [\"browser\"] or agents.list[].tools.alsoAllow: [\"browser\"]; tools.subagents.tools.allow alone cannot add it back after profile filtering."
	}];
	if (Array.isArray(params.cfg.plugins?.allow) && !listIncludesTool(params.cfg.plugins.allow, "browser")) return [{
		id: "browser-plugin-not-allowed",
		severity: "warning",
		message: "Browser is configured, but plugins.allow does not include browser. Add \"browser\" to plugins.allow or remove the restrictive plugin allowlist."
	}];
}
function disambiguateLabels(entries) {
	const counts = /* @__PURE__ */ new Map();
	for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
	return entries.map((entry) => {
		if ((counts.get(entry.label) ?? 0) < 2) return entry;
		const suffix = entry.pluginId ?? entry.channelId ?? entry.id;
		return {
			...entry,
			label: `${entry.label} (${suffix})`
		};
	});
}
function resolveEffectiveModelCompat(params) {
	const provider = normalizeProviderId(params.modelProvider ?? "");
	const modelId = params.modelId?.trim() ?? "";
	if (!provider || !modelId) return;
	const providerConfig = findNormalizedProviderValue(params.cfg.models?.providers, provider);
	const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
	if (models.length === 0) return;
	const normalizedModelId = normalizeStaticProviderModelId(provider, modelId);
	const normalizedModelKey = normalizeLowercaseStringOrEmpty(normalizedModelId);
	const providerPrefixedModelKey = normalizeLowercaseStringOrEmpty(`${provider}/${normalizedModelId}`);
	return extractModelCompat(models.find((model) => {
		const key = normalizeLowercaseStringOrEmpty(normalizeStaticProviderModelId(provider, model.id));
		return key === normalizedModelKey || key === providerPrefixedModelKey;
	}));
}
function resolveEffectiveToolInventory(params) {
	const agentId = params.agentId?.trim() || resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
	const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);
	const modelCompat = resolveEffectiveModelCompat({
		cfg: params.cfg,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	const effectiveTools = createOpenClawCodingTools({
		agentId,
		sessionKey: params.sessionKey,
		workspaceDir,
		agentDir,
		config: params.cfg,
		modelProvider: params.modelProvider,
		modelId: params.modelId,
		modelCompat,
		messageProvider: params.messageProvider,
		senderId: params.senderId,
		senderName: params.senderName ?? void 0,
		senderUsername: params.senderUsername ?? void 0,
		senderE164: params.senderE164 ?? void 0,
		agentAccountId: params.accountId ?? void 0,
		currentChannelId: params.currentChannelId,
		currentThreadTs: params.currentThreadTs,
		currentMessageId: params.currentMessageId,
		groupId: params.groupId ?? void 0,
		groupChannel: params.groupChannel ?? void 0,
		groupSpace: params.groupSpace ?? void 0,
		replyToMode: params.replyToMode,
		allowGatewaySubagentBinding: true,
		modelHasVision: params.modelHasVision,
		requireExplicitMessageTarget: params.requireExplicitMessageTarget,
		disableMessageTool: params.disableMessageTool
	});
	const effectivePolicy = resolveEffectiveToolPolicy({
		config: params.cfg,
		agentId,
		sessionKey: params.sessionKey,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	const profile = effectivePolicy.providerProfile ?? effectivePolicy.profile ?? "full";
	const pluginToolMetadata = new Map((getActivePluginRegistry()?.toolMetadata ?? []).map((entry) => [buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName), entry.metadata]));
	const entries = disambiguateLabels(effectiveTools.map((tool) => {
		const source = resolveEffectiveToolSource(tool);
		const metadata = source.pluginId ? pluginToolMetadata.get(buildPluginToolMetadataKey(source.pluginId, tool.name)) : void 0;
		return Object.assign({
			id: tool.name,
			label: normalizeOptionalString(metadata?.displayName) ?? resolveEffectiveToolLabel(tool),
			description: normalizeOptionalString(metadata?.description) ?? summarizeToolDescription(tool),
			rawDescription: normalizeOptionalString(metadata?.description) ?? resolveRawToolDescription(tool) ?? summarizeToolDescription(tool),
			...metadata?.risk ? { risk: metadata.risk } : {},
			...metadata?.tags ? { tags: metadata.tags } : {}
		}, source);
	}).toSorted((a, b) => a.label.localeCompare(b.label)));
	const notices = buildToolInventoryNotices({
		cfg: params.cfg,
		profile,
		entries,
		effectivePolicy
	});
	const groupsBySource = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const tools = groupsBySource.get(entry.source) ?? [];
		tools.push(entry);
		groupsBySource.set(entry.source, tools);
	}
	return {
		agentId,
		profile,
		groups: [
			"core",
			"plugin",
			"channel"
		].map((source) => {
			const tools = groupsBySource.get(source);
			if (!tools || tools.length === 0) return null;
			return {
				id: source,
				label: groupLabel(source),
				source,
				tools
			};
		}).filter((group) => group !== null),
		...notices ? { notices } : {}
	};
}
//#endregion
export { resolveEffectiveToolInventory as t };
