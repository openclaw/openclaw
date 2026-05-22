import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type Skill } from "./skill-contract.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "./types.js";
/**
 * Compact skill catalog: name + location only (no description).
 * Used as a fallback when the full format exceeds the char budget,
 * preserving awareness of all skills before resorting to dropping.
 */
export declare function formatSkillsCompact(skills: Skill[]): string;
export declare function buildWorkspaceSkillSnapshot(workspaceDir: string, opts?: WorkspaceSkillBuildOptions & {
    snapshotVersion?: number;
}): SkillSnapshot;
export declare function buildWorkspaceSkillsPrompt(workspaceDir: string, opts?: WorkspaceSkillBuildOptions): string;
type WorkspaceSkillBuildOptions = {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    agentId?: string;
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
};
export declare function resolveSkillsPromptForRun(params: {
    skillsSnapshot?: SkillSnapshot;
    entries?: SkillEntry[];
    config?: OpenClawConfig;
    workspaceDir: string;
    agentId?: string;
}): string;
export declare function loadWorkspaceSkillEntries(workspaceDir: string, opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
}): SkillEntry[];
export declare function loadVisibleWorkspaceSkillEntries(workspaceDir: string, opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
}): SkillEntry[];
export declare function syncSkillsToWorkspace(params: {
    sourceWorkspaceDir: string;
    targetWorkspaceDir: string;
    config?: OpenClawConfig;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
}): Promise<void>;
export declare function filterWorkspaceSkillEntries(entries: SkillEntry[], config?: OpenClawConfig): SkillEntry[];
export declare function filterWorkspaceSkillEntriesWithOptions(entries: SkillEntry[], opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
}): SkillEntry[];
export {};
