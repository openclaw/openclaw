import type { OpenClawConfig } from "../../config/config.js";
import { type SkillEntry, type SkillSnapshot } from "../skills.js";
export declare function resolveEmbeddedRunSkillEntries(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
}): {
    shouldLoadSkillEntries: boolean;
    skillEntries: SkillEntry[];
};
