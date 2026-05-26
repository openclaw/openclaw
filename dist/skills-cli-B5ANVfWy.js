import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as stripAnsi, t as sanitizeForLog } from "./ansi-Bk0Jp_0O.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { g as shortenHomePath } from "./utils-CKsuXgDI.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import { a as resolveAgentIdByWorkspacePath } from "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { t as resolveOptionFromCommand } from "./cli-utils-C7ZilvgD.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BsNNo8cs.js";
import { i as updateSkillsFromClawHub, n as readTrackedClawHubSkillSlugs, r as searchSkillsFromClawHub, t as installSkillFromClawHub } from "./skills-clawhub-CaCAIBVk.js";
//#region src/cli/skills-cli.format.ts
function appendClawHubHint(output, json) {
	if (json) return output;
	return `${output}\n\nTip: use \`openclaw skills search\`, \`openclaw skills install\`, and \`openclaw skills update\` for ClawHub-backed skills.`;
}
function formatSkillStatus(skill) {
	if (skill.disabled) return theme.warn("⏸ disabled");
	if (skill.blockedByAllowlist) return theme.warn("🚫 blocked");
	if (skill.blockedByAgentFilter) return theme.warn("🚫 excluded");
	if (skill.eligible) return theme.success("✓ ready");
	return theme.warn("△ needs setup");
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
	return `${normalizeSkillEmoji(skill.emoji)} ${theme.command(sanitizeForLog(skill.name))}`;
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
	const isReadyForAgent = (skill) => skill.eligible && !skill.blockedByAgentFilter;
	const skills = opts.eligible ? report.skills.filter(isReadyForAgent) : report.skills;
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
				blockedByAgentFilter: s.blockedByAgentFilter,
				modelVisible: s.modelVisible,
				userInvocable: s.userInvocable,
				commandVisible: s.commandVisible,
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
	const ready = skills.filter(isReadyForAgent);
	const tableWidth = getTerminalTableWidth();
	const rows = skills.map((skill) => {
		const missing = formatSkillMissingSummary(skill);
		return {
			Status: formatSkillStatus(skill),
			Skill: formatSkillName(skill),
			Description: theme.muted(skill.description),
			Source: skill.source,
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
	lines.push(`${theme.heading("Skills")} ${theme.muted(`(${ready.length}/${skills.length} ready)`)}`);
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
	const status = skill.disabled ? theme.warn("⏸ Disabled") : skill.blockedByAllowlist ? theme.warn("🚫 Blocked by allowlist") : skill.blockedByAgentFilter ? theme.warn("🚫 Excluded by agent allowlist") : skill.eligible ? theme.success("✓ Ready") : theme.warn("△ Needs setup");
	const safeName = sanitizeForLog(skill.name);
	const safeHomepage = skill.homepage ? sanitizeForLog(skill.homepage) : void 0;
	const safeSkillKey = sanitizeForLog(skill.skillKey);
	lines.push(`${emoji} ${theme.heading(safeName)} ${status}`);
	lines.push("");
	lines.push(sanitizeForLog(skill.description));
	lines.push("");
	lines.push(theme.heading("Details:"));
	lines.push(`${theme.muted("  Source:")} ${sanitizeForLog(skill.source)}`);
	lines.push(`${theme.muted("  Path:")} ${shortenHomePath(skill.filePath)}`);
	if (safeHomepage) lines.push(`${theme.muted("  Homepage:")} ${safeHomepage}`);
	lines.push(`${theme.muted("  Visible to model:")} ${skill.modelVisible ? theme.success("yes") : theme.warn("no")}`);
	lines.push(`${theme.muted("  Available as command:")} ${skill.commandVisible ? theme.success("yes") : theme.warn("no")}`);
	if (skill.blockedByAgentFilter) lines.push(`${theme.muted("  Agent allowlist:")} excludes this skill`);
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
	if (skill.primaryEnv && skill.missing.env.includes(skill.primaryEnv)) {
		lines.push("");
		lines.push(theme.heading("API key setup:"));
		if (safeHomepage) lines.push(`  Get your key: ${safeHomepage}`);
		lines.push(`  Save via UI: ${theme.muted("Control UI → Skills → ")}${safeName}${theme.muted(" → Save key")}`);
		lines.push(`  Save via CLI: ${formatCliCommand(`openclaw config set skills.entries.${safeSkillKey}.apiKey YOUR_KEY`)}`);
		lines.push(`  Stored in: ${theme.muted("$OPENCLAW_CONFIG_PATH")} ${theme.muted("(default: ~/.openclaw/openclaw.json)")}`);
	}
	return appendClawHubHint(lines.join("\n"), opts.json);
}
function formatSkillsCheck(report, opts) {
	const eligible = report.skills.filter((s) => s.eligible);
	const modelVisible = report.skills.filter((s) => s.modelVisible);
	const commandVisible = report.skills.filter((s) => s.commandVisible);
	const disabled = report.skills.filter((s) => s.disabled);
	const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
	const agentFiltered = report.skills.filter((s) => s.eligible && s.blockedByAgentFilter);
	const promptHidden = report.skills.filter((s) => s.eligible && !s.blockedByAgentFilter && !s.modelVisible);
	const missingReqs = report.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist && !s.blockedByAgentFilter);
	const agentId = report.agentId ?? opts.agent;
	if (opts.json) return JSON.stringify(sanitizeJsonValue({
		agentId,
		agentSkillFilter: report.agentSkillFilter,
		workspaceDir: report.workspaceDir,
		managedSkillsDir: report.managedSkillsDir,
		summary: {
			total: report.skills.length,
			eligible: eligible.length,
			modelVisible: modelVisible.length,
			commandVisible: commandVisible.length,
			disabled: disabled.length,
			blocked: blocked.length,
			agentFiltered: agentFiltered.length,
			notInjected: promptHidden.length,
			missingRequirements: missingReqs.length
		},
		eligible: eligible.map((s) => s.name),
		modelVisible: modelVisible.map((s) => s.name),
		commandVisible: commandVisible.map((s) => s.name),
		disabled: disabled.map((s) => s.name),
		blocked: blocked.map((s) => s.name),
		agentFiltered: agentFiltered.map((s) => s.name),
		notInjected: promptHidden.map((s) => ({
			name: s.name,
			reason: "disable-model-invocation"
		})),
		missingRequirements: missingReqs.map((s) => ({
			name: s.name,
			missing: s.missing,
			install: s.install
		}))
	}), null, 2);
	const lines = [];
	lines.push(theme.heading("Skills Status Check"));
	if (agentId) lines.push(`${theme.muted("Agent:")} ${sanitizeForLog(agentId)}`);
	lines.push("");
	lines.push(`${theme.muted("Total:")} ${report.skills.length}`);
	lines.push(`${theme.success("✓")} ${theme.muted("Eligible:")} ${eligible.length}`);
	lines.push(`${theme.success("✓")} ${theme.muted("Visible to model:")} ${modelVisible.length}`);
	lines.push(`${theme.success("✓")} ${theme.muted("Available as command:")} ${commandVisible.length}`);
	lines.push(`${theme.warn("⏸")} ${theme.muted("Disabled:")} ${disabled.length}`);
	lines.push(`${theme.warn("🚫")} ${theme.muted("Blocked by allowlist:")} ${blocked.length}`);
	if (agentId || agentFiltered.length > 0) lines.push(`${theme.warn("🚫")} ${theme.muted("Excluded by agent allowlist:")} ${agentFiltered.length}`);
	if (promptHidden.length > 0) lines.push(`${theme.warn("△")} ${theme.muted("Ready but hidden from model prompt:")} ${promptHidden.length}`);
	lines.push(`${theme.error("✗")} ${theme.muted("Missing requirements:")} ${missingReqs.length}`);
	if (modelVisible.length > 0 || commandVisible.length > 0 || promptHidden.length > 0) {
		lines.push("");
		lines.push(theme.heading("What this means:"));
		lines.push(`  ${theme.muted("Eligible:")} installed and requirements pass; the agent may still exclude it.`);
		if (modelVisible.length > 0) lines.push(`  ${theme.muted("Visible to model:")} the agent can see the skill instructions during normal chat.`);
		if (commandVisible.length > 0) lines.push(`  ${theme.muted("Available as command:")} people, scripts, or cron jobs can call the skill explicitly.`);
		if (promptHidden.length > 0) lines.push(`  ${theme.muted("Hidden from model prompt:")} installed and ready, but kept out of normal chat.`);
	}
	if (modelVisible.length > 0) {
		lines.push("");
		lines.push(theme.heading("Ready and visible to model:"));
		for (const skill of modelVisible) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			lines.push(`  ${emoji} ${sanitizeForLog(skill.name)}`);
		}
	}
	if (promptHidden.length > 0) {
		lines.push("");
		lines.push(theme.heading("Ready but hidden from model prompt:"));
		for (const skill of promptHidden) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			const reason = skill.commandVisible ? "skill hides its instructions from the model; commands/cron may still use it" : "skill hides its instructions from the model and is not exposed as a command";
			lines.push(`  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted(`(${reason})`)}`);
		}
	}
	if (agentFiltered.length > 0) {
		lines.push("");
		lines.push(theme.heading("Excluded by agent allowlist:"));
		for (const skill of agentFiltered) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			lines.push(`  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted("(loaded, but this agent is not allowed to see/use it)")}`);
		}
	}
	if (missingReqs.length > 0) {
		lines.push("");
		lines.push(theme.heading("Missing requirements:"));
		for (const skill of missingReqs) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			const missing = formatSkillMissingSummary(skill);
			lines.push(`  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted(`(${missing})`)}`);
		}
	}
	return appendClawHubHint(lines.join("\n"), opts.json);
}
//#endregion
//#region src/cli/skills-cli.ts
function resolveSkillsWorkspace(options) {
	const config = getRuntimeConfig();
	const explicitAgentId = normalizeOptionalString(options?.agentId);
	const inferredAgentId = explicitAgentId ? void 0 : resolveAgentIdByWorkspacePath(config, options?.cwd ?? process.cwd());
	const agentId = explicitAgentId ?? inferredAgentId ?? resolveDefaultAgentId(config);
	return {
		config,
		agentId,
		workspaceDir: resolveAgentWorkspaceDir(config, agentId)
	};
}
function resolveAgentOption(command, opts) {
	return resolveOptionFromCommand(command, "agent") ?? opts?.agent;
}
async function loadSkillsStatusReport(options) {
	const { config, workspaceDir, agentId } = resolveSkillsWorkspace(options);
	const { buildWorkspaceSkillStatus } = await import("./skills-status-dGL-XpLl.js");
	return buildWorkspaceSkillStatus(workspaceDir, {
		config,
		agentId
	});
}
async function runSkillsAction(render, options) {
	try {
		const report = await loadSkillsStatusReport(options);
		defaultRuntime.writeStdout(render(report));
		defaultRuntime.exit(0);
	} catch (err) {
		defaultRuntime.error(String(err));
		defaultRuntime.exit(1);
	}
}
function resolveActiveWorkspaceDir(options) {
	return resolveSkillsWorkspace(options).workspaceDir;
}
/**
* Register the skills CLI commands
*/
function registerSkillsCli(program) {
	const skills = program.command("skills").description("List and inspect available skills").option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`);
	skills.command("search").description("Search ClawHub skills").argument("[query...]", "Optional search query").option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10)).option("--json", "Output as JSON", false).action(async (queryParts, opts) => {
		try {
			const results = await searchSkillsFromClawHub({
				query: normalizeOptionalString(queryParts.join(" ")),
				limit: opts.limit
			});
			if (opts.json) {
				defaultRuntime.writeJson({ results });
				return;
			}
			if (results.length === 0) {
				defaultRuntime.log("No ClawHub skills found.");
				return;
			}
			for (const entry of results) {
				const version = entry.version ? ` v${entry.version}` : "";
				const summary = entry.summary ? `  ${entry.summary}` : "";
				defaultRuntime.log(`${entry.slug}${version}  ${entry.displayName}${summary}`);
			}
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
	skills.command("install").description("Install a skill from ClawHub into the active workspace").argument("<slug>", "ClawHub skill slug").option("--version <version>", "Install a specific version").option("--force", "Overwrite an existing workspace skill", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (slug, opts, command) => {
		try {
			const result = await installSkillFromClawHub({
				workspaceDir: resolveActiveWorkspaceDir({ agentId: resolveAgentOption(command, opts) }),
				slug,
				version: opts.version,
				force: Boolean(opts.force),
				logger: { info: (message) => defaultRuntime.log(message) }
			});
			if (!result.ok) {
				defaultRuntime.error(result.error);
				defaultRuntime.exit(1);
				return;
			}
			defaultRuntime.log(`Installed ${result.slug}@${result.version} -> ${result.targetDir}`);
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
	skills.command("update").description("Update ClawHub-installed skills in the active workspace").argument("[slug]", "Single skill slug").option("--all", "Update all tracked ClawHub skills", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (slug, opts, command) => {
		try {
			if (!slug && !opts.all) {
				defaultRuntime.error("Provide a skill slug or use --all.");
				defaultRuntime.exit(1);
				return;
			}
			if (slug && opts.all) {
				defaultRuntime.error("Use either a skill slug or --all.");
				defaultRuntime.exit(1);
				return;
			}
			const workspaceDir = resolveActiveWorkspaceDir({ agentId: resolveAgentOption(command, opts) });
			const tracked = await readTrackedClawHubSkillSlugs(workspaceDir);
			if (opts.all && tracked.length === 0) {
				defaultRuntime.log("No tracked ClawHub skills to update.");
				return;
			}
			const results = await updateSkillsFromClawHub({
				workspaceDir,
				slug,
				logger: { info: (message) => defaultRuntime.log(message) }
			});
			for (const result of results) {
				if (!result.ok) {
					defaultRuntime.error(result.error);
					continue;
				}
				if (result.changed) {
					defaultRuntime.log(`Updated ${result.slug}: ${result.previousVersion ?? "unknown"} -> ${result.version}`);
					continue;
				}
				defaultRuntime.log(`${result.slug} already at ${result.version}`);
			}
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
	skills.command("list").description("List all available skills").option("--json", "Output as JSON", false).option("--eligible", "Show only eligible (ready to use) skills", false).option("-v, --verbose", "Show more details including missing requirements", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (opts, command) => {
		await runSkillsAction((report) => formatSkillsList(report, opts), { agentId: resolveAgentOption(command, opts) });
	});
	skills.command("info").description("Show detailed information about a skill").argument("<name>", "Skill name").option("--json", "Output as JSON", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (name, opts, command) => {
		await runSkillsAction((report) => formatSkillInfo(report, name, opts), { agentId: resolveAgentOption(command, opts) });
	});
	skills.command("check").description("Check which skills are ready, visible, or missing requirements").option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").option("--json", "Output as JSON", false).action(async (opts, command) => {
		await runSkillsAction((report) => formatSkillsCheck(report, opts), { agentId: resolveAgentOption(command, opts) });
	});
	skills.action(async (opts, command) => {
		await runSkillsAction((report) => formatSkillsList(report, {}), { agentId: resolveAgentOption(command, opts) });
	});
}
//#endregion
export { formatSkillInfo, formatSkillsCheck, formatSkillsList, registerSkillsCli };
