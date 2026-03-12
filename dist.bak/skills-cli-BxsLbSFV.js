import { Ot as theme, ut as shortenHomePath, v as defaultRuntime } from "./entry.js";
import { j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { t as renderTable } from "./table-D7QRfQ5S.js";

//#region src/cli/skills-cli.format.ts
function appendClawHubHint(output, json) {
	if (json) return output;
	return `${output}\n\nTip: use \`npx clawhub\` to search, install, and sync skills.`;
}
function formatSkillStatus(skill) {
	if (skill.eligible) return theme.success("✓ ready");
	if (skill.disabled) return theme.warn("⏸ disabled");
	if (skill.blockedByAllowlist) return theme.warn("🚫 blocked");
	return theme.error("✗ missing");
}
function formatSkillName(skill) {
	return `${skill.emoji ?? "📦"} ${theme.command(skill.name)}`;
}
function formatSkillMissingSummary(skill) {
	const missing = [];
	if (skill.missing.bins.length > 0) missing.push(`bins: ${skill.missing.bins.join(", ")}`);
	if (skill.missing.anyBins.length > 0) missing.push(`anyBins: ${skill.missing.anyBins.join(", ")}`);
	if (skill.missing.env.length > 0) missing.push(`env: ${skill.missing.env.join(", ")}`);
	if (skill.missing.config.length > 0) missing.push(`config: ${skill.missing.config.join(", ")}`);
	if (skill.missing.os.length > 0) missing.push(`os: ${skill.missing.os.join(", ")}`);
	return missing.join("; ");
}
function formatSkillsList(report, opts) {
	const skills = opts.eligible ? report.skills.filter((s) => s.eligible) : report.skills;
	if (opts.json) {
		const jsonReport = {
			workspaceDir: report.workspaceDir,
			managedSkillsDir: report.managedSkillsDir,
			skills: skills.map((s) => ({
				name: s.name,
				description: s.description,
				emoji: s.emoji,
				eligible: s.eligible,
				disabled: s.disabled,
				blockedByAllowlist: s.blockedByAllowlist,
				source: s.source,
				bundled: s.bundled,
				primaryEnv: s.primaryEnv,
				homepage: s.homepage,
				missing: s.missing
			}))
		};
		return JSON.stringify(jsonReport, null, 2);
	}
	if (skills.length === 0) return appendClawHubHint(opts.eligible ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.` : "No skills found.", opts.json);
	const eligible = skills.filter((s) => s.eligible);
	const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
	const rows = skills.map((skill) => {
		const missing = formatSkillMissingSummary(skill);
		return {
			Status: formatSkillStatus(skill),
			Skill: formatSkillName(skill),
			Description: theme.muted(skill.description),
			Source: skill.source ?? "",
			Missing: missing ? theme.warn(missing) : ""
		};
	});
	const columns = [
		{
			key: "Status",
			header: "Status",
			minWidth: 10
		},
		{
			key: "Skill",
			header: "Skill",
			minWidth: 18,
			flex: true
		},
		{
			key: "Description",
			header: "Description",
			minWidth: 24,
			flex: true
		},
		{
			key: "Source",
			header: "Source",
			minWidth: 10
		}
	];
	if (opts.verbose) columns.push({
		key: "Missing",
		header: "Missing",
		minWidth: 18,
		flex: true
	});
	const lines = [];
	lines.push(`${theme.heading("Skills")} ${theme.muted(`(${eligible.length}/${skills.length} ready)`)}`);
	lines.push(renderTable({
		width: tableWidth,
		columns,
		rows
	}).trimEnd());
	return appendClawHubHint(lines.join("\n"), opts.json);
}
function formatSkillInfo(report, skillName, opts) {
	const skill = report.skills.find((s) => s.name === skillName || s.skillKey === skillName);
	if (!skill) {
		if (opts.json) return JSON.stringify({
			error: "not found",
			skill: skillName
		}, null, 2);
		return appendClawHubHint(`Skill "${skillName}" not found. Run \`${formatCliCommand("openclaw skills list")}\` to see available skills.`, opts.json);
	}
	if (opts.json) return JSON.stringify(skill, null, 2);
	const lines = [];
	const emoji = skill.emoji ?? "📦";
	const status = skill.eligible ? theme.success("✓ Ready") : skill.disabled ? theme.warn("⏸ Disabled") : skill.blockedByAllowlist ? theme.warn("🚫 Blocked by allowlist") : theme.error("✗ Missing requirements");
	lines.push(`${emoji} ${theme.heading(skill.name)} ${status}`);
	lines.push("");
	lines.push(skill.description);
	lines.push("");
	lines.push(theme.heading("Details:"));
	lines.push(`${theme.muted("  Source:")} ${skill.source}`);
	lines.push(`${theme.muted("  Path:")} ${shortenHomePath(skill.filePath)}`);
	if (skill.homepage) lines.push(`${theme.muted("  Homepage:")} ${skill.homepage}`);
	if (skill.primaryEnv) lines.push(`${theme.muted("  Primary env:")} ${skill.primaryEnv}`);
	if (skill.requirements.bins.length > 0 || skill.requirements.anyBins.length > 0 || skill.requirements.env.length > 0 || skill.requirements.config.length > 0 || skill.requirements.os.length > 0) {
		lines.push("");
		lines.push(theme.heading("Requirements:"));
		if (skill.requirements.bins.length > 0) {
			const binsStatus = skill.requirements.bins.map((bin) => {
				return skill.missing.bins.includes(bin) ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
			});
			lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
		}
		if (skill.requirements.anyBins.length > 0) {
			const anyBinsMissing = skill.missing.anyBins.length > 0;
			const anyBinsStatus = skill.requirements.anyBins.map((bin) => {
				return anyBinsMissing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
			});
			lines.push(`${theme.muted("  Any binaries:")} ${anyBinsStatus.join(", ")}`);
		}
		if (skill.requirements.env.length > 0) {
			const envStatus = skill.requirements.env.map((env) => {
				return skill.missing.env.includes(env) ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
			});
			lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
		}
		if (skill.requirements.config.length > 0) {
			const configStatus = skill.requirements.config.map((cfg) => {
				return skill.missing.config.includes(cfg) ? theme.error(`✗ ${cfg}`) : theme.success(`✓ ${cfg}`);
			});
			lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
		}
		if (skill.requirements.os.length > 0) {
			const osStatus = skill.requirements.os.map((osName) => {
				return skill.missing.os.includes(osName) ? theme.error(`✗ ${osName}`) : theme.success(`✓ ${osName}`);
			});
			lines.push(`${theme.muted("  OS:")} ${osStatus.join(", ")}`);
		}
	}
	if (skill.install.length > 0 && !skill.eligible) {
		lines.push("");
		lines.push(theme.heading("Install options:"));
		for (const inst of skill.install) lines.push(`  ${theme.warn("→")} ${inst.label}`);
	}
	return appendClawHubHint(lines.join("\n"), opts.json);
}
function formatSkillsCheck(report, opts) {
	const eligible = report.skills.filter((s) => s.eligible);
	const disabled = report.skills.filter((s) => s.disabled);
	const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
	const missingReqs = report.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist);
	if (opts.json) return JSON.stringify({
		summary: {
			total: report.skills.length,
			eligible: eligible.length,
			disabled: disabled.length,
			blocked: blocked.length,
			missingRequirements: missingReqs.length
		},
		eligible: eligible.map((s) => s.name),
		disabled: disabled.map((s) => s.name),
		blocked: blocked.map((s) => s.name),
		missingRequirements: missingReqs.map((s) => ({
			name: s.name,
			missing: s.missing,
			install: s.install
		}))
	}, null, 2);
	const lines = [];
	lines.push(theme.heading("Skills Status Check"));
	lines.push("");
	lines.push(`${theme.muted("Total:")} ${report.skills.length}`);
	lines.push(`${theme.success("✓")} ${theme.muted("Eligible:")} ${eligible.length}`);
	lines.push(`${theme.warn("⏸")} ${theme.muted("Disabled:")} ${disabled.length}`);
	lines.push(`${theme.warn("🚫")} ${theme.muted("Blocked by allowlist:")} ${blocked.length}`);
	lines.push(`${theme.error("✗")} ${theme.muted("Missing requirements:")} ${missingReqs.length}`);
	if (eligible.length > 0) {
		lines.push("");
		lines.push(theme.heading("Ready to use:"));
		for (const skill of eligible) {
			const emoji = skill.emoji ?? "📦";
			lines.push(`  ${emoji} ${skill.name}`);
		}
	}
	if (missingReqs.length > 0) {
		lines.push("");
		lines.push(theme.heading("Missing requirements:"));
		for (const skill of missingReqs) {
			const emoji = skill.emoji ?? "📦";
			const missing = formatSkillMissingSummary(skill);
			lines.push(`  ${emoji} ${skill.name} ${theme.muted(`(${missing})`)}`);
		}
	}
	return appendClawHubHint(lines.join("\n"), opts.json);
}

//#endregion
//#region src/cli/skills-cli.ts
async function loadSkillsStatusReport() {
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const { buildWorkspaceSkillStatus } = await import("./skills-status-8UINyTAE.js").then((n) => n.n);
	return buildWorkspaceSkillStatus(workspaceDir, { config });
}
async function runSkillsAction(render) {
	try {
		const report = await loadSkillsStatusReport();
		defaultRuntime.log(render(report));
	} catch (err) {
		defaultRuntime.error(String(err));
		defaultRuntime.exit(1);
	}
}
/**
* Register the skills CLI commands
*/
function registerSkillsCli(program) {
	const skills = program.command("skills").description("List and inspect available skills").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`);
	skills.command("list").description("List all available skills").option("--json", "Output as JSON", false).option("--eligible", "Show only eligible (ready to use) skills", false).option("-v, --verbose", "Show more details including missing requirements", false).action(async (opts) => {
		await runSkillsAction((report) => formatSkillsList(report, opts));
	});
	skills.command("info").description("Show detailed information about a skill").argument("<name>", "Skill name").option("--json", "Output as JSON", false).action(async (name, opts) => {
		await runSkillsAction((report) => formatSkillInfo(report, name, opts));
	});
	skills.command("check").description("Check which skills are ready vs missing requirements").option("--json", "Output as JSON", false).action(async (opts) => {
		await runSkillsAction((report) => formatSkillsCheck(report, opts));
	});
	skills.action(async () => {
		await runSkillsAction((report) => formatSkillsList(report, {}));
	});
}

//#endregion
export { registerSkillsCli };