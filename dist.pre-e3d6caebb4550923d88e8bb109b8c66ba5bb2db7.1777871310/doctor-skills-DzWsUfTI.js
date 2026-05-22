import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { S as resolveDefaultAgentId, x as resolveAgentWorkspaceDir } from "./agent-scope-CbabgXwH.js";
import { t as note } from "./note-D-SKYdVO.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DIUwFIKL.js";
//#region src/commands/doctor-skills.ts
function collectUnavailableAgentSkills(report) {
	return report.skills.filter((skill) => !skill.eligible && !skill.disabled && !skill.blockedByAllowlist && !skill.blockedByAgentFilter);
}
function formatMissingSummary(skill) {
	const missing = [];
	if (skill.missing.bins.length > 0) missing.push(`bins: ${skill.missing.bins.join(", ")}`);
	if (skill.missing.anyBins.length > 0) missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
	if (skill.missing.env.length > 0) missing.push(`env: ${skill.missing.env.join(", ")}`);
	if (skill.missing.config.length > 0) missing.push(`config: ${skill.missing.config.join(", ")}`);
	if (skill.missing.os.length > 0) missing.push(`os: ${skill.missing.os.join(", ")}`);
	return missing.join("; ") || "unknown requirement";
}
function formatInstallHints(skill) {
	if (skill.install.length === 0) return [];
	return skill.install.slice(0, 2).map((entry) => `  install option: ${entry.label}`);
}
function formatUnavailableSkillDoctorLines(skills) {
	const lines = ["Some skills are allowed for this agent but are not usable in the current runtime environment."];
	for (const skill of skills) {
		lines.push(`- ${skill.name}: ${formatMissingSummary(skill)}`);
		lines.push(...formatInstallHints(skill));
	}
	lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
	lines.push(`Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`);
	return lines;
}
function disableUnavailableSkillsInConfig(config, skills) {
	if (skills.length === 0) return config;
	const entries = { ...config.skills?.entries };
	for (const skill of skills) entries[skill.skillKey] = {
		...entries[skill.skillKey],
		enabled: false
	};
	return {
		...config,
		skills: {
			...config.skills,
			entries
		}
	};
}
async function maybeRepairSkillReadiness(params) {
	const agentId = resolveDefaultAgentId(params.cfg);
	const unavailable = collectUnavailableAgentSkills(buildWorkspaceSkillStatus(resolveAgentWorkspaceDir(params.cfg, agentId), {
		config: params.cfg,
		agentId
	}));
	if (unavailable.length === 0) return params.cfg;
	note(formatUnavailableSkillDoctorLines(unavailable).join("\n"), "Skills");
	if (!await params.prompter.confirmAutoFix({
		message: `Disable ${unavailable.length} unavailable skill${unavailable.length === 1 ? "" : "s"} in config?`,
		initialValue: false
	})) return params.cfg;
	const next = disableUnavailableSkillsInConfig(params.cfg, unavailable);
	note(unavailable.map((skill) => `- Disabled ${skill.name}`).join("\n"), "Doctor changes");
	return next;
}
//#endregion
export { maybeRepairSkillReadiness };
