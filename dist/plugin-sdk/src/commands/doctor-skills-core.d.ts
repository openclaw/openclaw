import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[];
export declare function disableUnavailableSkillsInConfig(config: OpenClawConfig, skills: readonly SkillStatusEntry[]): OpenClawConfig;
