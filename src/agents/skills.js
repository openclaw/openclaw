export { hasBinary, isBundledSkillAllowed, isConfigPathTruthy, resolveBundledAllowlist, resolveConfigPath, resolveRuntimePlatform, resolveSkillConfig, } from "./skills/config.js";
export { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot, } from "./skills/env-overrides.js";
export { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt, buildWorkspaceSkillCommandSpecs, filterWorkspaceSkillEntries, loadWorkspaceSkillEntries, resolveSkillsPromptForRun, syncSkillsToWorkspace, } from "./skills/workspace.js";
export function resolveSkillsInstallPreferences(config) {
    const raw = config?.skills?.install;
    const preferBrew = raw?.preferBrew ?? true;
    const managerRaw = typeof raw?.nodeManager === "string" ? raw.nodeManager.trim() : "";
    const manager = managerRaw.toLowerCase();
    const nodeManager = manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
        ? manager
        : "npm";
    return { preferBrew, nodeManager };
}
