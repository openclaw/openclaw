import { getActiveSkillEnvKeys as getActiveSkillEnvKeysImpl } from "./active-skill-env-state.js";

type GetActiveSkillEnvKeys = typeof import("./active-skill-env-state.js").getActiveSkillEnvKeys;

export function getActiveSkillEnvKeys(
  ...args: Parameters<GetActiveSkillEnvKeys>
): ReturnType<GetActiveSkillEnvKeys> {
  return getActiveSkillEnvKeysImpl(...args);
}
