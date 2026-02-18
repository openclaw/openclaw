import type { OpenClawConfig } from "../../config/config.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

type EnvUpdate = { key: string; prev: string | undefined };
type SkillConfig = NonNullable<ReturnType<typeof resolveSkillConfig>>;

function applySkillConfigEnvOverrides(params: {
  updates: EnvUpdate[];
  skillConfig: SkillConfig;
  primaryEnv?: string | null;
}) {
  const { updates, skillConfig, primaryEnv } = params;
  if (skillConfig.env) {
    for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
      if (!envValue || process.env[envKey]) {
        continue;
      }
      updates.push({ key: envKey, prev: process.env[envKey] });
      process.env[envKey] = envValue;
    }
  }

  if (primaryEnv && skillConfig.apiKey && !process.env[primaryEnv]) {
    updates.push({ key: primaryEnv, prev: process.env[primaryEnv] });
    process.env[primaryEnv] = skillConfig.apiKey;
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
    });
  }

  return createEnvReverter(updates);
}
