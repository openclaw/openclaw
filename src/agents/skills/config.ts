import type { OpenClawConfig, SkillConfig } from "../../config/config.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  resolveConfigPath,
  resolveRuntimePlatform,
} from "../../shared/config-eval.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEligibilityContext, SkillEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

export { hasBinary, resolveConfigPath, resolveRuntimePlatform };

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(input);
  return normalized.length > 0 ? normalized : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(entry.skill.source);
}

export function resolveBundledAllowlist(config?: OpenClawConfig): string[] | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
  skipHostEnvironmentCheck?: boolean;
  targetPlatform?: string;
}): boolean {
  const { entry, config, eligibility, skipHostEnvironmentCheck } = params;
  const targetPlatformRaw =
    typeof params.targetPlatform === "string" ? params.targetPlatform.trim().toLowerCase() : "";
  const targetPlatform = targetPlatformRaw || undefined;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, allowBundled)) {
    return false;
  }
  if (targetPlatform) {
    const allowedPlatforms = entry.metadata?.os ?? [];
    if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(targetPlatform)) {
      return false;
    }
  }
  const hasConfiguredEnv = (envName: string): boolean =>
    Boolean(
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  return evaluateRuntimeEligibility({
    os: targetPlatform ? undefined : entry.metadata?.os,
    remotePlatforms: skipHostEnvironmentCheck
      ? targetPlatform
        ? [targetPlatform]
        : (eligibility?.remote?.platforms ?? entry.metadata?.os)
      : eligibility?.remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: skipHostEnvironmentCheck ? () => true : hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) =>
      skipHostEnvironmentCheck
        ? hasConfiguredEnv(envName)
        : Boolean(process.env[envName] || hasConfiguredEnv(envName)),
    isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
  });
}
