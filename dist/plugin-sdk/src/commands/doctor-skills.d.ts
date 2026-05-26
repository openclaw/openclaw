import type { SkillStatusEntry } from "../agents/skills-status.js";
import { type GhConfigDiscoveryInput } from "../agents/skills/gh-config-discovery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export { collectUnavailableAgentSkills, disableUnavailableSkillsInConfig, } from "./doctor-skills-core.js";
export declare function describeGhConfigDirHint(skills: SkillStatusEntry[]): string[];
export declare function describeGhConfigDirHintFromDiscovery(skills: SkillStatusEntry[], discoveryInput: GhConfigDiscoveryInput): string[];
export declare function formatUnavailableSkillDoctorLines(skills: SkillStatusEntry[]): string[];
export declare function maybeRepairSkillReadiness(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
}): Promise<OpenClawConfig>;
