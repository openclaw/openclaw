import { i as modelSelectionShouldEnsureCodexPlugin } from "./openai-codex-routing-Tk9OL05P.js";
//#region src/commands/codex-runtime-plugin-install.ts
const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";
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
	const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install--2xswK0a.js");
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
	const { repairMissingPluginInstallsForIds } = await import("./missing-configured-plugin-install-Z3dFrBqT.js");
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
export { repairCodexRuntimePluginInstallForModelSelection as n, selectedModelShouldEnsureCodexRuntimePlugin as r, ensureCodexRuntimePluginForModelSelection as t };
