import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { r as theme } from "./theme-CVJvORNs.js";
import { g as shortenHomePath } from "./utils-D5swhEXt.js";
import { o as tracePluginLifecyclePhase, s as tracePluginLifecyclePhaseAsync } from "./discovery-CVL9-KJt.js";
import { n as defaultRuntime } from "./runtime-bzt9CHmD.js";
import { u as readConfigFileSnapshot } from "./io-C04VWQdx.js";
import "./config-Dk0DnRek.js";
import path from "node:path";
import os from "node:os";
//#region src/cli/plugins-uninstall-command.ts
async function runPluginUninstallCommand(id, opts = {}, runtime = defaultRuntime) {
	const { loadInstalledPluginIndexInstallRecords, removePluginInstallRecordFromRecords, withoutPluginInstallRecords, withPluginInstallRecords } = await import("./installed-plugin-index-records-DTA1OwKZ.js");
	const { buildPluginSnapshotReport } = await import("./status-BvRV1SNW.js");
	const { applyPluginUninstallDirectoryRemoval, formatUninstallActionLabels, formatUninstallSlotResetPreview, planPluginUninstall, resolveUninstallChannelConfigKeys, UNINSTALL_ACTION_LABELS } = await import("./uninstall-CYu-CkC5.js");
	const { commitPluginInstallRecordsWithConfig } = await import("./plugins-install-record-commit-BKlELK_7.js");
	const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-2EIXV275.js");
	const { resolvePluginUninstallId } = await import("./plugins-uninstall-selection-DQ_vogOx.js");
	const { promptYesNo } = await import("./prompt-DQrswv3G.js");
	const snapshot = await tracePluginLifecyclePhaseAsync("config read", () => readConfigFileSnapshot(), { command: "uninstall" });
	const sourceConfig = snapshot.sourceConfig ?? snapshot.config;
	const installRecords = await tracePluginLifecyclePhaseAsync("install records load", () => loadInstalledPluginIndexInstallRecords(), { command: "uninstall" });
	const cfg = withPluginInstallRecords(sourceConfig, installRecords);
	const report = tracePluginLifecyclePhase("plugin registry snapshot", () => buildPluginSnapshotReport({ config: cfg }), { command: "uninstall" });
	const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
	const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);
	if (opts.keepConfig) runtime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
	const { plugin, pluginId } = resolvePluginUninstallId({
		rawId: id,
		config: cfg,
		plugins: report.plugins
	});
	const channelIds = plugin?.status === "loaded" ? plugin.channelIds : void 0;
	const plan = planPluginUninstall({
		config: cfg,
		pluginId,
		channelIds,
		deleteFiles: !keepFiles,
		extensionsDir
	});
	if (!plan.ok) {
		if (plugin) runtime.error(`Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`);
		else runtime.error(plan.error);
		runtime.exit(1);
		return;
	}
	const hasInstall = pluginId in (cfg.plugins?.installs ?? {});
	const preview = [];
	if (plan.actions.entry) preview.push(UNINSTALL_ACTION_LABELS.entry);
	if (plan.actions.install) preview.push(UNINSTALL_ACTION_LABELS.install);
	if (plan.actions.allowlist) preview.push(UNINSTALL_ACTION_LABELS.allowlist);
	if (plan.actions.denylist) preview.push(UNINSTALL_ACTION_LABELS.denylist);
	if (plan.actions.loadPath) preview.push(UNINSTALL_ACTION_LABELS.loadPath);
	if (plan.actions.memorySlot) preview.push(formatUninstallSlotResetPreview("memory"));
	if (plan.actions.contextEngineSlot) preview.push(formatUninstallSlotResetPreview("contextEngine"));
	const channels = cfg.channels;
	if (plan.actions.channelConfig && hasInstall && channels) {
		for (const key of resolveUninstallChannelConfigKeys(pluginId, { channelIds })) if (Object.hasOwn(channels, key)) preview.push(`${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${key})`);
	}
	if (plan.directoryRemoval) preview.push(`directory: ${shortenHomePath(plan.directoryRemoval.target)}`);
	const pluginName = plugin?.name || pluginId;
	runtime.log(`Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`);
	runtime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);
	const nextConfig = withoutPluginInstallRecords(plan.config);
	if (opts.dryRun) {
		runtime.log(theme.muted("Dry run, no changes made."));
		return;
	}
	if (!opts.force) {
		if (!await promptYesNo(`Uninstall plugin "${pluginId}"?`)) {
			runtime.log("Cancelled.");
			return;
		}
	}
	const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
	await tracePluginLifecyclePhaseAsync("config mutation", () => commitPluginInstallRecordsWithConfig({
		previousInstallRecords: installRecords,
		nextInstallRecords,
		nextConfig,
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {},
		writeOptions: { afterWrite: {
			mode: "restart",
			reason: "plugin source changed"
		} }
	}), { command: "uninstall" });
	const directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
	for (const warning of directoryResult.warnings) runtime.log(theme.warn(warning));
	await refreshPluginRegistryAfterConfigMutation({
		config: nextConfig,
		reason: "source-changed",
		installRecords: nextInstallRecords,
		traceCommand: "uninstall",
		logger: { warn: (message) => runtime.log(theme.warn(message)) }
	});
	const removed = formatUninstallActionLabels({
		...plan.actions,
		directory: directoryResult.directoryRemoved
	});
	runtime.log(`Uninstalled plugin "${pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`);
	runtime.log("Restart the gateway to apply changes.");
}
//#endregion
export { runPluginUninstallCommand };
