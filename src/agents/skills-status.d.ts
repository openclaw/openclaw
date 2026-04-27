import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { type SkillEntry, type SkillEligibilityContext, type SkillInstallSpec } from "./skills.js";
export type SkillStatusConfigCheck = RequirementConfigCheck;
export type SkillInstallOption = {
    id: string;
    kind: SkillInstallSpec["kind"];
    label: string;
    bins: string[];
};
export type SkillStatusEntry = {
    name: string;
    description: string;
    source: string;
    bundled: boolean;
    filePath: string;
    baseDir: string;
    skillKey: string;
    primaryEnv?: string;
    emoji?: string;
    homepage?: string;
    always: boolean;
    disabled: boolean;
    blockedByAllowlist: boolean;
    eligible: boolean;
    requirements: Requirements;
    missing: Requirements;
    configChecks: SkillStatusConfigCheck[];
    install: SkillInstallOption[];
};
export type SkillStatusReport = {
    workspaceDir: string;
    managedSkillsDir: string;
    skills: SkillStatusEntry[];
};
export declare function buildWorkspaceSkillStatus(workspaceDir: string, opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
}): SkillStatusReport;
