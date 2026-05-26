import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { o as tracePluginLifecyclePhase, s as tracePluginLifecyclePhaseAsync } from "./discovery-GEDtU7uI.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import "./config-B6Oplu5W.js";
import path from "node:path";
import os from "node:os";
//#region src/cli/plugins-uninstall-command.ts
function isPromptInputClosedError(error, PromptInputClosedError) {
	return error instanceof PromptInputClosedError;
}
async function runPluginUninstallCommand(id, opts = {}, runtime = defaultRuntime) {
	assertConfigWriteAllowedInCurrentMode();
	const { loadInstalledPluginIndexInstallRecords, removePluginInstallRecordFromRecords, withoutPluginInstallRecords, withPluginInstallRecords } = await import("./installed-plugin-index-records-CtUPw9bM.js");
	const { buildPluginSnapshotReport } = await import("./status-Br3D4-c5.js");
	const { applyPluginUninstallDirectoryRemoval, formatUninstallActionLabels, formatUninstallSlotResetPreview, planPluginUninstall, resolveUninstallChannelConfigKeys, UNINSTALL_ACTION_LABELS } = await import("./uninstall-BZrW--If.js");
	const { commitPluginInstallRecordsWithConfig } = await import("./plugins-install-record-commit-BZpVGszP.js");
	const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-KR6LikMs.js");
	const { resolvePluginUninstallId } = await import("./plugins-uninstall-selection-BbUEt9O4.js");
	const { PromptInputClosedError, promptYesNo } = await import("./prompt-DktDRGeG.js");
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
		let confirmed;
		try {
			confirmed = await promptYesNo(`Uninstall plugin "${pluginId}"?`);
		} catch (error) {
			if (isPromptInputClosedError(error, PromptInputClosedError)) {
				runtime.error("Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.");
				runtime.exit(1);
				return;
			}
			throw error;
		}
		if (!confirmed) {
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
