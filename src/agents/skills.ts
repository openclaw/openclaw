import type { OpenClawConfig } from "../config/config.js";
import type { SkillsInstallPreferences } from "./skills/types.js";

export {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  resolveBundledAllowlist,
  resolveConfigPath,
  resolveRuntimePlatform,
  resolveSkillConfig,
} from "./skills/config.js";
export {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "./skills/env-overrides.js";
export type {
  OpenClawSkillMetadata,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillInstallSpec,
  SkillSnapshot,
  SkillsInstallPreferences,
} from "./skills/types.js";
export {
  buildWorkspaceSkillSnapshot,
  buildWorkspaceSkillsPrompt,
  buildWorkspaceSkillCommandSpecs,
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  syncSkillsToWorkspace,
} from "./skills/workspace.js";

export function resolveSkillsInstallPreferences(config?: OpenClawConfig): SkillsInstallPreferences {
  const raw = config?.skills?.install;
  const preferBrew = raw?.preferBrew ?? true;
  const managerRaw = typeof raw?.nodeManager === "string" ? raw.nodeManager.trim() : "";
  const manager = managerRaw.toLowerCase();
  const nodeManager: SkillsInstallPreferences["nodeManager"] =
    manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
      ? manager
      : "npm";
  return { preferBrew, nodeManager };
}
