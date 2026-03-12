import { W as CONFIG_DIR } from "./entry.js";
import { t as evaluateEntryRequirementsForCurrentPlatform } from "./entry-status-BqmD4lTa.js";
import { d as hasBinary } from "./frontmatter-DzgKaILZ.js";
import { n as isConfigPathTruthy, r as resolveHookConfig, t as loadWorkspaceHookEntries } from "./workspace-oRrVJPBi.js";
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
	const disabled = managedByPlugin ? false : hookConfig?.enabled === false;
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
	const eligible = !disabled && requirementsSatisfied;
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
		disabled,
		eligible,
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
		hooks: (opts?.entries ?? loadWorkspaceHookEntries(workspaceDir, opts)).map((entry) => buildHookStatus(entry, opts?.config, opts?.eligibility))
	};
}

//#endregion
export { buildWorkspaceHookStatus as t };