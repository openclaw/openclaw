import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-rLXLMlFF.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-qQaS3sFD.js";
import { u as mergeAlsoAllowPolicy } from "./tool-policy-D7FuUKMD.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-sJn6q6QE.js";
//#region src/commands/doctor/shared/preview-warnings.ts
const channelDoctorModuleLoader = createLazyImportLoader(() => import("./channel-doctor-DclvMY-2.js"));
function loadChannelDoctorModule() {
	return channelDoctorModuleLoader.load();
}
function hasRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
	return (cfg.agents?.list ?? []).some((agent) => {
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
	const agents = cfg.agents?.list ?? [];
	if (agents.length === 0) return resolveMessageToolAvailability({ globalTools: cfg.tools }) ? [] : ["default tool policy"];
	return agents.flatMap((agent) => resolveMessageToolAvailability({
		globalTools: cfg.tools,
		agentTools: agent.tools
	}) ? [] : [`agent "${agent.id}"`]);
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
async function collectDoctorPreviewWarnings(params) {
	const warnings = [];
	const env = params.env ?? process.env;
	const hasChannelConfig = hasChannels(params.cfg);
	const hasPluginConfig = hasPlugins(params.cfg);
	warnings.push(...collectVisibleReplyToolPolicyWarnings(params.cfg));
	const channelPluginRuntime = hasChannelConfig && hasExplicitChannelPluginBlockerConfig(params.cfg) ? await import("./channel-plugin-blockers-D1umYPLy.js") : void 0;
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
		const { collectOpenPolicyAllowFromWarnings, maybeRepairOpenPolicyAllowFrom } = await import("./open-policy-allowfrom-D6TO-FT8.js");
		const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
		if (allowFromScan.changes.length > 0) warnings.push(collectOpenPolicyAllowFromWarnings({
			changes: allowFromScan.changes,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if ((hasPluginConfig || hasChannelConfig) && params.cfg.plugins?.enabled !== false) {
		const { collectStalePluginConfigWarnings, isStalePluginAutoRepairBlocked, scanStalePluginConfig } = await import("./stale-plugin-config-BevQ7rPw.js");
		const stalePluginHits = scanStalePluginConfig(params.cfg, env);
		if (stalePluginHits.length > 0) warnings.push(collectStalePluginConfigWarnings({
			hits: stalePluginHits,
			doctorFixCommand: params.doctorFixCommand,
			autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, env)
		}).join("\n"));
	}
	if (hasPluginConfig) {
		const { collectCodexRouteWarnings } = await import("./codex-route-warnings-CR7nAari.js");
		warnings.push(...collectCodexRouteWarnings({
			cfg: params.cfg,
			env
		}));
	}
	const { collectCodexNativeAssetWarnings } = await import("./codex-native-assets-DTdG4UC2.js");
	warnings.push(...await collectCodexNativeAssetWarnings({
		cfg: params.cfg,
		env
	}));
	if (hasPluginLoadPaths(params.cfg)) {
		const { collectBundledPluginLoadPathWarnings, scanBundledPluginLoadPathMigrations } = await import("./bundled-plugin-load-paths-CR1KcazN.js");
		const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, env);
		if (bundledPluginLoadPathHits.length > 0) warnings.push(collectBundledPluginLoadPathWarnings({
			hits: bundledPluginLoadPathHits,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if (hasChannelConfig) {
		const { createChannelDoctorEmptyAllowlistPolicyHooks } = await loadChannelDoctorModule();
		const { scanEmptyAllowlistPolicyWarnings } = await import("./empty-allowlist-scan-CzFLEELK.js");
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
			const { sanitizeForLog } = await import("./ansi-Cu8F_SAv.js");
			warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
		}
	}
	if (hasToolsBySenderKey(params.cfg)) {
		const { collectLegacyToolsBySenderWarnings, scanLegacyToolsBySenderKeys } = await import("./legacy-tools-by-sender-C3fSiqcj.js");
		const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
		if (toolsBySenderHits.length > 0) warnings.push(collectLegacyToolsBySenderWarnings({
			hits: toolsBySenderHits,
			doctorFixCommand: params.doctorFixCommand
		}).join("\n"));
	}
	if (hasConfiguredSafeBins(params.cfg)) {
		const { collectExecSafeBinCoverageWarnings, collectExecSafeBinTrustedDirHintWarnings, scanExecSafeBinCoverage, scanExecSafeBinTrustedDirHints } = await import("./exec-safe-bins-BB2xdPci.js");
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
