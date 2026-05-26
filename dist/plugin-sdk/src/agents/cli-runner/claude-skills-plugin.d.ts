import type { SkillSnapshot } from "../skills.js";
export declare function prepareClaudeCliSkillsPlugin(params: {
    backendId: string;
    skillsSnapshot?: SkillSnapshot;
}): Promise<{
    args: string[];
    cleanup: () => Promise<void>;
    pluginDir?: string;
}>;
