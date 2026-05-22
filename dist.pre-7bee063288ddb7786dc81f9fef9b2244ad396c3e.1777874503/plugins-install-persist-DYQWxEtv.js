import { r as theme } from "./theme-B128avno.js";
import { s as tracePluginLifecyclePhaseAsync } from "./discovery-B19Xdk1_.js";
import { o as loadInstalledPluginIndexInstallRecords } from "./manifest-registry-C9Iavh95.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { t as buildNpmResolutionFields } from "./install-source-utils-B6zBPP4C.js";
import { n as recordPluginInstallInRecords, o as withoutPluginInstallRecords } from "./installed-plugin-index-records-HUKXRLZh.js";
import { t as enablePluginInConfig } from "./enable-bX8m2DN0.js";
import { r as replaceConfigFile } from "./mutate-BCZFK4XP.js";
import "./config-CshcuIUd.js";
import { i as enableInternalHookEntries, o as logHookPackRestartHint, s as logSlotWarnings, t as applySlotSelectionForPlugin } from "./plugins-command-helpers-D5RFqnOu.js";
import { t as recordHookInstall } from "./installs-vH24IXfA.js";
import { r as commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit-BARcqqfR.js";
import { t as refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh-EE0LE-VY.js";
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
async function persistPluginInstall(params) {
	const runtime = params.runtime ?? defaultRuntime;
	const installConfig = params.enable === false ? params.snapshot.config : removeInstalledPluginFromDenylist(addInstalledPluginToAllowlist(params.snapshot.config, params.pluginId), params.pluginId);
	let next = params.enable === false ? installConfig : enablePluginInConfig(installConfig, params.pluginId, { updateChannelConfig: false }).config;
	const installRecords = await tracePluginLifecyclePhaseAsync("install records load", () => loadInstalledPluginIndexInstallRecords(), { command: "install" });
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
