import type { OpenClawConfig } from "../../config/config.js";
import { isDangerousHostEnvVarName } from "../../infra/host-env-security.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeEnvVars, validateEnvVarValue } from "../sandbox/sanitize-env-vars.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

const log = createSubsystemLogger("env-overrides");

type EnvUpdate = { key: string; prev: string | undefined };
type SkillConfig = NonNullable<ReturnType<typeof resolveSkillConfig>>;

type SanitizedSkillEnvOverrides = {
  allowed: Record<string, string>;
  blocked: string[];
  warnings: string[];
};

// Always block skill env overrides that can alter runtime loading or host execution behavior.
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS: ReadonlyArray<RegExp> = [/^OPENSSL_CONF$/i];

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isAlwaysBlockedSkillEnvKey(key: string): boolean {
  return (
    isDangerousHostEnvVarName(key) || matchesAnyPattern(key, SKILL_ALWAYS_BLOCKED_ENV_PATTERNS)
  );
}

function sanitizeSkillEnvOverrides(params: {
  overrides: Record<string, string>;
  allowedSensitiveKeys: Set<string>;
}): SanitizedSkillEnvOverrides {
  if (Object.keys(params.overrides).length === 0) {
    return { allowed: {}, blocked: [], warnings: [] };
  }

  const result = sanitizeEnvVars(params.overrides);
  const allowed: Record<string, string> = {};
  const blocked = new Set<string>();
  const warnings = [...result.warnings];

  for (const [key, value] of Object.entries(result.allowed)) {
    if (isAlwaysBlockedSkillEnvKey(key)) {
      blocked.add(key);
      continue;
    }
    allowed[key] = value;
  }

  for (const key of result.blocked) {
    if (isAlwaysBlockedSkillEnvKey(key) || !params.allowedSensitiveKeys.has(key)) {
      blocked.add(key);
      continue;
    }
    const value = params.overrides[key];
    if (!value) {
      continue;
    }
    const warning = validateEnvVarValue(value);
    if (warning) {
      if (warning === "Contains null bytes") {
        blocked.add(key);
        continue;
      }
      warnings.push(`${key}: ${warning}`);
    }
    allowed[key] = value;
  }

  return { allowed, blocked: [...blocked], warnings };
}

function applySkillConfigEnvOverrides(params: {
  updates: EnvUpdate[];
  skillConfig: SkillConfig;
  primaryEnv?: string | null;
  requiredEnv?: string[] | null;
  skillKey: string;
}) {
  const { updates, skillConfig, primaryEnv, requiredEnv, skillKey } = params;
  const allowedSensitiveKeys = new Set<string>();
  const normalizedPrimaryEnv = primaryEnv?.trim();
  if (normalizedPrimaryEnv) {
    allowedSensitiveKeys.add(normalizedPrimaryEnv);
  }
  for (const envName of requiredEnv ?? []) {
    const trimmedEnv = envName.trim();
    if (trimmedEnv) {
      allowedSensitiveKeys.add(trimmedEnv);
    }
  }

  const pendingOverrides: Record<string, string> = {};
  if (skillConfig.env) {
    for (const [rawKey, envValue] of Object.entries(skillConfig.env)) {
      const envKey = rawKey.trim();
      if (!envKey || !envValue || process.env[envKey]) {
        continue;
      }
      pendingOverrides[envKey] = envValue;
    }
  }

  const resolvedApiKey = typeof skillConfig.apiKey === "string" ? skillConfig.apiKey.trim() : "";
  if (normalizedPrimaryEnv && resolvedApiKey && !process.env[normalizedPrimaryEnv]) {
    if (!pendingOverrides[normalizedPrimaryEnv]) {
      pendingOverrides[normalizedPrimaryEnv] = resolvedApiKey;
    }
  }

  const sanitized = sanitizeSkillEnvOverrides({
    overrides: pendingOverrides,
    allowedSensitiveKeys,
  });

  if (sanitized.blocked.length > 0) {
    log.warn(`Blocked skill env overrides for ${skillKey}: ${sanitized.blocked.join(", ")}`);
  }
  if (sanitized.warnings.length > 0) {
    log.warn(`Suspicious skill env overrides for ${skillKey}: ${sanitized.warnings.join(", ")}`);
  }

  for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
    if (process.env[envKey]) {
      continue;
    }
    updates.push({ key: envKey, prev: process.env[envKey] });
    process.env[envKey] = envValue;
  }
}

function createEnvReverter(updates: EnvUpdate[]) {
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

export function applySkillEnvOverrides(params: { skills: SkillEntry[]; config?: OpenClawConfig }) {
  const { skills, config } = params;
  const updates: EnvUpdate[] = [];

  for (const entry of skills) {
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    if (!skillConfig) {
      continue;
    }

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env,
      skillKey,
    });
  }

  return createEnvReverter(updates);
}

export function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: OpenClawConfig;
}) {
  const { snapshot, config } = params;
  if (!snapshot) {
    return () => {};
  }
  const updates: EnvUpdate[] = [];

  for (const skill of snapshot.skills) {
    const skillConfig = resolveSkillConfig(config, skill.name);
    if (!skillConfig) {
      continue;
    }

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: skill.primaryEnv,
      requiredEnv: skill.requiredEnv,
      skillKey: skill.name,
    });
  }

  return createEnvReverter(updates);
}
