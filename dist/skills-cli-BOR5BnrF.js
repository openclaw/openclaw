import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as stripAnsi, t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { o as sanitizeHostExecEnv } from "./host-env-security-66KkrZF_.js";
import { g as shortenHomePath, p as resolveUserPath, t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { c as resolveAgentIdByWorkspacePath } from "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { m as writeJson } from "./json-files-C2hqjU--.js";
import { n as parseGitPluginSpec } from "./git-install-NB3PSyj8.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { s as withTempDir } from "./install-source-utils-BA9AHTyU.js";
import "./config-B6Oplu5W.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { t as parseFrontmatter } from "./frontmatter-BTFF5uon.js";
import { t as resolveOptionFromCommand } from "./cli-utils-CdDa8OYO.js";
import { n as decorativePrefix, t as decorativeEmoji } from "./decorative-emoji-C7cb8Cby.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { a as updateSkillsFromClawHub, c as validateRequestedSkillSlug, i as untrackClawHubSkill, n as readTrackedClawHubSkillSlugs, o as installExtractedSkillRoot, r as searchSkillsFromClawHub, t as installSkillFromClawHub } from "./skills-clawhub-z6Pr6l8N.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/skills-source-install.ts
const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const DEFAULT_GIT_TIMEOUT_MS = 12e4;
function createGitCommandEnv() {
	return sanitizeHostExecEnv({
		baseEnv: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0"
		},
		blockPathOverrides: false
	});
}
function formatGitCommandFailure(params) {
	const detail = sanitizeForLog(redactSensitiveUrlLikeString(params.stderr.trim() || params.stdout.trim() || "git failed"));
	return `failed to ${params.action} ${sanitizeForLog(redactSensitiveUrlLikeString(params.label))}: ${detail}`;
}
async function runGitCommand(params) {
	const result = await runCommandWithTimeout(params.argv, {
		baseEnv: {},
		cwd: params.cwd,
		timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		env: createGitCommandEnv()
	});
	if (result.code !== 0) return {
		ok: false,
		error: formatGitCommandFailure({
			action: params.action,
			label: params.label,
			stdout: result.stdout,
			stderr: result.stderr
		})
	};
	return {
		ok: true,
		stdout: result.stdout
	};
}
async function resolveGitCommitish(params) {
	const candidates = params.ref.startsWith("origin/") ? [params.ref] : [params.ref, `origin/${params.ref}`];
	for (const candidate of candidates) {
		const resolved = await runCommandWithTimeout([
			"git",
			"rev-parse",
			"--verify",
			"--quiet",
			`${candidate}^{commit}`
		], {
			baseEnv: {},
			cwd: params.repoDir,
			timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
			env: createGitCommandEnv()
		});
		const commit = normalizeOptionalString(resolved.stdout);
		if (resolved.code === 0 && commit) return {
			ok: true,
			commitish: commit
		};
	}
	return {
		ok: false,
		error: `failed to resolve ref ${sanitizeForLog(redactSensitiveUrlLikeString(params.ref))} in ${sanitizeForLog(redactSensitiveUrlLikeString(params.label))}`
	};
}
async function readSkillNameFromFrontmatter(skillDir) {
	try {
		return normalizeOptionalString(parseFrontmatter(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).name) ?? null;
	} catch {
		return null;
	}
}
function resolveFallbackSlugFromPath(sourcePath) {
	return path.basename(path.resolve(sourcePath)).trim();
}
async function resolveSkillInstallSlug(params) {
	const explicit = normalizeOptionalString(params.slug);
	if (explicit) return validateRequestedSkillSlug(explicit);
	const frontmatterName = await readSkillNameFromFrontmatter(params.sourceDir);
	if (frontmatterName) try {
		return validateRequestedSkillSlug(frontmatterName);
	} catch {}
	return validateRequestedSkillSlug(params.fallbackLabel);
}
async function writeSkillSourceOrigin(targetDir, origin) {
	await writeJson(path.join(targetDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH), origin, { trailingNewline: true });
}
async function removeClawHubInstallMetadata(targetDir) {
	await Promise.all([fs.rm(path.join(targetDir, ".clawhub"), {
		recursive: true,
		force: true
	}), fs.rm(path.join(targetDir, ".clawdhub"), {
		recursive: true,
		force: true
	})]);
}
async function copyGitWorktreeExport(params) {
	try {
		await fs.cp(params.repoDir, params.exportDir, {
			recursive: true,
			filter: (source) => !path.relative(params.repoDir, source).split(path.sep).includes(".git")
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: `failed to prepare git skill source: ${String(err)}`
		};
	}
}
async function installLocalSkillDir(params) {
	const slug = await resolveSkillInstallSlug({
		sourceDir: params.sourceDir,
		fallbackLabel: params.fallbackLabel,
		slug: params.slug
	});
	const install = await installExtractedSkillRoot({
		workspaceDir: params.workspaceDir,
		slug,
		extractedRoot: params.sourceDir,
		mode: params.force ? "update" : "install",
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		scan: {
			installId: params.source,
			origin: params.sourceSpec
		}
	});
	if (!install.ok) return {
		ok: false,
		error: install.error
	};
	await removeClawHubInstallMetadata(install.targetDir);
	await writeSkillSourceOrigin(install.targetDir, {
		version: 1,
		source: params.source,
		spec: params.sourceSpec,
		slug,
		installedAt: Date.now(),
		...params.git ? { git: params.git } : {}
	});
	await untrackClawHubSkill(params.workspaceDir, slug);
	return {
		ok: true,
		slug,
		targetDir: install.targetDir,
		source: params.source,
		...params.git ? { git: params.git } : {}
	};
}
async function installGitSkill(params) {
	const parsed = parseGitPluginSpec(params.spec);
	if (!parsed) return {
		ok: false,
		error: `Unsupported git skill spec: ${params.spec}`
	};
	return await withTempDir("openclaw-git-skill-", async (tmpDir) => {
		const repoDir = path.join(tmpDir, "repo");
		const exportDir = path.join(tmpDir, "export");
		params.logger?.info?.(`Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`);
		const clone = await runGitCommand({
			argv: parsed.ref ? [
				"git",
				"clone",
				parsed.url,
				repoDir
			] : [
				"git",
				"clone",
				"--depth",
				"1",
				parsed.url,
				repoDir
			],
			action: "clone",
			label: parsed.label,
			timeoutMs: params.timeoutMs
		});
		if (!clone.ok) return clone;
		if (parsed.ref) {
			const commitish = await resolveGitCommitish({
				repoDir,
				ref: parsed.ref,
				label: parsed.label,
				timeoutMs: params.timeoutMs
			});
			if (!commitish.ok) return commitish;
			const checkout = await runGitCommand({
				argv: [
					"git",
					"switch",
					"--detach",
					"--",
					commitish.commitish
				],
				action: `checkout ${parsed.ref}`,
				label: parsed.label,
				cwd: repoDir,
				timeoutMs: params.timeoutMs
			});
			if (!checkout.ok) return checkout;
		}
		const rev = await runGitCommand({
			argv: [
				"git",
				"rev-parse",
				"HEAD"
			],
			action: "resolve commit for",
			label: parsed.label,
			cwd: repoDir,
			timeoutMs: params.timeoutMs
		});
		if (!rev.ok) return rev;
		const git = {
			url: redactSensitiveUrlLikeString(parsed.url),
			...parsed.ref ? { ref: parsed.ref } : {},
			commit: normalizeOptionalString(rev.stdout),
			resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		const exported = await copyGitWorktreeExport({
			repoDir,
			exportDir
		});
		if (!exported.ok) return exported;
		return await installLocalSkillDir({
			workspaceDir: params.workspaceDir,
			sourceDir: exportDir,
			sourceSpec: redactSensitiveUrlLikeString(parsed.normalizedSpec),
			source: "git",
			fallbackLabel: path.basename(parsed.label),
			slug: params.slug,
			force: params.force,
			timeoutMs: params.timeoutMs,
			logger: params.logger,
			git
		});
	});
}
async function installPathSkill(params) {
	const sourceDir = resolveUserPath(params.spec);
	let stat;
	try {
		stat = await fs.stat(sourceDir);
	} catch {
		return {
			ok: false,
			error: `Skill path not found: ${sourceDir}`
		};
	}
	if (!stat.isDirectory()) return {
		ok: false,
		error: `Skill path is not a directory: ${sourceDir}`
	};
	return await installLocalSkillDir({
		workspaceDir: params.workspaceDir,
		sourceDir,
		sourceSpec: params.spec,
		source: "path",
		fallbackLabel: resolveFallbackSlugFromPath(sourceDir),
		slug: params.slug,
		force: params.force,
		timeoutMs: params.timeoutMs,
		logger: params.logger
	});
}
function isSkillSourceInstallSpec(raw) {
	const trimmed = raw.trim();
	return trimmed.toLowerCase().startsWith("git:") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~/") || path.isAbsolute(trimmed);
}
async function installSkillFromSource(params) {
	const spec = params.spec.trim();
	if (spec.toLowerCase().startsWith("git:")) return await installGitSkill({
		...params,
		spec
	});
	return await installPathSkill({
		...params,
		spec
	});
}
//#endregion
//#region src/cli/skills-cli.format.ts
function appendClawHubHint(output, json) {
	if (json) return output;
	return `${output}\n\nTip: use \`openclaw skills search\`, \`openclaw skills install\`, and \`openclaw skills update\` for ClawHub-backed skills.`;
}
function formatSkillStatus(skill) {
	if (skill.disabled) return theme.warn(decorativePrefix("⏸", "disabled"));
	if (skill.blockedByAllowlist) return theme.warn(decorativePrefix("🚫", "blocked"));
	if (skill.blockedByAgentFilter) return theme.warn(decorativePrefix("🚫", "excluded"));
	if (skill.eligible) return theme.success("✓ ready");
	return theme.warn("△ needs setup");
}
function normalizeSkillEmoji(emoji) {
	if (emoji) return emoji.replaceAll("︎", "️");
	return decorativeEmoji("📦");
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
	const emoji = normalizeSkillEmoji(skill.emoji);
	const name = theme.command(sanitizeForLog(skill.name));
	return emoji ? `${emoji} ${name}` : name;
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
function normalizeSkillLookupToken(value) {
	return value.trim().toLowerCase().replace(/[\s_/]+/g, "-").replace(/[^a-z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
function resolveSkillByName(report, requestedName) {
	const raw = requestedName.trim();
	if (!raw) return null;
	const direct = report.skills.find((s) => s.name === raw || s.skillKey === raw);
	if (direct) return direct;
	const lower = raw.toLowerCase();
	const caseInsensitiveMatches = report.skills.filter((s) => s.name.toLowerCase() === lower || s.skillKey.toLowerCase() === lower);
	if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0] ?? null;
	if (caseInsensitiveMatches.length > 1) return null;
	const normalized = normalizeSkillLookupToken(raw);
	if (!normalized) return null;
	const normalizedMatches = report.skills.filter((s) => normalizeSkillLookupToken(s.name) === normalized || normalizeSkillLookupToken(s.skillKey) === normalized);
	if (normalizedMatches.length !== 1) return null;
	return normalizedMatches[0] ?? null;
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
	const requestedName = skillName.trim();
	const safeRequestedName = sanitizeJsonString(sanitizeForLog(requestedName));
	const skill = resolveSkillByName(report, requestedName);
	if (!skill) {
		if (opts.json) return JSON.stringify(sanitizeJsonValue({
			error: "not found",
			skill: requestedName
		}), null, 2);
		return appendClawHubHint(`Skill "${safeRequestedName}" not found. Run \`${formatCliCommand("openclaw skills list")}\` to see available skills.`, opts.json);
	}
	if (opts.json) return JSON.stringify(sanitizeJsonValue(skill), null, 2);
	const lines = [];
	const emoji = normalizeSkillEmoji(skill.emoji);
	const status = skill.disabled ? theme.warn(decorativePrefix("⏸", "Disabled")) : skill.blockedByAllowlist ? theme.warn(decorativePrefix("🚫", "Blocked by allowlist")) : skill.blockedByAgentFilter ? theme.warn(decorativePrefix("🚫", "Excluded by agent allowlist")) : skill.eligible ? theme.success("✓ Ready") : theme.warn("△ Needs setup");
	const safeName = sanitizeForLog(skill.name);
	const safeHomepage = skill.homepage ? sanitizeForLog(skill.homepage) : void 0;
	const safeSkillKey = sanitizeForLog(skill.skillKey);
	lines.push(`${emoji ? `${emoji} ` : ""}${theme.heading(safeName)} ${status}`);
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
	lines.push(`${theme.warn(decorativePrefix("⏸", "Disabled:"))} ${theme.muted(String(disabled.length))}`);
	lines.push(`${theme.warn(decorativePrefix("🚫", "Blocked by allowlist:"))} ${theme.muted(String(blocked.length))}`);
	if (agentId || agentFiltered.length > 0) lines.push(`${theme.warn(decorativePrefix("🚫", "Excluded by agent allowlist:"))} ${theme.muted(String(agentFiltered.length))}`);
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
			lines.push(`  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)}`);
		}
	}
	if (promptHidden.length > 0) {
		lines.push("");
		lines.push(theme.heading("Ready but hidden from model prompt:"));
		for (const skill of promptHidden) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			const reason = skill.commandVisible ? "skill hides its instructions from the model; commands/cron may still use it" : "skill hides its instructions from the model and is not exposed as a command";
			lines.push(`  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted(`(${reason})`)}`);
		}
	}
	if (agentFiltered.length > 0) {
		lines.push("");
		lines.push(theme.heading("Excluded by agent allowlist:"));
		for (const skill of agentFiltered) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			lines.push(`  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted("(loaded, but this agent is not allowed to see/use it)")}`);
		}
	}
	if (missingReqs.length > 0) {
		lines.push("");
		lines.push(theme.heading("Missing requirements:"));
		for (const skill of missingReqs) {
			const emoji = normalizeSkillEmoji(skill.emoji);
			const missing = formatSkillMissingSummary(skill);
			lines.push(`  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted(`(${missing})`)}`);
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
	const { buildWorkspaceSkillStatus } = await import("./skills-status-Bkd-58ZO.js");
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
function resolveClawHubTargetWorkspaceDir(command, opts) {
	const agentId = resolveAgentOption(command, opts);
	if (opts.global && normalizeOptionalString(agentId)) {
		defaultRuntime.error("Use either --global or --agent, not both.");
		defaultRuntime.exit(1);
		return;
	}
	if (opts.global) return CONFIG_DIR;
	return resolveActiveWorkspaceDir({ agentId });
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
	skills.command("install").description("Install a skill from ClawHub, git, or a local directory").argument("<slug>", "ClawHub skill slug, git:<repo>, or local skill directory").option("--version <version>", "Install a specific version").option("--force", "Overwrite an existing workspace skill", false).option("--global", "Install into the shared managed skills directory", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").option("--as <slug>", "Install a git/local skill under this slug").action(async (slug, opts, command) => {
		try {
			const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
			if (!workspaceDir) return;
			if (isSkillSourceInstallSpec(slug)) {
				if (opts.version) {
					defaultRuntime.error("--version is only supported for ClawHub skill installs.");
					defaultRuntime.exit(1);
					return;
				}
				const result = await installSkillFromSource({
					workspaceDir,
					spec: slug,
					slug: opts.as,
					force: Boolean(opts.force),
					logger: {
						info: (message) => defaultRuntime.log(message),
						warn: (message) => defaultRuntime.log(theme.warn(message))
					}
				});
				if (!result.ok) {
					defaultRuntime.error(result.error);
					defaultRuntime.exit(1);
					return;
				}
				defaultRuntime.log(`Installed ${result.slug} from ${result.source} -> ${result.targetDir}`);
				return;
			}
			if (opts.as) {
				defaultRuntime.error("--as is only supported for git and local directory skill installs.");
				defaultRuntime.exit(1);
				return;
			}
			const result = await installSkillFromClawHub({
				workspaceDir,
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
	skills.command("update").description("Update ClawHub-installed skills in the active or shared managed directory").argument("[slug]", "Single skill slug").option("--all", "Update all tracked ClawHub skills", false).option("--global", "Update skills in the shared managed skills directory", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (slug, opts, command) => {
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
			const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
			if (!workspaceDir) return;
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
