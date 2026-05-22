import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[];
export declare function formatUnavailableSkillDoctorLines(skills: SkillStatusEntry[]): string[];
export declare function disableUnavailableSkillsInConfig(config: OpenClawConfig, skills: readonly SkillStatusEntry[]): OpenClawConfig;
export declare function maybeRepairSkillReadiness(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
}): Promise<OpenClawConfig>;
