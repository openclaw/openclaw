import { x as isPlainObject } from "./utils-CCskKJVV.js";
import { o as loadInstalledPluginIndexInstallRecords, s as loadInstalledPluginIndexInstallRecordsSync } from "./manifest-registry-C9Iavh95.js";
import { H as isPluginLocalInvalidConfigSnapshot, R as materializeRuntimeConfig, T as validateConfigObjectWithPlugins, U as shouldAttemptLastKnownGoodRecovery } from "./io-BD1XQ5lD.js";
import "./installed-plugin-index-records-HUKXRLZh.js";
import { n as formatConfigIssueLines, r as formatConfigIssueSummary } from "./issue-format-u844k3jY.js";
import { m as resolveConfigWriteFollowUp } from "./runtime-snapshot-BXa0Udtg.js";
import { t as bumpSkillsSnapshotVersion } from "./refresh-state-BoghVd_F.js";
import { n as listPluginInstallTimestampMetadataPaths, r as listPluginInstallWholeRecordPaths, t as buildGatewayReloadPlan } from "./config-reload-plan-Bry1sCmk.js";
import { isDeepStrictEqual } from "node:util";
import chokidar from "chokidar";
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
export { resolveGatewayReloadSettings as n, startGatewayConfigReloader as r, diffConfigPaths as t };
