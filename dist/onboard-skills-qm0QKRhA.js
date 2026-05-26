import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { v as isContainerEnvironment } from "./net-DCUMtgJy.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { t as resolveBrewExecutable } from "./brew-B6RYZvsE.js";
import { n as t } from "./i18n-CWNhN747.js";
import { t as detectBinary } from "./detect-binary-C4HxcF68.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DPLbsdcw.js";
import { d as resolveNodeManagerOptions } from "./onboard-helpers-BaLdeEkj.js";
import { t as installSkill } from "./skills-install-BG5un9km.js";
//#region src/commands/onboard-skills.ts
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
function isBrewOnlyInstallableSkill(skill) {
	return skill.install.length > 0 && skill.missing.bins.length > 0 && skill.install.every((option) => option.kind === "brew");
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
	].join("\n"), t("wizard.skills.statusTitle"));
	if (!await prompter.confirm({
		message: t("wizard.skills.configure"),
		initialValue: true
	})) return cfg;
	const baseInstallable = missing.filter((skill) => skill.install.length > 0 && skill.missing.bins.length > 0);
	let brewAvailable;
	const detectBrewOnce = async () => {
		brewAvailable ??= await detectBinary("brew") || resolveBrewExecutable() !== void 0;
		return brewAvailable;
	};
	const inLinuxContainer = process.platform === "linux" && isContainerEnvironment();
	let installable = baseInstallable;
	if (inLinuxContainer && baseInstallable.length > 0 && !await detectBrewOnce()) {
		const hiddenBrewOnly = baseInstallable.filter(isBrewOnlyInstallableSkill);
		installable = baseInstallable.filter((skill) => !isBrewOnlyInstallableSkill(skill));
		if (hiddenBrewOnly.length > 0) await prompter.note([t("wizard.skills.containerBrewHidden"), t("wizard.skills.containerBrewManual")].join("\n"), t("wizard.skills.containerInstallsTitle"));
	}
	let next = cfg;
	if (installable.length > 0) {
		const selected = (await prompter.multiselect({
			message: t("wizard.skills.installDeps"),
			options: [{
				value: "__skip__",
				label: t("common.skipForNow"),
				hint: t("wizard.skills.skipDepsHint")
			}, ...installable.map((skill) => ({
				value: skill.name,
				label: `${skill.emoji ?? "🧩"} ${skill.name}`,
				hint: formatSkillHint(skill)
			}))]
		})).filter((name) => name !== "__skip__");
		const selectedSkills = selected.map((name) => installable.find((s) => s.name === name)).filter((item) => Boolean(item));
		if (process.platform !== "win32" && selectedSkills.some((skill) => skill.install.some((option) => option.kind === "brew")) && !await detectBrewOnce()) {
			await prompter.note(["Many skill dependencies are shipped via Homebrew.", "Without brew, you'll need to build from source or download releases manually."].join("\n"), t("wizard.skills.homebrewRecommendedTitle"));
			if (await prompter.confirm({
				message: t("wizard.skills.homebrewCommand"),
				initialValue: true
			})) await prompter.note(["Run:", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""].join("\n"), t("wizard.skills.homebrewInstallTitle"));
		}
		if (selectedSkills.some((skill) => skill.install.some((option) => option.kind === "node"))) {
			const nodeManager = await prompter.select({
				message: t("wizard.skills.nodeManager"),
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
			const spin = prompter.progress(t("wizard.skills.installing", { name }));
			const result = await installSkill({
				workspaceDir,
				skillName: target.name,
				installId,
				config: next
			});
			const warnings = result.warnings ?? [];
			if (result.ok) {
				spin.stop(warnings.length > 0 ? t("wizard.skills.installedWithWarnings", { name }) : t("wizard.skills.installed", { name }));
				for (const warning of warnings) runtime.log(warning);
				continue;
			}
			const code = result.code == null ? "" : ` (exit ${result.code})`;
			const detail = summarizeInstallFailure(result.message);
			spin.stop(t("wizard.skills.installFailed", {
				name,
				code,
				detail: detail ? ` - ${detail}` : ""
			}));
			for (const warning of warnings) runtime.log(warning);
			if (result.stderr) runtime.log(result.stderr.trim());
			else if (result.stdout) runtime.log(result.stdout.trim());
			runtime.log(`Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`);
			runtime.log(t("wizard.skills.docsLine"));
		}
	}
	for (const skill of missing) {
		if (!skill.primaryEnv || skill.missing.env.length === 0) continue;
		if (!await prompter.confirm({
			message: t("wizard.skills.setEnv", {
				env: skill.primaryEnv,
				name: skill.name
			}),
			initialValue: false
		})) continue;
		const apiKey = await prompter.text({
			message: t("wizard.skills.enterEnv", { env: skill.primaryEnv }),
			validate: (value) => value?.trim() ? void 0 : t("common.required"),
			sensitive: true
		});
		next = upsertSkillEntry(next, skill.skillKey, { apiKey: normalizeSecretInput(apiKey) });
	}
	return next;
}
//#endregion
export { setupSkills as t };
