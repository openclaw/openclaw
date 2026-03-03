import { evaluateRuntimeEligibility, hasBinary, isConfigPathTruthyWithDefaults, resolveConfigPath, resolveRuntimePlatform, } from "../../shared/config-eval.js";
import { resolveSkillKey } from "./frontmatter.js";
const DEFAULT_CONFIG_VALUES = {
    "browser.enabled": true,
    "browser.evaluateEnabled": true,
};
export { hasBinary, resolveConfigPath, resolveRuntimePlatform };
export function isConfigPathTruthy(config, pathStr) {
    return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}
export function resolveSkillConfig(config, skillKey) {
    const skills = config?.skills?.entries;
    if (!skills || typeof skills !== "object") {
        return undefined;
    }
    const entry = skills[skillKey];
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    return entry;
}
function normalizeAllowlist(input) {
    if (!input) {
        return undefined;
    }
    if (!Array.isArray(input)) {
        return undefined;
    }
    const normalized = input.map((entry) => String(entry).trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
}
const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);
function isBundledSkill(entry) {
    return BUNDLED_SOURCES.has(entry.skill.source);
}
export function resolveBundledAllowlist(config) {
    return normalizeAllowlist(config?.skills?.allowBundled);
}
export function isBundledSkillAllowed(entry, allowlist) {
    if (!allowlist || allowlist.length === 0) {
        return true;
    }
    if (!isBundledSkill(entry)) {
        return true;
    }
    const key = resolveSkillKey(entry.skill, entry);
    return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}
export function shouldIncludeSkill(params) {
    const { entry, config, eligibility } = params;
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
    if (skillConfig?.enabled === false) {
        return false;
    }
    if (!isBundledSkillAllowed(entry, allowBundled)) {
        return false;
    }
    return evaluateRuntimeEligibility({
        os: entry.metadata?.os,
        remotePlatforms: eligibility?.remote?.platforms,
        always: entry.metadata?.always,
        requires: entry.metadata?.requires,
        hasBin: hasBinary,
        hasRemoteBin: eligibility?.remote?.hasBin,
        hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
        hasEnv: (envName) => Boolean(process.env[envName] ||
            skillConfig?.env?.[envName] ||
            (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName)),
        isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
    });
}
