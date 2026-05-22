import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { n as hasBinary, r as isConfigPathTruthyWithDefaults, t as evaluateRuntimeEligibility } from "./config-eval-BH8jfSqo.js";
import { i as resolveSkillKey } from "./frontmatter-BTFF5uon.js";
import { t as resolveSkillSource } from "./source-SBWOzARs.js";
//#region src/agents/skills/config.ts
const DEFAULT_CONFIG_VALUES = {
	"browser.enabled": true,
	"browser.evaluateEnabled": true
};
function isConfigPathTruthy(config, pathStr) {
	return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}
function resolveSkillConfig(config, skillKey) {
	const skills = config?.skills?.entries;
	if (!skills || typeof skills !== "object") return;
	const entry = skills[skillKey];
	if (!entry || typeof entry !== "object") return;
	return entry;
}
function normalizeAllowlist(input) {
	if (!input) return;
	if (!Array.isArray(input)) return;
	const normalized = normalizeStringEntries(input);
	return normalized.length > 0 ? normalized : void 0;
}
const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);
function isBundledSkill(entry) {
	return BUNDLED_SOURCES.has(resolveSkillSource(entry.skill));
}
function resolveBundledAllowlist(config) {
	return normalizeAllowlist(config?.skills?.allowBundled);
}
function isBundledSkillAllowed(entry, allowlist) {
	if (!allowlist || allowlist.length === 0) return true;
	if (!isBundledSkill(entry)) return true;
	const key = resolveSkillKey(entry.skill, entry);
	return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}
function shouldIncludeSkill(params) {
	const { entry, config, eligibility } = params;
	const skillConfig = resolveSkillConfig(config, resolveSkillKey(entry.skill, entry));
	const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
	if (skillConfig?.enabled === false) return false;
	if (!isBundledSkillAllowed(entry, allowBundled)) return false;
	return evaluateRuntimeEligibility({
		os: entry.metadata?.os,
		remotePlatforms: eligibility?.remote?.platforms,
		always: entry.metadata?.always,
		requires: entry.metadata?.requires,
		hasBin: hasBinary,
		hasRemoteBin: eligibility?.remote?.hasBin,
		hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
		hasEnv: (envName) => Boolean(process.env[envName] || skillConfig?.env?.[envName] || skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
		isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath)
	});
}
//#endregion
export { shouldIncludeSkill as a, resolveSkillConfig as i, isConfigPathTruthy as n, resolveBundledAllowlist as r, isBundledSkillAllowed as t };
