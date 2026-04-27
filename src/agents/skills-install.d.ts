import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import type { SkillInstallResult } from "./skills-install.types.js";
import { loadWorkspaceSkillEntries as defaultLoadWorkspaceSkillEntries, resolveSkillsInstallPreferences as defaultResolveSkillsInstallPreferences } from "./skills.js";
export type SkillInstallRequest = InstallSafetyOverrides & {
    workspaceDir: string;
    skillName: string;
    installId: string;
    timeoutMs?: number;
    config?: OpenClawConfig;
};
export type { SkillInstallResult } from "./skills-install.types.js";
type SkillsInstallDeps = {
    hasBinary: (bin: string) => boolean;
    loadWorkspaceSkillEntries: typeof defaultLoadWorkspaceSkillEntries;
    resolveBrewExecutable: () => string | undefined;
    resolveSkillsInstallPreferences: typeof defaultResolveSkillsInstallPreferences;
};
export declare function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<SkillsInstallDeps>): void;
};
