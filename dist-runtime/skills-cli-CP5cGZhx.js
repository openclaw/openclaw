import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { i as stripAnsi, t as init_ansi } from "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BGZZcqHp.js";
//#region src/cli/skills-cli.format.ts
init_runtime();
init_ansi();
init_theme();
init_utils();
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
function normalizeSkillEmoji(emoji) {
	return (emoji ?? "📦").replaceAll("︎", "️");
}
const REMAINING_ESC_SEQUENCE_REGEX = new RegExp(String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, "g");
const JSON_CONTROL_CHAR_REGEX = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`, "g");
function sanitizeJsonString(value) {
	return stripAnsi(value).replace(REMAINING_ESC_SEQUENCE_REGEX, "").replace(JSON_CONTROL_CHAR_REGEX, "");
}
function sanitizeJsonValue(value) {
	if (typeof value === "string") return sanitizeJsonString(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, sanitizeJsonValue(entryValue)]));
	return value;
}
function formatSkillName(skill) {
	return `${normalizeSkillEmoji(skill.emoji)} ${theme.command(skill.name)}`;
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
		const jsonReport = sanitizeJsonValue({
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
		});
		return JSON.stringify(jsonReport, null, 2);
	}
	if (skills.length === 0) return appendClawHubHint(opts.eligible ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.` : "No skills found.", opts.json);
	const eligible = skills.filter((s) => s.eligible);
	const tableWidth = getTerminalTableWidth();
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
			minWidth: 22
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
	if (opts.json) return JSON.stringify(sanitizeJsonValue(skill), null, 2);
	const lines = [];
	const emoji = normalizeSkillEmoji(skill.emoji);
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
	if (opts.json) return JSON.stringify(sanitizeJsonValue({
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
	}), null, 2);
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
			const emoji = normalizeSkillEmoji(skill.emoji);
			lines.push(`  ${emoji} ${skill.name}`);
		}
	}
	if (missingReqs.length > 0) {
		lines.push("");
		lines.push(theme.heading("Missing requirements:"));
		for (const skill of missingReqs) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			const missing = formatSkillMissingSummary(skill);
			lines.push(`  ${emoji} ${skill.name} ${theme.muted(`(${missing})`)}`);
		}
	}
	return appendClawHubHint(lines.join("\n"), opts.json);
}
//#endregion
//#region src/cli/skills-cli.ts
init_theme();
async function loadSkillsStatusReport() {
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const { buildWorkspaceSkillStatus } = await import("./skills-status-BJLV4v6i.js");
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
