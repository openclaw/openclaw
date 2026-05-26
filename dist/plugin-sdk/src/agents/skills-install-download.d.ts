import type { SkillInstallResult } from "./skills-install.types.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
export declare function installDownloadSpec(params: {
    entry: SkillEntry;
    spec: SkillInstallSpec;
    timeoutMs: number;
}): Promise<SkillInstallResult>;
