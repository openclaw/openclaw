import { t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { n as hasBinary } from "./config-eval-BH8jfSqo.js";
import { a as resolveHookEntries, i as resolveHookEnableState, r as resolveHookConfig, t as isConfigPathTruthy } from "./config-CRTtlu4C.js";
import { t as evaluateEntryRequirementsForCurrentPlatform } from "./entry-status-DpJXLLAW.js";
import { t as loadWorkspaceHookEntries } from "./workspace-CWRVtjYM.js";
import path from "node:path";
//#region src/hooks/hooks-status.ts
function resolveHookKey(entry) {
	return entry.metadata?.hookKey ?? entry.hook.name;
}
function normalizeInstallOptions(entry) {
	const install = entry.metadata?.install ?? [];
	if (install.length === 0) return [];
	return install.map((spec, index) => {
		const id = (spec.id ?? `${spec.kind}-${index}`).trim();
		const bins = spec.bins ?? [];
		let label = (spec.label ?? "").trim();
		if (!label) if (spec.kind === "bundled") label = "Bundled with OpenClaw";
		else if (spec.kind === "npm" && spec.package) label = `Install ${spec.package} (npm)`;
		else if (spec.kind === "git" && spec.repository) label = `Install from ${spec.repository}`;
		else label = "Run installer";
		return {
			id,
			kind: spec.kind,
			label,
			bins
		};
	});
}
function buildHookStatus(entry, config, eligibility) {
	const hookKey = resolveHookKey(entry);
	const hookConfig = resolveHookConfig(config, hookKey);
	const managedByPlugin = entry.hook.source === "openclaw-plugin";
	const enableState = resolveHookEnableState({
		entry,
		config,
		hookConfig
	});
	const always = entry.metadata?.always === true;
	const events = entry.metadata?.events ?? [];
	const isEnvSatisfied = (envName) => Boolean(process.env[envName] || hookConfig?.env?.[envName]);
	const isConfigSatisfied = (pathStr) => isConfigPathTruthy(config, pathStr);
	const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } = evaluateEntryRequirementsForCurrentPlatform({
		always,
		entry,
		hasLocalBin: hasBinary,
		remote: eligibility?.remote,
		isEnvSatisfied,
		isConfigSatisfied
	});
	const enabledByConfig = enableState.enabled;
	const loadable = enabledByConfig && requirementsSatisfied;
	const blockedReason = enableState.reason ?? (requirementsSatisfied ? void 0 : "missing requirements");
	return {
		name: entry.hook.name,
		description: entry.hook.description,
		source: entry.hook.source,
		pluginId: entry.hook.pluginId,
		filePath: entry.hook.filePath,
		baseDir: entry.hook.baseDir,
		handlerPath: entry.hook.handlerPath,
		hookKey,
		emoji,
		homepage,
		events,
		always,
		enabledByConfig,
		requirementsSatisfied,
		loadable,
		blockedReason,
		managedByPlugin,
		requirements: required,
		missing,
		configChecks,
		install: normalizeInstallOptions(entry)
	};
}
function buildWorkspaceHookStatus(workspaceDir, opts) {
	return {
		workspaceDir,
		managedHooksDir: opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks"),
		hooks: resolveHookEntries(opts?.entries ?? loadWorkspaceHookEntries(workspaceDir, opts)).map((entry) => buildHookStatus(entry, opts?.config, opts?.eligibility))
	};
}
//#endregion
export { buildWorkspaceHookStatus as t };
