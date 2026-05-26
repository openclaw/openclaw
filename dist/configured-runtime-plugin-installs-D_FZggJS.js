import { t as collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes-Da9K6qai.js";
//#region src/commands/doctor/shared/configured-runtime-plugin-installs.ts
const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES = [{
	pluginId: "acpx",
	label: "ACPX Runtime",
	npmSpec: "@openclaw/acpx",
	trustedSourceLinkedOfficialInstall: true
}, {
	pluginId: "codex",
	label: "Codex",
	npmSpec: "@openclaw/codex",
	trustedSourceLinkedOfficialInstall: true
}];
function resolveConfiguredRuntimePluginInstallCandidate(runtimeId) {
	return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find((candidate) => candidate.pluginId === runtimeId);
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function acpxRuntimeIsConfigured(cfg) {
	const acp = asRecord(cfg.acp);
	const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
	return (backend === "acpx" || acp?.enabled === true || asRecord(acp?.dispatch)?.enabled === true) && (!backend || backend === "acpx");
}
function collectConfiguredRuntimePluginIds(cfg, env, options) {
	const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, env, options));
	if (acpxRuntimeIsConfigured(cfg)) ids.add("acpx");
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
export { collectConfiguredRuntimePluginIds as n, resolveConfiguredRuntimePluginInstallCandidate as r, CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES as t };
