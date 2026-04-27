import { loadWorkspaceSkillEntries } from "../skills.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";
export function resolveEmbeddedRunSkillEntries(params) {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const config = resolveSkillRuntimeConfig(params.config);
    return {
        shouldLoadSkillEntries,
        skillEntries: shouldLoadSkillEntries
            ? loadWorkspaceSkillEntries(params.workspaceDir, { config, agentId: params.agentId })
            : [],
    };
}
