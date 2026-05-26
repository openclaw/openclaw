import { r as theme } from "./theme-D58JpUfy.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { n as promptYesNo } from "./prompt-BsiHocog.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { a as withPluginInstallRecords, o as withoutPluginInstallRecords } from "./installed-plugin-index-records-BrXfmg6n.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { i as readInstalledPackageVersion, t as expectedIntegrityForUpdate } from "./package-update-utils-CHd2_V9N.js";
import { t as recordHookInstall } from "./installs-NoGXzNgf.js";
import { r as commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit-Cwrnavi6.js";
import { t as refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh-OLbBO5Xj.js";
import { r as resolveHookInstallDir, t as installHooksFromNpmSpec } from "./install-ChKTQEPK.js";
import { i as updateNpmInstalledPlugins } from "./update-B9jZfD-S.js";
//#region src/hooks/update.ts
function createHookPackUpdateIntegrityDriftHandler(params) {
	return async (drift) => {
		const payload = {
			hookId: params.hookId,
			spec: drift.spec,
			expectedIntegrity: drift.expectedIntegrity,
			actualIntegrity: drift.actualIntegrity,
			resolution: drift.resolution,
			resolvedSpec: drift.resolution.resolvedSpec,
			resolvedVersion: drift.resolution.version,
			dryRun: params.dryRun
		};
		if (params.onIntegrityDrift) return await params.onIntegrityDrift(payload);
		params.logger.warn?.(`Integrity drift for hook pack "${params.hookId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`);
		return false;
	};
}
async function updateNpmInstalledHookPacks(params) {
	const logger = params.logger ?? {};
	const installs = params.config.hooks?.internal?.installs ?? {};
	const targets = params.hookIds?.length ? params.hookIds : Object.keys(installs);
	const outcomes = [];
	let next = params.config;
	let changed = false;
	for (const hookId of targets) {
		const record = installs[hookId];
		if (!record) {
			outcomes.push({
				hookId,
				status: "skipped",
				message: `No install record for hook pack "${hookId}".`
			});
			continue;
		}
		if (record.source !== "npm") {
			outcomes.push({
				hookId,
				status: "skipped",
				message: `Skipping hook pack "${hookId}" (source: ${record.source}).`
			});
			continue;
		}
		const effectiveSpec = params.specOverrides?.[hookId] ?? record.spec;
		const expectedIntegrity = effectiveSpec === record.spec ? expectedIntegrityForUpdate(record.spec, record.integrity) : void 0;
		if (!effectiveSpec) {
			outcomes.push({
				hookId,
				status: "skipped",
				message: `Skipping hook pack "${hookId}" (missing npm spec).`
			});
			continue;
		}
		let installPath;
		try {
			installPath = record.installPath ?? resolveHookInstallDir(hookId);
		} catch (err) {
			outcomes.push({
				hookId,
				status: "error",
				message: `Invalid install path for hook pack "${hookId}": ${String(err)}`
			});
			continue;
		}
		const currentVersion = await readInstalledPackageVersion(installPath);
		const result = await installHooksFromNpmSpec({
			spec: effectiveSpec,
			mode: "update",
			dryRun: params.dryRun,
			expectedHookPackId: hookId,
			expectedIntegrity,
			onIntegrityDrift: createHookPackUpdateIntegrityDriftHandler({
				hookId,
				dryRun: Boolean(params.dryRun),
				logger,
				onIntegrityDrift: params.onIntegrityDrift
			}),
			logger
		});
		if (!result.ok) {
			outcomes.push({
				hookId,
				status: "error",
				message: `Failed to ${params.dryRun ? "check" : "update"} hook pack "${hookId}": ${result.error}`
			});
			continue;
		}
		const nextVersion = result.version ?? await readInstalledPackageVersion(result.targetDir);
		const currentLabel = currentVersion ?? "unknown";
		const nextLabel = nextVersion ?? "unknown";
		const status = currentVersion && nextVersion && currentVersion === nextVersion ? "unchanged" : "updated";
		if (params.dryRun) {
			outcomes.push({
				hookId,
				status,
				currentVersion: currentVersion ?? void 0,
				nextVersion: nextVersion ?? void 0,
				message: status === "unchanged" ? `Hook pack "${hookId}" is up to date (${currentLabel}).` : `Would update hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`
			});
			continue;
		}
		next = recordHookInstall(next, {
			hookId,
			source: "npm",
			spec: effectiveSpec,
			installPath: result.targetDir,
			version: nextVersion,
			resolvedName: result.npmResolution?.name,
			resolvedSpec: result.npmResolution?.resolvedSpec,
			integrity: result.npmResolution?.integrity,
			hooks: result.hooks
		});
		changed = true;
		outcomes.push({
			hookId,
			status,
			currentVersion: currentVersion ?? void 0,
			nextVersion: nextVersion ?? void 0,
			message: status === "unchanged" ? `Hook pack "${hookId}" already at ${currentLabel}.` : `Updated hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`
		});
	}
	return {
		config: next,
		changed,
		outcomes
	};
}
//#endregion
//#region src/cli/plugins-update-outcomes.ts
function logPluginUpdateOutcomes(params) {
	let hasErrors = false;
	for (const outcome of params.outcomes) {
		if (outcome.status === "error") {
			hasErrors = true;
			params.log(theme.error(outcome.message));
			continue;
		}
		if (outcome.status === "skipped") {
			params.log(theme.warn(outcome.message));
			continue;
		}
		params.log(outcome.message);
	}
	return { hasErrors };
}
//#endregion
//#region src/cli/plugins-install-records.ts
function extractInstalledNpmPackageName(install) {
	if (install.source !== "npm") return;
	const resolvedName = install.resolvedName?.trim();
	if (resolvedName) return resolvedName;
	return (install.spec ? parseRegistryNpmSpec(install.spec)?.name : void 0) ?? (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : void 0);
}
function extractInstalledNpmHookPackageName(install) {
	const resolvedName = install.resolvedName?.trim();
	if (resolvedName) return resolvedName;
	return (install.spec ? parseRegistryNpmSpec(install.spec)?.name : void 0) ?? (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : void 0);
}
//#endregion
//#region src/cli/plugins-update-selection.ts
function resolvePluginUpdateSelection(params) {
	if (params.all) return { pluginIds: Object.keys(params.installs) };
	if (!params.rawId) return { pluginIds: [] };
	if (params.rawId in params.installs) return { pluginIds: [params.rawId] };
	const parsedSpec = parseRegistryNpmSpec(params.rawId);
	if (!parsedSpec) return { pluginIds: [params.rawId] };
	const matches = Object.entries(params.installs).filter(([, install]) => {
		return extractInstalledNpmPackageName(install) === parsedSpec.name;
	});
	if (matches.length !== 1) return { pluginIds: [params.rawId] };
	const [pluginId] = matches[0];
	if (!pluginId) return { pluginIds: [params.rawId] };
	if (parsedSpec.selectorKind === "none") return {
		pluginIds: [pluginId],
		specOverrides: { [pluginId]: parsedSpec.raw }
	};
	return {
		pluginIds: [pluginId],
		specOverrides: { [pluginId]: parsedSpec.raw }
	};
}
function resolveHookPackUpdateSelection(params) {
	if (params.all) return { hookIds: Object.keys(params.installs) };
	if (!params.rawId) return { hookIds: [] };
	if (params.rawId in params.installs) return { hookIds: [params.rawId] };
	const parsedSpec = parseRegistryNpmSpec(params.rawId);
	if (!parsedSpec || parsedSpec.selectorKind === "none") return { hookIds: [] };
	const matches = Object.entries(params.installs).filter(([, install]) => {
		return extractInstalledNpmHookPackageName(install) === parsedSpec.name;
	});
	if (matches.length !== 1) return { hookIds: [] };
	const [hookId] = matches[0];
	if (!hookId) return { hookIds: [] };
	return {
		hookIds: [hookId],
		specOverrides: { [hookId]: parsedSpec.raw }
	};
}
//#endregion
//#region src/cli/plugins-update-command.ts
async function runPluginUpdateCommand(params) {
	assertConfigWriteAllowedInCurrentMode();
	const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
	const cfg = getRuntimeConfig();
	const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
	const cfgWithPluginInstallRecords = withPluginInstallRecords(cfg, pluginInstallRecords);
	const logger = {
		info: (msg) => defaultRuntime.log(msg),
		warn: (msg) => defaultRuntime.log(theme.warn(msg))
	};
	const pluginSelection = resolvePluginUpdateSelection({
		installs: pluginInstallRecords,
		rawId: params.id,
		all: params.opts.all
	});
	const hookSelection = resolveHookPackUpdateSelection({
		installs: cfg.hooks?.internal?.installs ?? {},
		rawId: params.id,
		all: params.opts.all
	});
	if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
		if (params.opts.all) {
			defaultRuntime.log("No tracked plugins or hook packs to update.");
			return;
		}
		defaultRuntime.error("Provide a plugin or hook-pack id, or use --all.");
		return defaultRuntime.exit(1);
	}
	const pluginResult = await updateNpmInstalledPlugins({
		config: cfgWithPluginInstallRecords,
		pluginIds: pluginSelection.pluginIds,
		specOverrides: pluginSelection.specOverrides,
		dryRun: params.opts.dryRun,
		dangerouslyForceUnsafeInstall: params.opts.dangerouslyForceUnsafeInstall,
		logger,
		onIntegrityDrift: async (drift) => {
			const specLabel = drift.resolvedSpec ?? drift.spec;
			defaultRuntime.log(theme.warn(`Integrity drift detected for "${drift.pluginId}" (${specLabel})\nExpected: ${drift.expectedIntegrity}\nActual:   ${drift.actualIntegrity}`));
			if (drift.dryRun) return true;
			return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
		}
	});
	const hookResult = await updateNpmInstalledHookPacks({
		config: pluginResult.config,
		hookIds: hookSelection.hookIds,
		specOverrides: hookSelection.specOverrides,
		dryRun: params.opts.dryRun,
		logger,
		onIntegrityDrift: async (drift) => {
			const specLabel = drift.resolvedSpec ?? drift.spec;
			defaultRuntime.log(theme.warn(`Integrity drift detected for hook pack "${drift.hookId}" (${specLabel})\nExpected: ${drift.expectedIntegrity}\nActual:   ${drift.actualIntegrity}`));
			if (drift.dryRun) return true;
			return await promptYesNo(`Continue updating hook pack "${drift.hookId}" with this artifact?`);
		}
	});
	const outcomeSummary = logPluginUpdateOutcomes({
		outcomes: [...pluginResult.outcomes, ...hookResult.outcomes],
		log: (message) => defaultRuntime.log(message)
	});
	if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
		const nextPluginInstallRecords = pluginResult.config.plugins?.installs ?? {};
		const shouldPersistPluginInstallIndex = pluginResult.changed || Object.keys(pluginInstallRecords).length > 0;
		const nextConfig = shouldPersistPluginInstallIndex ? withoutPluginInstallRecords(hookResult.config) : hookResult.config;
		if (shouldPersistPluginInstallIndex) await commitPluginInstallRecordsWithConfig({
			previousInstallRecords: pluginInstallRecords,
			nextInstallRecords: nextPluginInstallRecords,
			nextConfig,
			baseHash: (await sourceSnapshotPromise)?.hash,
			writeOptions: { afterWrite: {
				mode: "restart",
				reason: "plugin source changed"
			} }
		});
		else await replaceConfigFile({
			nextConfig,
			baseHash: (await sourceSnapshotPromise)?.hash
		});
		if (pluginResult.changed) await refreshPluginRegistryAfterConfigMutation({
			config: nextConfig,
			reason: "source-changed",
			installRecords: nextPluginInstallRecords,
			logger
		});
		defaultRuntime.log("Restart the gateway to load plugins and hooks.");
	}
	if (outcomeSummary.hasErrors) defaultRuntime.exit(1);
}
//#endregion
export { runPluginUpdateCommand as t };
