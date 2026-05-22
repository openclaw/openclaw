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
    resolveNodeInstallStateDir: () => string;
    resolveBrewExecutable: () => string | undefined;
    resolveSkillsInstallPreferences: typeof defaultResolveSkillsInstallPreferences;
};
declare function resolveDefaultNodeInstallStateDir({ cwd, getuid, homedir, platform }?: {
    cwd?: string;
    getuid?: () => number;
    homedir?: () => string;
    platform?: NodeJS.Platform;
}): string;
export declare function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult>;
export declare const __testing: {
    resolveDefaultNodeInstallStateDir: typeof resolveDefaultNodeInstallStateDir;
    setDepsForTest(overrides?: Partial<SkillsInstallDeps>): void;
};
