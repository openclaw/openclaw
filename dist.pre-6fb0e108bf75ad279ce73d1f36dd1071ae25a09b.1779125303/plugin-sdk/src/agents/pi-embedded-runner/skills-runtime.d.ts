import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type SkillEntry, type SkillSnapshot } from "../skills.js";
export declare function resolveEmbeddedRunSkillEntries(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    agentId?: string;
    skillsSnapshot?: SkillSnapshot;
}): {
    shouldLoadSkillEntries: boolean;
    skillEntries: SkillEntry[];
};
