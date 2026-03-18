import { _p as writeConfigFile, mp as readConfigFileSnapshot, zp as sanitizeTerminalText } from "./auth-profiles-B70DPAVa.js";
//#region src/config/issue-format.ts
function normalizeConfigIssuePath(path) {
	if (typeof path !== "string") return "<root>";
	const trimmed = path.trim();
	return trimmed ? trimmed : "<root>";
}
function resolveIssuePathForLine(path, opts) {
	if (opts?.normalizeRoot) return normalizeConfigIssuePath(path);
	return typeof path === "string" ? path : "";
}
function formatConfigIssueLine(issue, marker = "-", opts) {
	return `${marker ? `${marker} ` : ""}${sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts))}: ${sanitizeTerminalText(issue.message)}`;
}
function formatConfigIssueLines(issues, marker = "-", opts) {
	return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}
//#endregion
//#region src/commands/models/shared.ts
async function loadValidConfigOrThrow() {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) {
		const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
		throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
	}
	return snapshot.config;
}
async function updateConfig(mutator) {
	const next = mutator(await loadValidConfigOrThrow());
	await writeConfigFile(next);
	return next;
}
/**
* Model key format: "provider/model"
*
* The model key is displayed in `/model status` and used to reference models.
* When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
*
* For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
* sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
*/
//#endregion
export { updateConfig as t };
