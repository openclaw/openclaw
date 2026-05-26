import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
import { o as modelSelectionShouldEnsureCodexPlugin } from "./openai-codex-routing-DwRY-_VI.js";
import { existsSync } from "node:fs";
import path from "node:path";
//#region src/commands/codex-runtime-plugin-install.ts
const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";
function isInstalledRecordPresentOnDisk(record, env) {
	const installPath = record?.installPath?.trim();
	if (!installPath) return false;
	return existsSync(path.join(resolveUserPath(installPath, env), "package.json"));
}
function selectedModelShouldEnsureCodexRuntimePlugin(params) {
	return modelSelectionShouldEnsureCodexPlugin({
		config: params.cfg,
		model: params.model
	});
}
async function ensureCodexRuntimePluginForModelSelection(params) {
	if (!selectedModelShouldEnsureCodexRuntimePlugin({
		cfg: params.cfg,
		model: params.model
	})) return {
		cfg: params.cfg,
		required: false,
		installed: false
	};
	if (isInstalledRecordPresentOnDisk((await loadInstalledPluginIndexInstallRecords({ env: process.env }))["codex"], process.env)) {
		const repair = await repairCodexRuntimePluginInstallForModelSelection({
			cfg: params.cfg,
			model: params.model,
			env: process.env
		});
		for (const change of repair.changes) params.runtime.log?.(change);
		for (const warning of repair.warnings) params.runtime.log?.(`Codex update warning: ${warning}`);
		const enableResult = enablePluginInConfig(params.cfg, CODEX_RUNTIME_PLUGIN_ID);
		return {
			cfg: enableResult.enabled ? enableResult.config : params.cfg,
			required: true,
			installed: true,
			status: "installed"
		};
	}
	const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install-DCfg_Pro.js");
	const result = await ensureOnboardingPluginInstalled({
		cfg: params.cfg,
		entry: {
			pluginId: CODEX_RUNTIME_PLUGIN_ID,
			label: CODEX_RUNTIME_PLUGIN_LABEL,
			install: {
				npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
				defaultChoice: "npm"
			},
			trustedSourceLinkedOfficialInstall: true,
			preferRemoteInstall: true
		},
		prompter: params.prompter,
		runtime: params.runtime,
		...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		promptInstall: false,
		autoConfirmSingleSource: true
	});
	return {
		cfg: result.cfg,
		required: true,
		installed: result.installed,
		status: result.status
	};
}
async function repairCodexRuntimePluginInstallForModelSelection(params) {
	if (!selectedModelShouldEnsureCodexRuntimePlugin({
		cfg: params.cfg,
		model: params.model
	})) return {
		required: false,
		changes: [],
		warnings: []
	};
	const { repairMissingPluginInstallsForIds } = await import("./missing-configured-plugin-install-CW1LX2l6.js");
	const result = await repairMissingPluginInstallsForIds({
		cfg: params.cfg,
		pluginIds: [CODEX_RUNTIME_PLUGIN_ID],
		...params.env !== void 0 ? { env: params.env } : {}
	});
	return {
		required: true,
		changes: result.changes,
		warnings: result.warnings
	};
}
//#endregion
export { selectedModelShouldEnsureCodexRuntimePlugin as i, ensureCodexRuntimePluginForModelSelection as n, repairCodexRuntimePluginInstallForModelSelection as r, CODEX_RUNTIME_PLUGIN_ID as t };
