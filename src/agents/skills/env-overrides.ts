import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { isDangerousHostEnvVarName } from "../../infra/host-env-security.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeEnvVars, validateEnvVarValue } from "../sandbox/sanitize-env-vars.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import { resolveSkillRuntimeConfig } from "./runtime-config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

const log = createSubsystemLogger("env-overrides");

type EnvUpdate = { key: string };
type SkillConfig = NonNullable<ReturnType<typeof resolveSkillConfig>>;
type ActiveSkillEnvEntry = {
  baseline: string | undefined;
  value: string;
  count: number;
};

/**
 * Tracks env var keys that are currently injected by skill overrides.
 * Used by ACP harness spawn to strip skill-injected keys so they don't
 * leak to child processes (e.g., OPENAI_API_KEY leaking to Codex CLI).
 * @see https://github.com/openclaw/openclaw/issues/36280
 */
const activeSkillEnvEntries = new Map<string, ActiveSkillEnvEntry>();

/** Returns a snapshot of env var keys currently injected by skill overrides. */
export function getActiveSkillEnvKeys(): ReadonlySet<string> {
  return new Set(activeSkillEnvEntries.keys());
}

function acquireActiveSkillEnvKey(key: string, value: string): boolean {
  const active = activeSkillEnvEntries.get(key);
  if (active) {
    active.count += 1;
    if (process.env[key] === undefined) {
      process.env[key] = active.value;
    }
    return true;
  }
  if (process.env[key] !== undefined) {
    return false;
  }
  activeSkillEnvEntries.set(key, {
    baseline: process.env[key],
    value,
    count: 1,
  });
  return true;
}

function releaseActiveSkillEnvKey(key: string) {
  const active = activeSkillEnvEntries.get(key);
  if (!active) {
    return;
  }
  active.count -= 1;
  if (active.count > 0) {
    if (process.env[key] === undefined) {
      process.env[key] = active.value;
    }
    return;
  }
  activeSkillEnvEntries.delete(key);
  if (active.baseline === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = active.baseline;
  }
}

type SanitizedSkillEnvOverrides = {
  allowed: Record<string, string>;
  blocked: string[];
  warnings: string[];
};

export type AppliedSkillEnvOverrides = {
  restore: () => void;
  injectedKeys: ReadonlySet<string>;
};

// Always block skill env overrides that can alter runtime loading or host execution behavior.
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS: ReadonlyArray<RegExp> = [
  /^OPENSSL_CONF$/i,
  /^OPENCLAW_GATEWAY_(TOKEN|PASSWORD)$/i,
];

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function isAlwaysBlockedSkillEnvKey(key: string): boolean {
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
      const hasExternallyManagedValue =
        process.env[envKey] !== undefined && !activeSkillEnvEntries.has(envKey);
      if (!envKey || !envValue || hasExternallyManagedValue) {
        continue;
      }
      pendingOverrides[envKey] = envValue;
    }
  }

  const resolvedApiKey =
    normalizeResolvedSecretInputString({
      value: skillConfig.apiKey,
      path: `skills.entries.${skillKey}.apiKey`,
    }) ?? "";
  const canInjectPrimaryEnv =
    normalizedPrimaryEnv &&
    (process.env[normalizedPrimaryEnv] === undefined ||
      activeSkillEnvEntries.has(normalizedPrimaryEnv));
  if (canInjectPrimaryEnv && resolvedApiKey) {
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
    if (!acquireActiveSkillEnvKey(envKey, envValue)) {
      continue;
    }
    updates.push({ key: envKey });
    process.env[envKey] = activeSkillEnvEntries.get(envKey)?.value ?? envValue;
  }
}

function createEnvReverter(updates: EnvUpdate[]) {
  return () => {
    for (const update of updates) {
      releaseActiveSkillEnvKey(update.key);
    }
  };
}

function buildAppliedSkillEnvOverridesResult(updates: EnvUpdate[]): AppliedSkillEnvOverrides {
  return {
    restore: createEnvReverter(updates),
    injectedKeys: new Set(updates.map((update) => update.key)),
  };
}

export function applySkillEnvOverridesWithResult(params: {
  skills: SkillEntry[];
  config?: OpenClawConfig;
}): AppliedSkillEnvOverrides {
  const { skills } = params;
  const config = resolveSkillRuntimeConfig(params.config);
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

  return buildAppliedSkillEnvOverridesResult(updates);
}

export function applySkillEnvOverrides(params: { skills: SkillEntry[]; config?: OpenClawConfig }) {
  return applySkillEnvOverridesWithResult(params).restore;
}

export function applySkillEnvOverridesFromSnapshotWithResult(params: {
  snapshot?: SkillSnapshot;
  config?: OpenClawConfig;
}): AppliedSkillEnvOverrides {
  const { snapshot } = params;
  const config = resolveSkillRuntimeConfig(params.config);
  if (!snapshot) {
    return { restore: () => {}, injectedKeys: new Set() };
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

  return buildAppliedSkillEnvOverridesResult(updates);
}

export function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: OpenClawConfig;
}) {
  return applySkillEnvOverridesFromSnapshotWithResult(params).restore;
}

/**
 * Collect the set of env var names that skills declare as required (via primaryEnv
 * and requires.env metadata).  Used by the sandbox creation path to rescue these
 * keys from the default env-var block list so that skill API keys reach the container.
 */
export function collectAllowedSensitiveKeysFromSkillSnapshot(
  snapshot?: SkillSnapshot,
): ReadonlySet<string> | undefined {
  if (!snapshot?.skills?.length) {
    return undefined;
  }
  const keys = new Set<string>();
  for (const skill of snapshot.skills) {
    const primary = skill.primaryEnv?.trim();
    if (primary) {
      keys.add(primary);
    }
    for (const env of skill.requiredEnv ?? []) {
      const trimmed = env.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }
  return keys.size > 0 ? keys : undefined;
}

/**
 * Same as collectAllowedSensitiveKeysFromSkillSnapshot but works with
 * workspace-loaded SkillEntry[] (the non-snapshot fallback path).
 */
export function collectAllowedSensitiveKeysFromSkillEntries(
  entries?: SkillEntry[],
): ReadonlySet<string> | undefined {
  if (!entries?.length) {
    return undefined;
  }
  const keys = new Set<string>();
  for (const entry of entries) {
    const primary = entry.metadata?.primaryEnv?.trim();
    if (primary) {
      keys.add(primary);
    }
    for (const env of entry.metadata?.requires?.env ?? []) {
      const trimmed = env.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }
  return keys.size > 0 ? keys : undefined;
}
