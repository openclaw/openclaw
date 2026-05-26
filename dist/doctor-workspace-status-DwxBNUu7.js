import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { I as listTaskFlowRecords, m as listTasksForFlowId } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DPLbsdcw.js";
import { i as buildPluginCompatibilityWarnings, s as buildPluginRegistrySnapshotReport } from "./status-BvY0BMpM.js";
import { i as formatLegacyWorkspaceWarning, n as detectLegacyWorkspaceDirs } from "./doctor-workspace-Bx5P2l7e.js";
//#region src/commands/doctor-workspace-status.ts
function noteFlowRecoveryHints() {
	const suspicious = listTaskFlowRecords().flatMap((flow) => {
		const tasks = listTasksForFlowId(flow.flowId);
		const findings = [];
		if (flow.syncMode === "managed" && flow.status === "running" && tasks.length === 0 && flow.waitJson === void 0) findings.push(`${flow.flowId}: running managed TaskFlow has no linked tasks or wait state; inspect or cancel it manually.`);
		if (flow.status === "blocked" && flow.blockedTaskId && !tasks.some((task) => task.taskId === flow.blockedTaskId)) findings.push(`${flow.flowId}: blocked TaskFlow points at missing task ${flow.blockedTaskId}; inspect before retrying.`);
		return findings;
	});
	if (suspicious.length === 0) return;
	note([
		...suspicious.slice(0, 5),
		suspicious.length > 5 ? `...and ${suspicious.length - 5} more.` : null,
		`Inspect: ${formatCliCommand("openclaw tasks flow show <flow-id>")}`,
		`Cancel: ${formatCliCommand("openclaw tasks flow cancel <flow-id>")}`
	].filter((line) => Boolean(line)).join("\n"), "TaskFlow recovery");
}
function noteWorkspaceStatus(cfg) {
	const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
	const legacyWorkspace = detectLegacyWorkspaceDirs({ workspaceDir });
	if (legacyWorkspace.legacyDirs.length > 0) note(formatLegacyWorkspaceWarning(legacyWorkspace), "Extra workspace");
	const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
	note([
		`Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
		`Missing requirements: ${skillsReport.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist).length}`,
		`Blocked by allowlist: ${skillsReport.skills.filter((s) => s.blockedByAllowlist).length}`
	].join("\n"), "Skills status");
	const pluginRegistry = buildPluginRegistrySnapshotReport({
		config: cfg,
		workspaceDir
	});
	if (pluginRegistry.plugins.length > 0) {
		const loaded = pluginRegistry.plugins.filter((p) => p.status === "loaded");
		const disabled = pluginRegistry.plugins.filter((p) => p.status === "disabled");
		const errored = pluginRegistry.plugins.filter((p) => p.status === "error");
		const imported = pluginRegistry.plugins.filter((p) => p.imported);
		const lines = [
			`Loaded: ${loaded.length}`,
			`Imported: ${imported.length}`,
			`Disabled: ${disabled.length}`,
			`Errors: ${errored.length}`,
			errored.length > 0 ? `- ${errored.slice(0, 10).map((p) => p.id).join("\n- ")}${errored.length > 10 ? "\n- ..." : ""}` : null
		].filter((line) => Boolean(line));
		const bundlePlugins = loaded.filter((p) => p.format === "bundle" && (p.bundleCapabilities?.length ?? 0) > 0);
		if (bundlePlugins.length > 0) {
			const allCaps = new Set(bundlePlugins.flatMap((p) => p.bundleCapabilities ?? []));
			lines.push(`Bundle plugins: ${bundlePlugins.length} (${[...allCaps].toSorted().join(", ")})`);
		}
		note(lines.join("\n"), "Plugins");
	}
	const compatibilityWarnings = buildPluginCompatibilityWarnings({
		config: cfg,
		workspaceDir,
		report: pluginRegistry
	});
	if (compatibilityWarnings.length > 0) note(compatibilityWarnings.map((line) => `- ${line}`).join("\n"), "Plugin compatibility");
	if (pluginRegistry.diagnostics.length > 0) note(pluginRegistry.diagnostics.map((diag) => {
		const prefix = diag.level.toUpperCase();
		const plugin = diag.pluginId ? ` ${diag.pluginId}` : "";
		const source = diag.source ? ` (${diag.source})` : "";
		return `- ${prefix}${plugin}: ${diag.message}${source}`;
	}).join("\n"), "Plugin diagnostics");
	noteFlowRecoveryHints();
	return { workspaceDir };
}
//#endregion
export { noteWorkspaceStatus };
