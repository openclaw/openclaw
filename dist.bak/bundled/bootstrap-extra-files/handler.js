import "../../paths-MYHBPf85.js";
import { ft as isAgentBootstrapEvent, t as createSubsystemLogger } from "../../subsystem-CYLd4dcj.js";
import { d as loadExtraBootstrapFilesWithDiagnostics, u as filterBootstrapFilesForSession } from "../../workspace-PvhqUv3h.js";
import "../../boolean-Ce2-qkSB.js";
import "../../frontmatter-CthhXKqf.js";
import { t as resolveHookConfig } from "../../config-BeIwBEE4.js";

//#region src/hooks/bundled/bootstrap-extra-files/handler.ts
const HOOK_KEY = "bootstrap-extra-files";
const log = createSubsystemLogger("bootstrap-extra-files");
function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.map((v) => typeof v === "string" ? v.trim() : "").filter(Boolean);
}
function resolveExtraBootstrapPatterns(hookConfig) {
	const fromPaths = normalizeStringArray(hookConfig.paths);
	if (fromPaths.length > 0) return fromPaths;
	const fromPatterns = normalizeStringArray(hookConfig.patterns);
	if (fromPatterns.length > 0) return fromPatterns;
	return normalizeStringArray(hookConfig.files);
}
const bootstrapExtraFilesHook = async (event) => {
	if (!isAgentBootstrapEvent(event)) return;
	const context = event.context;
	const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
	if (!hookConfig || hookConfig.enabled === false) return;
	const patterns = resolveExtraBootstrapPatterns(hookConfig);
	if (patterns.length === 0) return;
	try {
		const { files: extras, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(context.workspaceDir, patterns);
		if (diagnostics.length > 0) log.debug("skipped extra bootstrap candidates", {
			skipped: diagnostics.length,
			reasons: diagnostics.reduce((counts, item) => {
				counts[item.reason] = (counts[item.reason] ?? 0) + 1;
				return counts;
			}, {})
		});
		if (extras.length === 0) return;
		context.bootstrapFiles = filterBootstrapFilesForSession([...context.bootstrapFiles, ...extras], context.sessionKey);
	} catch (err) {
		log.warn(`failed: ${String(err)}`);
	}
};

//#endregion
export { bootstrapExtraFilesHook as default };