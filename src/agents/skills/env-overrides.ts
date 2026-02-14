import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";

/**
 * Environment variables that could enable code injection if attacker-controlled.
 * These are blocked from being set via skill config to prevent RCE attacks.
 */
const DANGEROUS_ENV_VARS = new Set([
  // Node.js code injection
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_HISTORY",
  // Dynamic library injection (Linux)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  // Dynamic library injection (macOS)
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_VERSIONED_LIBRARY_PATH",
  "DYLD_VERSIONED_FRAMEWORK_PATH",
  // Python code injection
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  // Perl code injection
  "PERL5LIB",
  "PERLLIB",
  "PERL5OPT",
  // Ruby code injection
  "RUBYLIB",
  "RUBYOPT",
  // Shell injection
  "ENV",
  "BASH_ENV",
]);

/**
 * Check if an environment variable name is dangerous (could enable code injection).
 * Matches exact names in the blocklist plus patterns like LD_*, DYLD_*, etc.
 */
function isDangerousEnvVar(key: string): boolean {
  // Normalize to uppercase for case-insensitive matching
  // (env vars like NODE_OPTIONS can be bypassed with node_options otherwise)
  const upperKey = key.toUpperCase();
  if (DANGEROUS_ENV_VARS.has(upperKey)) {
    return true;
  }
  // Block pattern-based dangerous variables
  if (upperKey.startsWith("LD_") || upperKey.startsWith("DYLD_") || upperKey.startsWith("_LD_")) {
    return true;
  }
  return false;
}

export function applySkillEnvOverrides(params: { skills: SkillEntry[]; config?: OpenClawConfig }) {
  const { skills, config } = params;
  const updates: Array<{ key: string; prev: string | undefined }> = [];

  for (const entry of skills) {
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    if (!skillConfig) {
      continue;
    }

    if (skillConfig.env) {
      for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
        // Block dangerous environment variables that could enable code injection (CWE-94)
        if (isDangerousEnvVar(envKey)) {
          continue;
        }
        if (!envValue || process.env[envKey]) {
          continue;
        }
        updates.push({ key: envKey, prev: process.env[envKey] });
        process.env[envKey] = envValue;
      }
    }

    const primaryEnv = entry.metadata?.primaryEnv;
    if (primaryEnv && skillConfig.apiKey && !process.env[primaryEnv]) {
      updates.push({ key: primaryEnv, prev: process.env[primaryEnv] });
      process.env[primaryEnv] = skillConfig.apiKey;
    }
  }

  return () => {
    for (const update of updates) {
      if (update.prev === undefined) {
        delete process.env[update.key];
      } else {
        process.env[update.key] = update.prev;
      }
    }
  };
}

export function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: OpenClawConfig;
}) {
  const { snapshot, config } = params;
  if (!snapshot) {
    return () => {};
  }
  const updates: Array<{ key: string; prev: string | undefined }> = [];

  for (const skill of snapshot.skills) {
    const skillConfig = resolveSkillConfig(config, skill.name);
    if (!skillConfig) {
      continue;
    }

    if (skillConfig.env) {
      for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
        // Block dangerous environment variables that could enable code injection (CWE-94)
        if (isDangerousEnvVar(envKey)) {
          continue;
        }
        if (!envValue || process.env[envKey]) {
          continue;
        }
        updates.push({ key: envKey, prev: process.env[envKey] });
        process.env[envKey] = envValue;
      }
    }

    if (skill.primaryEnv && skillConfig.apiKey && !process.env[skill.primaryEnv]) {
      updates.push({
        key: skill.primaryEnv,
        prev: process.env[skill.primaryEnv],
      });
      process.env[skill.primaryEnv] = skillConfig.apiKey;
    }
  }

  return () => {
    for (const update of updates) {
      if (update.prev === undefined) {
        delete process.env[update.key];
      } else {
        process.env[update.key] = update.prev;
      }
    }
  };
}
