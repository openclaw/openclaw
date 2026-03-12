import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { W as CONFIG_DIR, s as createSubsystemLogger } from "./entry.js";
import { t as evaluateEntryRequirementsForCurrentPlatform } from "./entry-status-BqmD4lTa.js";
import { d as hasBinary } from "./frontmatter-DzgKaILZ.js";
import { _ as isBundledSkillAllowed, b as resolveSkillConfig, c as resolveBundledSkillsDir, i as loadWorkspaceSkillEntries, t as resolveSkillsInstallPreferences, v as isConfigPathTruthy, y as resolveBundledAllowlist } from "./skills-DOryi61N.js";
import path from "node:path";
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";

//#region src/agents/skills/bundled-context.ts
const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;
let cachedBundledContext = null;
function resolveBundledSkillsContext(opts = {}) {
	const dir = resolveBundledSkillsDir(opts);
	const names = /* @__PURE__ */ new Set();
	if (!dir) {
		if (!hasWarnedMissingBundledDir) {
			hasWarnedMissingBundledDir = true;
			skillsLogger.warn("Bundled skills directory could not be resolved; built-in skills may be missing.");
		}
		return {
			dir,
			names
		};
	}
	if (cachedBundledContext?.dir === dir) return {
		dir,
		names: new Set(cachedBundledContext.names)
	};
	const result = loadSkillsFromDir({
		dir,
		source: "openclaw-bundled"
	});
	for (const skill of result.skills) if (skill.name.trim()) names.add(skill.name);
	cachedBundledContext = {
		dir,
		names: new Set(names)
	};
	return {
		dir,
		names
	};
}

//#endregion
//#region src/agents/skills-status.ts
var skills_status_exports = /* @__PURE__ */ __exportAll({ buildWorkspaceSkillStatus: () => buildWorkspaceSkillStatus });
function resolveSkillKey(entry) {
	return entry.metadata?.skillKey ?? entry.skill.name;
}
function selectPreferredInstallSpec(install, prefs) {
	if (install.length === 0) return;
	const indexed = install.map((spec, index) => ({
		spec,
		index
	}));
	const findKind = (kind) => indexed.find((item) => item.spec.kind === kind);
	const brewSpec = findKind("brew");
	const nodeSpec = findKind("node");
	const goSpec = findKind("go");
	const uvSpec = findKind("uv");
	const downloadSpec = findKind("download");
	const brewAvailable = hasBinary("brew");
	const pickers = [
		() => prefs.preferBrew && brewAvailable ? brewSpec : void 0,
		() => uvSpec,
		() => nodeSpec,
		() => brewAvailable ? brewSpec : void 0,
		() => goSpec,
		() => downloadSpec,
		() => brewSpec,
		() => indexed[0]
	];
	for (const pick of pickers) {
		const selected = pick();
		if (selected) return selected;
	}
}
function normalizeInstallOptions(entry, prefs) {
	const requiredOs = entry.metadata?.os ?? [];
	if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) return [];
	const install = entry.metadata?.install ?? [];
	if (install.length === 0) return [];
	const platform = process.platform;
	const filtered = install.filter((spec) => {
		const osList = spec.os ?? [];
		return osList.length === 0 || osList.includes(platform);
	});
	if (filtered.length === 0) return [];
	const toOption = (spec, index) => {
		const id = (spec.id ?? `${spec.kind}-${index}`).trim();
		const bins = spec.bins ?? [];
		let label = (spec.label ?? "").trim();
		if (spec.kind === "node" && spec.package) label = `Install ${spec.package} (${prefs.nodeManager})`;
		if (!label) if (spec.kind === "brew" && spec.formula) label = `Install ${spec.formula} (brew)`;
		else if (spec.kind === "node" && spec.package) label = `Install ${spec.package} (${prefs.nodeManager})`;
		else if (spec.kind === "go" && spec.module) label = `Install ${spec.module} (go)`;
		else if (spec.kind === "uv" && spec.package) label = `Install ${spec.package} (uv)`;
		else if (spec.kind === "download" && spec.url) {
			const url = spec.url.trim();
			const last = url.split("/").pop();
			label = `Download ${last && last.length > 0 ? last : url}`;
		} else label = "Run installer";
		return {
			id,
			kind: spec.kind,
			label,
			bins
		};
	};
	if (filtered.every((spec) => spec.kind === "download")) return filtered.map((spec, index) => toOption(spec, index));
	const preferred = selectPreferredInstallSpec(filtered, prefs);
	if (!preferred) return [];
	return [toOption(preferred.spec, preferred.index)];
}
function buildSkillStatus(entry, config, prefs, eligibility, bundledNames) {
	const skillKey = resolveSkillKey(entry);
	const skillConfig = resolveSkillConfig(config, skillKey);
	const disabled = skillConfig?.enabled === false;
	const blockedByAllowlist = !isBundledSkillAllowed(entry, resolveBundledAllowlist(config));
	const always = entry.metadata?.always === true;
	const isEnvSatisfied = (envName) => Boolean(process.env[envName] || skillConfig?.env?.[envName] || skillConfig?.apiKey && entry.metadata?.primaryEnv === envName);
	const isConfigSatisfied = (pathStr) => isConfigPathTruthy(config, pathStr);
	const bundled = bundledNames && bundledNames.size > 0 ? bundledNames.has(entry.skill.name) : entry.skill.source === "openclaw-bundled";
	const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } = evaluateEntryRequirementsForCurrentPlatform({
		always,
		entry,
		hasLocalBin: hasBinary,
		remote: eligibility?.remote,
		isEnvSatisfied,
		isConfigSatisfied
	});
	const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;
	return {
		name: entry.skill.name,
		description: entry.skill.description,
		source: entry.skill.source,
		bundled,
		filePath: entry.skill.filePath,
		baseDir: entry.skill.baseDir,
		skillKey,
		primaryEnv: entry.metadata?.primaryEnv,
		emoji,
		homepage,
		always,
		disabled,
		blockedByAllowlist,
		eligible,
		requirements: required,
		missing,
		configChecks,
		install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config))
	};
}
function buildWorkspaceSkillStatus(workspaceDir, opts) {
	const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
	const bundledContext = resolveBundledSkillsContext();
	const skillEntries = opts?.entries ?? loadWorkspaceSkillEntries(workspaceDir, {
		config: opts?.config,
		managedSkillsDir,
		bundledSkillsDir: bundledContext.dir
	});
	const prefs = resolveSkillsInstallPreferences(opts?.config);
	return {
		workspaceDir,
		managedSkillsDir,
		skills: skillEntries.map((entry) => buildSkillStatus(entry, opts?.config, prefs, opts?.eligibility, bundledContext.names))
	};
}

//#endregion
export { skills_status_exports as n, buildWorkspaceSkillStatus as t };