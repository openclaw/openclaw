import { r as theme } from "./theme-D58JpUfy.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { s as tracePluginLifecyclePhaseAsync } from "./discovery-GEDtU7uI.js";
import { g as shortenHomePath, p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as buildNpmResolutionFields } from "./install-source-utils-BA9AHTyU.js";
import { n as recordPluginInstallInRecords, o as withoutPluginInstallRecords } from "./installed-plugin-index-records-BrXfmg6n.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { n as applyPluginUninstallDirectoryRemoval, o as planPluginUninstall } from "./uninstall-Cvtk5oOG.js";
import { c as buildPluginSnapshotReport } from "./status-BvY0BMpM.js";
import { i as enableInternalHookEntries, o as logHookPackRestartHint, s as logSlotWarnings, t as applySlotSelectionForPlugin } from "./plugins-command-helpers-BUsheNmo.js";
import { t as recordHookInstall } from "./installs-NoGXzNgf.js";
import { r as commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit-Cwrnavi6.js";
import { t as refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh-OLbBO5Xj.js";
//#region src/cli/npm-resolution.ts
function resolvePinnedNpmSpec(params) {
	const recordSpec = params.pin && params.resolvedSpec ? params.resolvedSpec : params.rawSpec;
	if (!params.pin) return { recordSpec };
	if (!params.resolvedSpec) return {
		recordSpec,
		pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec."
	};
	return {
		recordSpec,
		pinNotice: `Pinned npm install record to ${params.resolvedSpec}.`
	};
}
function buildNpmInstallRecordFields(params) {
	return {
		source: "npm",
		spec: params.spec,
		installPath: params.installPath,
		version: params.version,
		...buildNpmResolutionFields(params.resolution)
	};
}
function resolvePinnedNpmInstallRecord(params) {
	const pinInfo = resolvePinnedNpmSpec({
		rawSpec: params.rawSpec,
		pin: params.pin,
		resolvedSpec: params.resolution?.resolvedSpec
	});
	logPinnedNpmSpecMessages(pinInfo, params.log, params.warn);
	return buildNpmInstallRecordFields({
		spec: pinInfo.recordSpec,
		installPath: params.installPath,
		version: params.version,
		resolution: params.resolution
	});
}
function resolvePinnedNpmInstallRecordForCli(rawSpec, pin, installPath, version, resolution, log, warnFormat) {
	return resolvePinnedNpmInstallRecord({
		rawSpec,
		pin,
		installPath,
		version,
		resolution,
		log,
		warn: (message) => log(warnFormat(message))
	});
}
function logPinnedNpmSpecMessages(pinInfo, log, logWarn) {
	if (pinInfo.pinWarning) logWarn(pinInfo.pinWarning);
	if (pinInfo.pinNotice) log(pinInfo.pinNotice);
}
//#endregion
//#region src/cli/plugins-install-persist.ts
function addInstalledPluginToAllowlist(cfg, pluginId) {
	const allow = cfg.plugins?.allow;
	if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) return cfg;
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			allow: [...allow, pluginId].toSorted()
		}
	};
}
function removeInstalledPluginFromDenylist(cfg, pluginId) {
	const deny = cfg.plugins?.deny;
	if (!Array.isArray(deny) || !deny.includes(pluginId)) return cfg;
	const nextDeny = deny.filter((id) => id !== pluginId);
	const plugins = {
		...cfg.plugins,
		...nextDeny.length > 0 ? { deny: nextDeny } : {}
	};
	if (nextDeny.length === 0) delete plugins.deny;
	return {
		...cfg,
		plugins
	};
}
function sourceMatchesInstalledPath(params) {
	const activeSource = resolveUserPath(params.activeSource, params.env);
	const installedSource = resolveUserPath(params.installedSource, params.env);
	return activeSource === installedSource || isPathInside(installedSource, activeSource);
}
function logShadowedNpmInstallWarning(params) {
	if (params.install.source !== "npm") return;
	const installedSource = params.install.installPath ?? params.install.sourcePath;
	if (!installedSource) return;
	const active = buildPluginSnapshotReport({
		config: params.config,
		effectiveOnly: true,
		onlyPluginIds: [params.pluginId]
	}).plugins.find((plugin) => plugin.id === params.pluginId);
	if (!active || active.origin !== "config" || sourceMatchesInstalledPath({
		activeSource: active.source,
		installedSource
	})) return;
	params.runtime.log(theme.warn([
		`Warning: installed plugin "${params.pluginId}" is not the active source because a config-selected plugin with the same id is currently selected:`,
		`  active config source: ${shortenHomePath(active.source)}`,
		`  installed npm source: ${shortenHomePath(installedSource)}`,
		"Run `openclaw plugins doctor` for repair options."
	].join("\n")));
}
function resolveComparableInstallPath(install) {
	return install.installPath ?? install.sourcePath;
}
function shouldPreserveReplacedInstallPath(params) {
	const removalTarget = resolveUserPath(params.removalTarget);
	const nextInstallPath = resolveUserPath(params.nextInstallPath);
	return isPathInside(removalTarget, nextInstallPath) || isPathInside(nextInstallPath, removalTarget);
}
function resolveReplacedManagedInstallRemoval(params) {
	if (!params.previousInstall) return null;
	const previousInstallPath = resolveComparableInstallPath(params.previousInstall);
	const nextInstallPath = resolveComparableInstallPath(params.nextInstall);
	if (!previousInstallPath || !nextInstallPath) return null;
	if (shouldPreserveReplacedInstallPath({
		removalTarget: previousInstallPath,
		nextInstallPath
	})) return null;
	const plan = planPluginUninstall({
		config: { plugins: { installs: { [params.pluginId]: params.previousInstall } } },
		pluginId: params.pluginId,
		deleteFiles: true
	});
	if (!plan.ok || !plan.directoryRemoval) return null;
	if (shouldPreserveReplacedInstallPath({
		removalTarget: plan.directoryRemoval.target,
		nextInstallPath
	})) return null;
	return plan.directoryRemoval;
}
async function persistPluginInstall(params) {
	const runtime = params.runtime ?? defaultRuntime;
	const installConfig = params.enable === false ? params.snapshot.config : removeInstalledPluginFromDenylist(addInstalledPluginToAllowlist(params.snapshot.config, params.pluginId), params.pluginId);
	let next = params.enable === false ? installConfig : enablePluginInConfig(installConfig, params.pluginId, { updateChannelConfig: false }).config;
	const installRecords = await tracePluginLifecyclePhaseAsync("install records load", () => loadInstalledPluginIndexInstallRecords(), { command: "install" });
	const replacedInstallRemoval = resolveReplacedManagedInstallRemoval({
		pluginId: params.pluginId,
		previousInstall: installRecords[params.pluginId],
		nextInstall: params.install
	});
	const nextInstallRecords = recordPluginInstallInRecords(installRecords, {
		pluginId: params.pluginId,
		...params.install
	});
	const slotResult = params.enable === false ? {
		config: next,
		warnings: []
	} : await tracePluginLifecyclePhaseAsync("slot selection", async () => applySlotSelectionForPlugin(next, params.pluginId), {
		command: "install",
		pluginId: params.pluginId
	});
	next = withoutPluginInstallRecords(slotResult.config);
	await tracePluginLifecyclePhaseAsync("config mutation", () => commitPluginInstallRecordsWithConfig({
		previousInstallRecords: installRecords,
		nextInstallRecords,
		nextConfig: next,
		baseHash: params.snapshot.baseHash,
		writeOptions: { afterWrite: {
			mode: "restart",
			reason: "plugin source changed"
		} }
	}), { command: "install" });
	if (replacedInstallRemoval) {
		const removalResult = await tracePluginLifecyclePhaseAsync("replaced install cleanup", () => applyPluginUninstallDirectoryRemoval(replacedInstallRemoval), {
			command: "install",
			pluginId: params.pluginId
		});
		for (const warning of removalResult.warnings) runtime.log(theme.warn(warning));
		if (removalResult.directoryRemoved) runtime.log(theme.muted(`Removed previous plugin install directory: ${shortenHomePath(replacedInstallRemoval.target)}`));
	}
	await refreshPluginRegistryAfterConfigMutation({
		config: next,
		reason: "source-changed",
		installRecords: nextInstallRecords,
		traceCommand: "install",
		logger: { warn: (message) => runtime.log(theme.warn(message)) }
	});
	logSlotWarnings(slotResult.warnings, runtime);
	if (params.warningMessage) runtime.log(theme.warn(params.warningMessage));
	runtime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
	logShadowedNpmInstallWarning({
		config: next,
		pluginId: params.pluginId,
		install: params.install,
		runtime
	});
	runtime.log("Restart the gateway to load plugins.");
	return next;
}
async function persistHookPackInstall(params) {
	const runtime = params.runtime ?? defaultRuntime;
	let next = enableInternalHookEntries(params.snapshot.config, params.hooks);
	next = recordHookInstall(next, {
		hookId: params.hookPackId,
		hooks: params.hooks,
		...params.install
	});
	await replaceConfigFile({
		nextConfig: next,
		baseHash: params.snapshot.baseHash
	});
	runtime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
	logHookPackRestartHint(runtime);
	return next;
}
//#endregion
export { resolvePinnedNpmInstallRecordForCli as i, persistPluginInstall as n, buildNpmInstallRecordFields as r, persistHookPackInstall as t };
