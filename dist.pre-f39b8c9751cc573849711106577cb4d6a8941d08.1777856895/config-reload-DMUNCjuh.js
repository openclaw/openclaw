import { x as isPlainObject } from "./utils-CCskKJVV.js";
import { o as loadInstalledPluginIndexInstallRecords, s as loadInstalledPluginIndexInstallRecordsSync } from "./manifest-registry-C9Iavh95.js";
import { H as isPluginLocalInvalidConfigSnapshot, R as materializeRuntimeConfig, T as validateConfigObjectWithPlugins, U as shouldAttemptLastKnownGoodRecovery } from "./io-DJ0qH7nz.js";
import "./installed-plugin-index-records-J72_jxlC.js";
import { n as formatConfigIssueLines, r as formatConfigIssueSummary } from "./issue-format-CIl7cU3M.js";
import { m as resolveConfigWriteFollowUp } from "./runtime-snapshot-BbDqBMPM.js";
import { a as getActivePluginRegistry, n as getActivePluginChannelRegistryVersion, s as getActivePluginRegistryVersion } from "./runtime-BB5JwDDz.js";
import { i as listChannelPlugins } from "./registry-BVxojULH.js";
import "./plugins-DgDChB_6.js";
import { t as bumpSkillsSnapshotVersion } from "./refresh-state-zcU0w5co.js";
import { isDeepStrictEqual } from "node:util";
import chokidar from "chokidar";
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
	},
	{
		prefix: "canvasHost",
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
//#region src/gateway/config-reload.ts
const DEFAULT_RELOAD_SETTINGS = {
	mode: "hybrid",
	debounceMs: 300
};
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;
/**
* Paths under `skills.*` always change the snapshot that sessions cache in
* sessions.json. Any prefix match here (for example `skills.allowBundled`,
* `skills.entries.X.enabled`, `skills.profile`) forces sessions to rebuild
* their snapshot on the next turn rather than silently advertising stale
* tools to the model.
*/
const SKILLS_INVALIDATION_PREFIXES = ["skills"];
function matchesSkillsInvalidationPrefix(path) {
	return SKILLS_INVALIDATION_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}
function firstSkillsChangedPath(changedPaths) {
	return changedPaths.find(matchesSkillsInvalidationPrefix);
}
function isNoopReloadPlan(plan) {
	return !plan.restartGateway && plan.hotReasons.length === 0 && !plan.reloadHooks && !plan.restartGmailWatcher && !plan.restartCron && !plan.restartHeartbeat && !plan.restartHealthMonitor && !plan.reloadPlugins && !plan.disposeMcpRuntimes && plan.restartChannels.size === 0;
}
function resolvePluginLocalInvalidReloadSnapshot(params) {
	if (!isPluginLocalInvalidConfigSnapshot(params.snapshot)) return null;
	const validated = validateConfigObjectWithPlugins(params.snapshot.sourceConfig, { pluginValidation: "skip" });
	if (!validated.ok) return null;
	const runtimeConfig = materializeRuntimeConfig(validated.config, "load");
	for (const issue of params.snapshot.issues) params.log.warn(`config reload skipped plugin config validation issue at ${issue.path}: ${issue.message}. Run "openclaw doctor --fix" to quarantine the plugin config.`);
	return {
		...params.snapshot,
		sourceConfig: params.snapshot.sourceConfig,
		resolved: params.snapshot.resolved,
		valid: true,
		runtimeConfig,
		config: runtimeConfig,
		issues: [],
		warnings: [
			...params.snapshot.warnings,
			...params.snapshot.issues,
			...validated.warnings
		]
	};
}
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
function resolveGatewayReloadSettings(cfg) {
	const rawMode = cfg.gateway?.reload?.mode;
	const mode = rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid" ? rawMode : DEFAULT_RELOAD_SETTINGS.mode;
	const debounceRaw = cfg.gateway?.reload?.debounceMs;
	return {
		mode,
		debounceMs: typeof debounceRaw === "number" && Number.isFinite(debounceRaw) ? Math.max(0, Math.floor(debounceRaw)) : DEFAULT_RELOAD_SETTINGS.debounceMs
	};
}
function asPluginInstallConfig(records) {
	return { plugins: { installs: records } };
}
function startGatewayConfigReloader(opts) {
	let currentConfig = opts.initialConfig;
	let currentCompareConfig = opts.initialCompareConfig ?? opts.initialConfig;
	let settings = resolveGatewayReloadSettings(currentConfig);
	let debounceTimer = null;
	let pending = false;
	let running = false;
	let stopped = false;
	let restartQueued = false;
	let missingConfigRetries = 0;
	let pendingInProcessConfig = null;
	let lastAppliedWriteHash = opts.initialInternalWriteHash ?? null;
	let currentPluginInstallRecords = opts.initialPluginInstallRecords ?? loadInstalledPluginIndexInstallRecordsSync();
	const readPluginInstallRecords = opts.readPluginInstallRecords ?? loadInstalledPluginIndexInstallRecords;
	const scheduleAfter = (wait) => {
		if (stopped) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			runReload();
		}, wait);
	};
	const schedule = () => {
		scheduleAfter(settings.debounceMs);
	};
	const queueRestart = (plan, nextConfig) => {
		if (restartQueued) return;
		restartQueued = true;
		(async () => {
			try {
				await opts.onRestart(plan, nextConfig);
			} catch (err) {
				restartQueued = false;
				opts.log.error(`config restart failed: ${String(err)}`);
			}
		})();
	};
	const handleMissingSnapshot = (snapshot) => {
		if (snapshot.exists) {
			missingConfigRetries = 0;
			return false;
		}
		if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
			missingConfigRetries += 1;
			opts.log.info(`config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`);
			scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
			return true;
		}
		opts.log.warn("config reload skipped (config file not found)");
		return true;
	};
	const handleInvalidSnapshot = (snapshot) => {
		if (snapshot.valid) return false;
		const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
		opts.log.warn(`config reload skipped (invalid config): ${issues}`);
		return true;
	};
	const recoverAndReadSnapshot = async (snapshot, reason) => {
		if (!opts.recoverSnapshot) return null;
		if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
			opts.log.warn(`config reload recovery skipped after ${reason}: invalidity is scoped to plugin entries`);
			return null;
		}
		if (!await opts.recoverSnapshot(snapshot, reason)) return null;
		const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
		opts.log.warn(`config reload restored last-known-good config after ${reason}${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`);
		const nextSnapshot = await opts.readSnapshot();
		if (!nextSnapshot.valid) {
			const issues = formatConfigIssueLines(nextSnapshot.issues, "").join(", ");
			opts.log.warn(`config reload recovery snapshot is invalid: ${issues}`);
			return null;
		}
		try {
			await opts.onRecovered?.({
				reason,
				snapshot,
				recoveredSnapshot: nextSnapshot
			});
		} catch (err) {
			opts.log.warn(`config reload recovery notice failed: ${String(err)}`);
		}
		return nextSnapshot;
	};
	const applySnapshot = async (nextConfig, nextCompareConfig, afterWrite) => {
		const configChangedPaths = diffConfigPaths(currentCompareConfig, nextCompareConfig);
		const configPluginInstallTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(currentCompareConfig, nextCompareConfig);
		const configPluginInstallWholeRecordPaths = listPluginInstallWholeRecordPaths(currentCompareConfig, nextCompareConfig);
		let nextPluginInstallRecords = currentPluginInstallRecords;
		try {
			nextPluginInstallRecords = await readPluginInstallRecords();
		} catch (err) {
			opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
		}
		const previousPluginInstallConfig = asPluginInstallConfig(currentPluginInstallRecords);
		const nextPluginInstallConfig = asPluginInstallConfig(nextPluginInstallRecords);
		const pluginInstallRecordChangedPaths = diffConfigPaths(previousPluginInstallConfig, nextPluginInstallConfig);
		const pluginInstallRecordTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(previousPluginInstallConfig, nextPluginInstallConfig);
		const pluginInstallRecordWholeRecordPaths = listPluginInstallWholeRecordPaths(previousPluginInstallConfig, nextPluginInstallConfig);
		const changedPaths = [...configChangedPaths, ...pluginInstallRecordChangedPaths];
		const pluginInstallTimestampNoopPaths = [...configPluginInstallTimestampNoopPaths, ...pluginInstallRecordTimestampNoopPaths];
		const pluginInstallWholeRecordPaths = [...configPluginInstallWholeRecordPaths, ...pluginInstallRecordWholeRecordPaths];
		currentConfig = nextConfig;
		currentCompareConfig = nextCompareConfig;
		currentPluginInstallRecords = nextPluginInstallRecords;
		settings = resolveGatewayReloadSettings(nextConfig);
		if (changedPaths.length === 0) return;
		const skillsChangedPath = firstSkillsChangedPath(changedPaths);
		if (skillsChangedPath !== void 0) {
			bumpSkillsSnapshotVersion({
				reason: "config-change",
				changedPath: skillsChangedPath
			});
			opts.log.info(`skills snapshot invalidated by config change (${skillsChangedPath})`);
		}
		const followUp = resolveConfigWriteFollowUp(afterWrite);
		opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
		if (followUp.mode === "none") {
			opts.log.info(`config reload skipped by writer intent (${followUp.reason})`);
			return;
		}
		const plan = buildGatewayReloadPlan(changedPaths, {
			noopPaths: pluginInstallTimestampNoopPaths,
			forceChangedPaths: pluginInstallWholeRecordPaths
		});
		if (isNoopReloadPlan(plan) && !followUp.requiresRestart) return;
		if (settings.mode === "off") {
			opts.log.info("config reload disabled (gateway.reload.mode=off)");
			return;
		}
		if (followUp.requiresRestart) {
			queueRestart({
				...plan,
				restartGateway: true,
				restartReasons: [...plan.restartReasons, followUp.reason]
			}, nextConfig);
			return;
		}
		if (settings.mode === "restart") {
			queueRestart(plan, nextConfig);
			return;
		}
		if (plan.restartGateway) {
			if (settings.mode === "hot") {
				opts.log.warn(`config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(", ")})`);
				return;
			}
			queueRestart(plan, nextConfig);
			return;
		}
		await opts.onHotReload(plan, nextConfig);
	};
	const promoteAcceptedSnapshot = async (snapshot, reason) => {
		if (!opts.promoteSnapshot || !snapshot.exists || !snapshot.valid) return;
		try {
			await opts.promoteSnapshot(snapshot, reason);
		} catch (err) {
			opts.log.warn(`config reload last-known-good promotion failed: ${String(err)}`);
		}
	};
	const promoteAcceptedInProcessWrite = async (persistedHash) => {
		if (!opts.promoteSnapshot) return;
		try {
			const snapshot = await opts.readSnapshot();
			if (snapshot.hash !== persistedHash || !snapshot.valid) return;
			await promoteAcceptedSnapshot(snapshot, "in-process-write");
		} catch (err) {
			opts.log.warn(`config reload in-process last-known-good promotion failed: ${String(err)}`);
		}
	};
	const runReload = async () => {
		if (stopped) return;
		if (running) {
			pending = true;
			return;
		}
		running = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		try {
			if (pendingInProcessConfig) {
				const pendingWrite = pendingInProcessConfig;
				pendingInProcessConfig = null;
				missingConfigRetries = 0;
				await applySnapshot(pendingWrite.config, pendingWrite.compareConfig, pendingWrite.afterWrite);
				await promoteAcceptedInProcessWrite(pendingWrite.persistedHash);
				return;
			}
			let snapshot = await opts.readSnapshot();
			if (lastAppliedWriteHash && typeof snapshot.hash === "string") {
				if (snapshot.hash === lastAppliedWriteHash) return;
				lastAppliedWriteHash = null;
			}
			if (handleMissingSnapshot(snapshot)) return;
			let degradedPluginSnapshot = false;
			if (!snapshot.valid) {
				const recoveredSnapshot = await recoverAndReadSnapshot(snapshot, "invalid-config");
				if (!recoveredSnapshot) {
					const pluginLocalSnapshot = resolvePluginLocalInvalidReloadSnapshot({
						snapshot,
						log: opts.log
					});
					if (!pluginLocalSnapshot) {
						handleInvalidSnapshot(snapshot);
						return;
					}
					snapshot = pluginLocalSnapshot;
					degradedPluginSnapshot = true;
				} else snapshot = recoveredSnapshot;
			}
			await applySnapshot(snapshot.config, snapshot.sourceConfig);
			if (!degradedPluginSnapshot) await promoteAcceptedSnapshot(snapshot, "valid-config");
		} catch (err) {
			opts.log.error(`config reload failed: ${String(err)}`);
		} finally {
			running = false;
			if (pending) {
				pending = false;
				schedule();
			}
		}
	};
	const watcher = chokidar.watch(opts.watchPath, {
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: 200,
			pollInterval: 50
		},
		usePolling: Boolean(process.env.VITEST)
	});
	const scheduleFromWatcher = () => {
		schedule();
	};
	const unsubscribeFromWrites = opts.subscribeToWrites?.((event) => {
		if (event.configPath !== opts.watchPath) return;
		pendingInProcessConfig = {
			config: event.runtimeConfig,
			compareConfig: event.sourceConfig,
			persistedHash: event.persistedHash,
			afterWrite: event.afterWrite
		};
		lastAppliedWriteHash = event.persistedHash;
		scheduleAfter(0);
	}) ?? (() => {});
	watcher.on("add", scheduleFromWatcher);
	watcher.on("change", scheduleFromWatcher);
	watcher.on("unlink", scheduleFromWatcher);
	let watcherClosed = false;
	watcher.on("error", (err) => {
		if (watcherClosed) return;
		watcherClosed = true;
		opts.log.warn(`config watcher error: ${String(err)}`);
		watcher.close().catch(() => {});
	});
	return { stop: async () => {
		stopped = true;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = null;
		watcherClosed = true;
		unsubscribeFromWrites();
		await watcher.close().catch(() => {});
	} };
}
//#endregion
export { buildGatewayReloadPlan as i, resolveGatewayReloadSettings as n, startGatewayConfigReloader as r, diffConfigPaths as t };
