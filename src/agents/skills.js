import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
export { hasBinary, isBundledSkillAllowed, isConfigPathTruthy, resolveBundledAllowlist, resolveConfigPath, resolveRuntimePlatform, resolveSkillConfig, } from "./skills/config.js";
export { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot, } from "./skills/env-overrides.js";
export { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt, filterWorkspaceSkillEntries, filterWorkspaceSkillEntriesWithOptions, loadWorkspaceSkillEntries, resolveSkillsPromptForRun, syncSkillsToWorkspace, } from "./skills/workspace.js";
export { buildWorkspaceSkillCommandSpecs } from "./skills/command-specs.js";
export function resolveSkillsInstallPreferences(config) {
    const raw = config?.skills?.install;
    const preferBrew = raw?.preferBrew ?? true;
    const manager = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw?.nodeManager));
    const nodeManager = manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
        ? manager
        : "npm";
    return { preferBrew, nodeManager };
}
