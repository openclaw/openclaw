import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Wr as normalizeSecretInput } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-8UINyTAE.js";
import { _ as resolveNodeManagerOptions, r as detectBinary } from "./onboard-helpers-CijgoJ1t.js";
import { t as installSkill } from "./skills-install-D1iomS_H.js";

//#region src/commands/onboard-skills.ts
var onboard_skills_exports = /* @__PURE__ */ __exportAll({ setupSkills: () => setupSkills });
function summarizeInstallFailure(message) {
	const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
	if (!cleaned) return;
	const maxLen = 140;
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}
function formatSkillHint(skill) {
	const desc = skill.description?.trim();
	const installLabel = skill.install[0]?.label?.trim();
	const combined = desc && installLabel ? `${desc} — ${installLabel}` : desc || installLabel;
	if (!combined) return "install";
	const maxLen = 90;
	return combined.length > maxLen ? `${combined.slice(0, maxLen - 1)}…` : combined;
}
function upsertSkillEntry(cfg, skillKey, patch) {
	const entries = { ...cfg.skills?.entries };
	entries[skillKey] = {
		...entries[skillKey] ?? {},
		...patch
	};
	return {
		...cfg,
		skills: {
			...cfg.skills,
			entries
		}
	};
}
async function setupSkills(cfg, workspaceDir, runtime, prompter) {
	const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
	const eligible = report.skills.filter((s) => s.eligible);
	const unsupportedOs = report.skills.filter((s) => !s.disabled && !s.blockedByAllowlist && s.missing.os.length > 0);
	const missing = report.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist && s.missing.os.length === 0);
	const blocked = report.skills.filter((s) => s.blockedByAllowlist);
	await prompter.note([
		`Eligible: ${eligible.length}`,
		`Missing requirements: ${missing.length}`,
		`Unsupported on this OS: ${unsupportedOs.length}`,
		`Blocked by allowlist: ${blocked.length}`
	].join("\n"), "Skills status");
	if (!await prompter.confirm({
		message: "Configure skills now? (recommended)",
		initialValue: true
	})) return cfg;
	const installable = missing.filter((skill) => skill.install.length > 0 && skill.missing.bins.length > 0);
	let next = cfg;
	if (installable.length > 0) {
		const selected = (await prompter.multiselect({
			message: "Install missing skill dependencies",
			options: [{
				value: "__skip__",
				label: "Skip for now",
				hint: "Continue without installing dependencies"
			}, ...installable.map((skill) => ({
				value: skill.name,
				label: `${skill.emoji ?? "🧩"} ${skill.name}`,
				hint: formatSkillHint(skill)
			}))]
		})).filter((name) => name !== "__skip__");
		const selectedSkills = selected.map((name) => installable.find((s) => s.name === name)).filter((item) => Boolean(item));
		if (process.platform !== "win32" && selectedSkills.some((skill) => skill.install.some((option) => option.kind === "brew")) && !await detectBinary("brew")) {
			await prompter.note(["Many skill dependencies are shipped via Homebrew.", "Without brew, you'll need to build from source or download releases manually."].join("\n"), "Homebrew recommended");
			if (await prompter.confirm({
				message: "Show Homebrew install command?",
				initialValue: true
			})) await prompter.note(["Run:", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""].join("\n"), "Homebrew install");
		}
		if (selectedSkills.some((skill) => skill.install.some((option) => option.kind === "node"))) {
			const nodeManager = await prompter.select({
				message: "Preferred node manager for skill installs",
				options: resolveNodeManagerOptions()
			});
			next = {
				...next,
				skills: {
					...next.skills,
					install: {
						...next.skills?.install,
						nodeManager
					}
				}
			};
		}
		for (const name of selected) {
			const target = installable.find((s) => s.name === name);
			if (!target || target.install.length === 0) continue;
			const installId = target.install[0]?.id;
			if (!installId) continue;
			const spin = prompter.progress(`Installing ${name}…`);
			const result = await installSkill({
				workspaceDir,
				skillName: target.name,
				installId,
				config: next
			});
			const warnings = result.warnings ?? [];
			if (result.ok) {
				spin.stop(warnings.length > 0 ? `Installed ${name} (with warnings)` : `Installed ${name}`);
				for (const warning of warnings) runtime.log(warning);
				continue;
			}
			const code = result.code == null ? "" : ` (exit ${result.code})`;
			const detail = summarizeInstallFailure(result.message);
			spin.stop(`Install failed: ${name}${code}${detail ? ` — ${detail}` : ""}`);
			for (const warning of warnings) runtime.log(warning);
			if (result.stderr) runtime.log(result.stderr.trim());
			else if (result.stdout) runtime.log(result.stdout.trim());
			runtime.log(`Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`);
			runtime.log("Docs: https://docs.openclaw.ai/skills");
		}
	}
	for (const skill of missing) {
		if (!skill.primaryEnv || skill.missing.env.length === 0) continue;
		if (!await prompter.confirm({
			message: `Set ${skill.primaryEnv} for ${skill.name}?`,
			initialValue: false
		})) continue;
		const apiKey = String(await prompter.text({
			message: `Enter ${skill.primaryEnv}`,
			validate: (value) => value?.trim() ? void 0 : "Required"
		}));
		next = upsertSkillEntry(next, skill.skillKey, { apiKey: normalizeSecretInput(apiKey) });
	}
	return next;
}

//#endregion
export { setupSkills as n, onboard_skills_exports as t };