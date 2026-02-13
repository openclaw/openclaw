import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";

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

/**
 * Resolves skill environment variables for a given agent.
 * Returns a merged object of all env vars from the agent's assigned skills.
 */
export function resolveSkillEnvForAgent(params: {
  agentId: string;
  config?: OpenClawConfig;
}): Record<string, string> {
  const { agentId, config } = params;
  const env: Record<string, string> = {};

  if (!config?.agents?.list) {
    return env;
  }

  // Find the agent config
  const agentConfig = config.agents.list.find((agent) => agent.id === agentId);
  if (!agentConfig) {
    return env;
  }

  // Get the agent's skills (undefined means all skills, empty array means no skills)
  const agentSkills = agentConfig.skills;
  if (agentSkills !== undefined && agentSkills.length === 0) {
    return env;
  }

  // Iterate through skills and collect env vars
  const skillEntries = config.skills?.entries;
  if (!skillEntries || typeof skillEntries !== "object") {
    return env;
  }

  for (const [skillKey, skillConfig] of Object.entries(skillEntries)) {
    if (!skillConfig || typeof skillConfig !== "object") {
      continue;
    }

    // Skip disabled skills
    if (skillConfig.enabled === false) {
      continue;
    }

    // If agent has specific skills list, check if this skill is included
    if (agentSkills !== undefined && !agentSkills.includes(skillKey)) {
      continue;
    }

    // Add skill env vars
    if (skillConfig.env) {
      for (const [envKey, envValue] of Object.entries(skillConfig.env)) {
        if (envValue) {
          env[envKey] = envValue;
        }
      }
    }

    // Note: We don't include skillConfig.apiKey here since primaryEnv
    // would require resolving the skill metadata, which is not available
    // without loading the actual skill entries. This can be enhanced later
    // if needed, but env vars should cover most use cases.
  }

  return env;
}
