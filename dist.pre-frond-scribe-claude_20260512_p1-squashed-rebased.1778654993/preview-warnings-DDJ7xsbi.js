import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { c as normalizeAgentId } from "./session-key-8g_Q03Po.js";
import { r as resolveAgentConfig } from "./agent-scope-config-Du7CC6LK.js";
import { r as normalizeChatChannelId } from "./ids-YIFU9WN6.js";
import { i as listRouteBindings } from "./bindings-BXxGfRPi.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-DKLlyleI.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-C87JPsbp.js";
import { u as mergeAlsoAllowPolicy } from "./tool-policy-Bmp2N959.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-C0NjNbhZ.js";
import { i as resolveAgentRoute } from "./resolve-route-_9VOy7HK.js";
//#region src/routing/channel-route-targets.ts
const CHANNELS_CONFIG_META_KEYS = new Set(["defaults", "modelByChannel"]);
function hasRecord$1(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizeConfiguredChannelKey(raw) {
	return normalizeChatChannelId(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}
function normalizeRouteBindingChannelKey(raw) {
	return normalizeLowercaseStringOrEmpty(raw);
}
function listConfiguredChannelIds(cfg) {
	if (!hasRecord$1(cfg.channels)) return [];
	return Object.entries(cfg.channels).filter(([id, value]) => {
		if (CHANNELS_CONFIG_META_KEYS.has(id)) return false;
		return !(hasRecord$1(value) && value.enabled === false);
	}).map(([id]) => normalizeConfiguredChannelKey(id)).filter(Boolean).toSorted();
}
function listConfiguredChannelAccountIds(cfg, channelId) {
	if (!hasRecord$1(cfg.channels)) return [];
	const channel = Object.entries(cfg.channels).find(([id]) => normalizeConfiguredChannelKey(id) === channelId)?.[1];
	if (!hasRecord$1(channel) || !hasRecord$1(channel.accounts)) return [];
	return Object.entries(channel.accounts).filter(([, value]) => !(hasRecord$1(value) && value.enabled === false)).map(([accountId]) => normalizeAccountId(accountId)).filter(Boolean).toSorted();
}
function addTarget(byAgent, agentId, channel) {
	const normalizedAgentId = normalizeAgentId(agentId);
	const trimmedChannel = channel.trim();
	if (!normalizedAgentId || !trimmedChannel) return;
	const channels = byAgent.get(normalizedAgentId) ?? /* @__PURE__ */ new Set();
	channels.add(trimmedChannel);
	byAgent.set(normalizedAgentId, channels);
}
function collectChannelRouteTargets(cfg) {
	const byAgent = /* @__PURE__ */ new Map();
	for (const binding of listRouteBindings(cfg)) addTarget(byAgent, binding.agentId, normalizeRouteBindingChannelKey(binding.match.channel));
	for (const channel of listConfiguredChannelIds(cfg)) {
		const accountIds = listConfiguredChannelAccountIds(cfg, channel);
		const sampledAccountIds = accountIds.length > 0 ? accountIds : [DEFAULT_ACCOUNT_ID];
		for (const accountId of sampledAccountIds) addTarget(byAgent, resolveAgentRoute({
			cfg,
			channel,
			accountId
		}).agentId, channel);
	}
	return Array.from(byAgent.entries()).map(([agentId, channels]) => ({
		agentId,
		channels: Array.from(channels).toSorted()
	})).filter((target) => target.channels.length > 0).toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}
//#endregion
//#region src/commands/doctor/shared/preview-warnings.ts
const channelDoctorModuleLoader = createLazyImportLoader(() => import("./channel-doctor-DCLzK_rH.js"));
function loadChannelDoctorModule() {
	return channelDoctorModuleLoader.load();
}
function hasRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function listAgentRecords(cfg) {
	return Array.isArray(cfg.agents?.list) ? cfg.agents.list.filter(hasRecord) : [];
}
function hasChannels(cfg) {
	return hasRecord(cfg.channels);
}
function hasPlugins(cfg) {
	return hasRecord(cfg.plugins);
}
function hasPluginLoadPaths(cfg) {
	const plugins = cfg.plugins;
	if (!hasRecord(plugins)) return false;
	const load = plugins.load;
	return hasRecord(load) && Array.isArray(load.paths) && load.paths.length > 0;
}
function hasExplicitChannelPluginBlockerConfig(cfg) {
	if (cfg.plugins?.enabled === false) return true;
	const entries = cfg.plugins?.entries;
	if (!hasRecord(entries)) return false;
	return Object.values(entries).some((entry) => hasRecord(entry) && "enabled" in entry && entry.enabled === false);
}
function hasToolsBySenderKey(value) {
	if (Array.isArray(value)) return value.some(hasToolsBySenderKey);
	if (!hasRecord(value)) return false;
	if (hasRecord(value.toolsBySender)) return true;
	return Object.entries(value).some(([key, nested]) => key !== "toolsBySender" && hasToolsBySenderKey(nested));
}
function hasConfiguredSafeBins(cfg) {
	const globalExec = cfg.tools?.exec;
	if (hasRecord(globalExec) && Array.isArray(globalExec.safeBins) && globalExec.safeBins.length > 0) return true;
	return listAgentRecords(cfg).some((agent) => {
		const agentExec = hasRecord(agent) && hasRecord(agent.tools) ? agent.tools.exec : void 0;
		return hasRecord(agentExec) && Array.isArray(agentExec.safeBins) && agentExec.safeBins.length > 0;
	});
}
function resolveMessageToolAvailability(params) {
	const profile = params.agentTools?.profile ?? params.globalTools?.profile;
	const profileAlsoAllow = Array.isArray(params.agentTools?.alsoAllow) ? params.agentTools.alsoAllow : Array.isArray(params.globalTools?.alsoAllow) ? params.globalTools.alsoAllow : void 0;
	return isToolAllowedByPolicies("message", [
		mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow),
		pickSandboxToolPolicy(params.globalTools),
		pickSandboxToolPolicy(params.agentTools)
	]);
}
function collectMessageToolUnavailableTargets(cfg) {
	const agents = listAgentRecords(cfg);
	if (agents.length === 0) return resolveMessageToolAvailability({ globalTools: cfg.tools }) ? [] : ["default tool policy"];
	return agents.flatMap((agent) => resolveMessageToolAvailability({
		globalTools: cfg.tools,
		agentTools: agent.tools
	}) ? [] : [`agent "${typeof agent.id === "string" ? agent.id : "unknown"}"`]);
}
function resolveGroupVisibleReplyProvenance(cfg) {
	const groupVisibleReplies = cfg.messages?.groupChat?.visibleReplies;
	if (groupVisibleReplies) return {
		path: "messages.groupChat.visibleReplies",
		provenance: "group-explicit",
		value: groupVisibleReplies
	};
	const globalVisibleReplies = cfg.messages?.visibleReplies;
	if (globalVisibleReplies) return {
		path: "messages.visibleReplies",
		provenance: "global-explicit",
		value: globalVisibleReplies
	};
	return {
		path: "messages.groupChat.visibleReplies",
		provenance: "default",
		value: "message_tool"
	};
}
function formatTargets(targets) {
	if (targets.length <= 2) return targets.join(" and ");
	return `${targets.slice(0, 2).join(", ")}, and ${targets.length - 2} more`;
}
function collectVisibleReplyToolPolicyWarnings(cfg) {
	const targets = collectMessageToolUnavailableTargets(cfg);
	if (targets.length === 0) return [];
	const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
	const warnings = [];
	if (groupPolicy.value === "message_tool") {
		if (groupPolicy.provenance === "default" && !hasChannels(cfg)) return warnings;
		const targetSummary = formatTargets(targets);
		if (groupPolicy.provenance === "default") warnings.push(`- messages.groupChat.visibleReplies defaults to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic group/channel replies to avoid silent responses. Enable the message tool or set messages.groupChat.visibleReplies explicitly.`);
		else warnings.push(`- ${groupPolicy.path} is set to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic visible replies, so normal replies may post to the source chat. Enable the message tool or set ${groupPolicy.path} to "automatic".`);
	}
	if (cfg.messages?.visibleReplies === "message_tool" && groupPolicy.path !== "messages.visibleReplies") warnings.push(`- messages.visibleReplies is set to "message_tool", but the message tool is unavailable for ${formatTargets(targets)}; OpenClaw falls back to automatic direct-chat replies, so normal replies may post to the source chat. Enable the message tool or set messages.visibleReplies to "automatic".`);
	return warnings;
}
function formatChannelList(channels) {
	if (channels.length <= 2) return channels.map((channel) => `"${channel}"`).join(" and ");
	return `${channels.slice(0, 2).map((channel) => `"${channel}"`).join(", ")}, and ${channels.length - 2} more`;
}
function collectChannelBoundMessageToolPolicyWarnings(cfg) {
	return collectChannelRouteTargets(cfg).flatMap((target) => {
		const agentTools = resolveAgentConfig(cfg, target.agentId)?.tools;
		if (resolveMessageToolAvailability({
			globalTools: cfg.tools,
			agentTools
		})) return [];
		return [`- Agent "${target.agentId}" is routed from channel ${formatChannelList(target.channels)}, but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.`];
	});
}
async function collectDoctorPreviewWarnings(params) {
	const warnings = [];
	const env = params.env ?? process.env;
	const hasChannelConfig = hasChannels(params.cfg);
	const hasPluginConfig = hasPlugins(params.cfg);
	warnings.push(...collectVisibleReplyToolPolicyWarnings(params.cfg));
	warnings.push(...collectChannelBoundMessageToolPolicyWarnings(params.cfg));
	const channelPluginRuntime = hasChannelConfig && hasExplicitChannelPluginBlockerConfig(params.cfg) ? await import("./channel-plugin-blockers-CJIrl0my.js") : void 0;
	const channelPluginBlockerHits = channelPluginRuntime?.scanConfiguredChannelPluginBlockers(params.cfg, env) ?? [];
	if (channelPluginRuntime && channelPluginBlockerHits.length > 0) warnings.push(channelPluginRuntime.collectConfiguredChannelPluginBlockerWarnings(channelPluginBlockerHits).join("\n"));
	if (hasChannelConfig) {
		const { collectChannelDoctorPreviewWarnings } = await loadChannelDoctorModule();
		const channelDoctorWarnings = await collectChannelDoctorPreviewWarnings({
			cfg: params.cfg,
			doctorFixCommand: params.doctorFixCommand,
			env
		});
		if (channelDoctorWarnings.length > 0) warnings.push(...channelDoctorWarnings);
		const { collectOpenPolicyAllowFromWarnings, maybeRepairOpenPolicyAllowFrom } = await import("./open-policy-allowfrom-DRiDINBp.js");
		const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
		if (allowFromScan.changes.length > 0) warnings.push(collectOpenPolicyAllowFromWarnings({
			changes: allowFromScan.changes,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if ((hasPluginConfig || hasChannelConfig) && params.cfg.plugins?.enabled !== false) {
		const { collectStalePluginConfigWarnings, isStalePluginAutoRepairBlocked, scanStalePluginConfig } = await import("./stale-plugin-config-BeK2EMcf.js");
		const stalePluginHits = scanStalePluginConfig(params.cfg, env);
		if (stalePluginHits.length > 0) warnings.push(collectStalePluginConfigWarnings({
			hits: stalePluginHits,
			doctorFixCommand: params.doctorFixCommand,
			autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, env)
		}).join("\n"));
	}
	if (hasPluginConfig) {
		const { collectCodexRouteWarnings } = await import("./codex-route-warnings-BG7leop0.js");
		warnings.push(...collectCodexRouteWarnings({
			cfg: params.cfg,
			env
		}));
	}
	const { collectCodexNativeAssetWarnings } = await import("./codex-native-assets-BcNaht8u.js");
	warnings.push(...await collectCodexNativeAssetWarnings({
		cfg: params.cfg,
		env
	}));
	if (hasPluginLoadPaths(params.cfg)) {
		const { collectBundledPluginLoadPathWarnings, scanBundledPluginLoadPathMigrations } = await import("./bundled-plugin-load-paths-CQLzOJoh.js");
		const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, env);
		if (bundledPluginLoadPathHits.length > 0) warnings.push(collectBundledPluginLoadPathWarnings({
			hits: bundledPluginLoadPathHits,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if (hasChannelConfig) {
		const { createChannelDoctorEmptyAllowlistPolicyHooks } = await loadChannelDoctorModule();
		const { scanEmptyAllowlistPolicyWarnings } = await import("./empty-allowlist-scan-CN5xU4l8.js");
		const emptyAllowlistHooks = createChannelDoctorEmptyAllowlistPolicyHooks({
			cfg: params.cfg,
			env
		});
		const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
			doctorFixCommand: params.doctorFixCommand,
			extraWarningsForAccount: emptyAllowlistHooks.extraWarningsForAccount,
			shouldSkipDefaultEmptyGroupAllowlistWarning: emptyAllowlistHooks.shouldSkipDefaultEmptyGroupAllowlistWarning
		}).filter((warning) => !(channelPluginRuntime?.isWarningBlockedByChannelPlugin(warning, channelPluginBlockerHits) ?? false));
		if (emptyAllowlistWarnings.length > 0) {
			const { sanitizeForLog } = await import("./ansi-C3pgsTnW.js");
			warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
		}
	}
	if (hasToolsBySenderKey(params.cfg)) {
		const { collectLegacyToolsBySenderWarnings, scanLegacyToolsBySenderKeys } = await import("./legacy-tools-by-sender-D5g14HC5.js");
		const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
		if (toolsBySenderHits.length > 0) warnings.push(collectLegacyToolsBySenderWarnings({
			hits: toolsBySenderHits,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if (hasConfiguredSafeBins(params.cfg)) {
		const { collectExecSafeBinCoverageWarnings, collectExecSafeBinTrustedDirHintWarnings, scanExecSafeBinCoverage, scanExecSafeBinTrustedDirHints } = await import("./exec-safe-bins-BJmNQSOc.js");
		const safeBinCoverage = scanExecSafeBinCoverage(params.cfg);
		if (safeBinCoverage.length > 0) warnings.push(collectExecSafeBinCoverageWarnings({
			hits: safeBinCoverage,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
		const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(params.cfg);
		if (safeBinTrustedDirHints.length > 0) warnings.push(collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"));
	}
	return warnings;
}
//#endregion
export { collectDoctorPreviewWarnings };
