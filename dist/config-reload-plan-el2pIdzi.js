import { x as isPlainObject } from "./utils-sBTEdeml.js";
import { a as getActivePluginRegistry, n as getActivePluginChannelRegistryVersion, s as getActivePluginRegistryVersion } from "./runtime-DHxRl5F1.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { isDeepStrictEqual } from "node:util";
//#region src/gateway/config-diff.ts
function diffConfigPaths(prev, next, prefix = "") {
	if (prev === next) return [];
	if (isPlainObject(prev) && isPlainObject(next)) {
		const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
		const paths = [];
		for (const key of keys) {
			const prevValue = prev[key];
			const nextValue = next[key];
			if (prevValue === void 0 && nextValue === void 0) continue;
			const childPaths = diffConfigPaths(prevValue, nextValue, prefix ? `${prefix}.${key}` : key);
			if (childPaths.length > 0) paths.push(...childPaths);
		}
		return paths;
	}
	if (Array.isArray(prev) && Array.isArray(next)) {
		if (isDeepStrictEqual(prev, next)) return [];
	}
	return [prefix || "<root>"];
}
//#endregion
//#region src/gateway/config-reload-plan.ts
const BASE_RELOAD_RULES = [
	{
		prefix: "gateway.remote",
		kind: "none"
	},
	{
		prefix: "gateway.reload",
		kind: "none"
	},
	{
		prefix: "gateway.channelHealthCheckMinutes",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "gateway.channelStaleEventThresholdMinutes",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "gateway.channelMaxRestartsPerHour",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "diagnostics.stuckSessionWarnMs",
		kind: "none"
	},
	{
		prefix: "diagnostics.stuckSessionAbortMs",
		kind: "none"
	},
	{
		prefix: "diagnostics.memoryPressureSnapshot",
		kind: "hot"
	},
	{
		prefix: "hooks.gmail",
		kind: "hot",
		actions: ["restart-gmail-watcher"]
	},
	{
		prefix: "hooks",
		kind: "hot",
		actions: ["reload-hooks"]
	},
	{
		prefix: "agents.defaults.heartbeat",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agents.defaults.models",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agents.defaults.model",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "models.pricing",
		kind: "restart"
	},
	{
		prefix: "models",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agents.list",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agent.heartbeat",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "cron",
		kind: "hot",
		actions: ["restart-cron"]
	},
	{
		prefix: "mcp",
		kind: "hot",
		actions: ["dispose-mcp-runtimes"]
	},
	{
		prefix: "plugins.load",
		kind: "restart"
	},
	{
		prefix: "plugins.installs",
		kind: "restart"
	}
];
const BASE_RELOAD_RULES_TAIL = [
	{
		prefix: "meta",
		kind: "none"
	},
	{
		prefix: "identity",
		kind: "none"
	},
	{
		prefix: "wizard",
		kind: "none"
	},
	{
		prefix: "logging",
		kind: "none"
	},
	{
		prefix: "agents",
		kind: "none"
	},
	{
		prefix: "tools",
		kind: "none"
	},
	{
		prefix: "bindings",
		kind: "none"
	},
	{
		prefix: "audio",
		kind: "none"
	},
	{
		prefix: "agent",
		kind: "none"
	},
	{
		prefix: "routing",
		kind: "none"
	},
	{
		prefix: "messages",
		kind: "none"
	},
	{
		prefix: "session",
		kind: "none"
	},
	{
		prefix: "talk",
		kind: "none"
	},
	{
		prefix: "skills",
		kind: "none"
	},
	{
		prefix: "secrets",
		kind: "none"
	},
	{
		prefix: "plugins",
		kind: "hot",
		actions: ["reload-plugins", "dispose-mcp-runtimes"]
	},
	{
		prefix: "ui",
		kind: "none"
	},
	{
		prefix: "gateway",
		kind: "restart"
	},
	{
		prefix: "discovery",
		kind: "restart"
	}
];
let cachedReloadRules = null;
let cachedRegistry = null;
let cachedActiveRegistryVersion = -1;
let cachedChannelRegistryVersion = -1;
function listReloadRules() {
	const registry = getActivePluginRegistry();
	const activeRegistryVersion = getActivePluginRegistryVersion();
	const channelRegistryVersion = getActivePluginChannelRegistryVersion();
	if (registry !== cachedRegistry || activeRegistryVersion !== cachedActiveRegistryVersion || channelRegistryVersion !== cachedChannelRegistryVersion) {
		cachedReloadRules = null;
		cachedRegistry = registry;
		cachedActiveRegistryVersion = activeRegistryVersion;
		cachedChannelRegistryVersion = channelRegistryVersion;
	}
	if (cachedReloadRules) return cachedReloadRules;
	const channelReloadRules = listChannelPlugins().flatMap((plugin) => (plugin.reload?.configPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "hot",
		actions: [`restart-channel:${plugin.id}`]
	})).concat((plugin.reload?.noopPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "none"
	}))));
	const channelPluginStateRules = listChannelPlugins().flatMap((plugin) => [{
		prefix: `plugins.entries.${plugin.id}`,
		kind: "hot",
		actions: [
			"reload-plugins",
			"dispose-mcp-runtimes",
			`restart-channel:${plugin.id}`
		]
	}]);
	const pluginReloadRules = (registry?.reloads ?? []).flatMap((entry) => (entry.registration.restartPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "restart"
	})).concat((entry.registration.hotPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "hot"
	})), (entry.registration.noopPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "none"
	}))));
	const rules = [
		...BASE_RELOAD_RULES,
		...pluginReloadRules,
		...channelReloadRules,
		...channelPluginStateRules,
		...BASE_RELOAD_RULES_TAIL
	];
	cachedReloadRules = rules;
	return rules;
}
function matchRule(path) {
	for (const rule of listReloadRules()) if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule;
	return null;
}
function resolveConfigReloadMetadata(path) {
	if (isPluginInstallTimestampPath(path)) return { kind: "none" };
	return { kind: matchRule(path)?.kind ?? "restart" };
}
function isPluginInstallTimestampPath(path) {
	return /^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(path);
}
function getPluginInstallRecords(config) {
	if (!isPlainObject(config)) return {};
	const plugins = config.plugins;
	if (!isPlainObject(plugins)) return {};
	const installs = plugins.installs;
	return isPlainObject(installs) ? installs : {};
}
function listPluginInstallTimestampMetadataPaths(prevConfig, nextConfig) {
	const prevInstalls = getPluginInstallRecords(prevConfig);
	const nextInstalls = getPluginInstallRecords(nextConfig);
	const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
	const paths = [];
	for (const id of ids) {
		const prevRecord = prevInstalls[id];
		const nextRecord = nextInstalls[id];
		if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) continue;
		for (const key of ["installedAt", "resolvedAt"]) if (prevRecord[key] !== nextRecord[key]) paths.push(`plugins.installs.${id}.${key}`);
	}
	return paths;
}
function listPluginInstallWholeRecordPaths(prevConfig, nextConfig) {
	const prevInstalls = getPluginInstallRecords(prevConfig);
	const nextInstalls = getPluginInstallRecords(nextConfig);
	const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
	const paths = [];
	for (const id of ids) {
		const prevRecord = prevInstalls[id];
		const nextRecord = nextInstalls[id];
		if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) paths.push(`plugins.installs.${id}`);
	}
	return paths;
}
function buildGatewayReloadPlan(changedPaths, options = {}) {
	const noopPaths = new Set(options.noopPaths);
	const forceChangedPaths = new Set(options.forceChangedPaths);
	const plan = {
		changedPaths,
		restartGateway: false,
		restartReasons: [],
		hotReasons: [],
		reloadHooks: false,
		restartGmailWatcher: false,
		restartCron: false,
		restartHeartbeat: false,
		restartHealthMonitor: false,
		reloadPlugins: false,
		restartChannels: /* @__PURE__ */ new Set(),
		disposeMcpRuntimes: false,
		noopPaths: []
	};
	const applyAction = (action) => {
		if (action.startsWith("restart-channel:")) {
			const channel = action.slice(16);
			plan.restartChannels.add(channel);
			return;
		}
		switch (action) {
			case "reload-hooks":
				plan.reloadHooks = true;
				break;
			case "restart-gmail-watcher":
				plan.restartGmailWatcher = true;
				break;
			case "restart-cron":
				plan.restartCron = true;
				break;
			case "restart-heartbeat":
				plan.restartHeartbeat = true;
				break;
			case "restart-health-monitor":
				plan.restartHealthMonitor = true;
				break;
			case "reload-plugins":
				plan.reloadPlugins = true;
				break;
			case "dispose-mcp-runtimes":
				plan.disposeMcpRuntimes = true;
				break;
			default: break;
		}
	};
	for (const path of changedPaths) {
		if (!forceChangedPaths.has(path) && (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path))) {
			plan.noopPaths.push(path);
			continue;
		}
		const rule = matchRule(path);
		if (!rule) {
			plan.restartGateway = true;
			plan.restartReasons.push(path);
			continue;
		}
		if (rule.kind === "restart") {
			plan.restartGateway = true;
			plan.restartReasons.push(path);
			continue;
		}
		if (rule.kind === "none") {
			plan.noopPaths.push(path);
			continue;
		}
		plan.hotReasons.push(path);
		for (const action of rule.actions ?? []) applyAction(action);
	}
	if (plan.restartGmailWatcher) plan.reloadHooks = true;
	return plan;
}
//#endregion
export { diffConfigPaths as a, resolveConfigReloadMetadata as i, listPluginInstallTimestampMetadataPaths as n, listPluginInstallWholeRecordPaths as r, buildGatewayReloadPlan as t };
