import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEligibilityContext, SkillCommandSpec, SkillEntry, SkillSnapshot } from "./types.js";
export declare function buildWorkspaceSkillSnapshot(workspaceDir: string, opts?: WorkspaceSkillBuildOptions & {
    snapshotVersion?: number;
}): SkillSnapshot;
export declare function buildWorkspaceSkillsPrompt(workspaceDir: string, opts?: WorkspaceSkillBuildOptions): string;
type WorkspaceSkillBuildOptions = {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
};
export declare function resolveSkillsPromptForRun(params: {
    skillsSnapshot?: SkillSnapshot;
    entries?: SkillEntry[];
    config?: OpenClawConfig;
    workspaceDir: string;
}): string;
export declare function loadWorkspaceSkillEntries(workspaceDir: string, opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
}): SkillEntry[];
export declare function syncSkillsToWorkspace(params: {
    sourceWorkspaceDir: string;
    targetWorkspaceDir: string;
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
}): Promise<void>;
export declare function filterWorkspaceSkillEntries(entries: SkillEntry[], config?: OpenClawConfig): SkillEntry[];
export declare function buildWorkspaceSkillCommandSpecs(workspaceDir: string, opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
}): SkillCommandSpec[];
export {};
