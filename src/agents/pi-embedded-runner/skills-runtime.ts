import type { OpenClawConfig } from "../../config/config.js";
import {
  collectAllowedSensitiveKeysFromSkillEntries,
  collectAllowedSensitiveKeysFromSkillSnapshot,
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
  type SkillEntry,
  type SkillSnapshot,
} from "../skills.js";
import { isAlwaysBlockedSkillEnvKey } from "../skills/env-overrides.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";

export type SandboxSkillEnvTarget = {
  docker: { env?: Record<string, string> };
  backend?: { env?: Record<string, string> };
};

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config })
      : [],
  };
}

export function resolveEmbeddedRunAllowedSensitiveKeys(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): ReadonlySet<string> | undefined {
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries(params);
  if (!shouldLoadSkillEntries) {
    return collectAllowedSensitiveKeysFromSkillSnapshot(params.skillsSnapshot);
  }

  const config = resolveSkillRuntimeConfig(params.config);
  const eligibleSkillEntries = filterWorkspaceSkillEntries(skillEntries, config);
  return collectAllowedSensitiveKeysFromSkillEntries(eligibleSkillEntries);
}

export function syncCurrentSkillEnvToSandbox(params: {
  sandbox?: SandboxSkillEnvTarget | null;
  envKeys?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}) {
  if (!params.sandbox || !params.envKeys || params.envKeys.size === 0) {
    return;
  }

  const envSource = params.env ?? process.env;
  const skillEnv: Record<string, string> = {};
  for (const key of params.envKeys) {
    if (isAlwaysBlockedSkillEnvKey(key)) {
      continue;
    }
    const value = envSource[key];
    if (typeof value === "string" && !value.includes("\0")) {
      skillEnv[key] = value;
    }
  }
  if (Object.keys(skillEnv).length === 0) {
    return;
  }

  params.sandbox.docker.env = {
    ...params.sandbox.docker.env,
    ...skillEnv,
  };
  if (params.sandbox.backend) {
    params.sandbox.backend.env = {
      ...params.sandbox.backend.env,
      ...skillEnv,
    };
  }
}
