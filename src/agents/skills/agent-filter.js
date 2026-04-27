import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSkillFilter } from "./filter.js";
function resolveAgentEntry(cfg, agentId) {
    if (!cfg) {
        return undefined;
    }
    const normalizedAgentId = normalizeAgentId(agentId);
    return cfg.agents?.list?.find((entry) => normalizeAgentId(entry.id) === normalizedAgentId);
}
/**
 * Explicit per-agent skills win when present; otherwise fall back to shared defaults.
 * Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
 */
export function resolveEffectiveAgentSkillFilter(cfg, agentId) {
    if (!cfg) {
        return undefined;
    }
    const agentEntry = resolveAgentEntry(cfg, agentId);
    if (agentEntry && Object.hasOwn(agentEntry, "skills")) {
        return normalizeSkillFilter(agentEntry.skills);
    }
    return normalizeSkillFilter(cfg.agents?.defaults?.skills);
}
export function resolveEffectiveAgentSkillsLimits(cfg, agentId) {
    if (!agentId) {
        return undefined;
    }
    const agentEntry = resolveAgentEntry(cfg, agentId);
    if (!agentEntry || !Object.hasOwn(agentEntry, "skillsLimits")) {
        return undefined;
    }
    const { maxSkillsPromptChars } = agentEntry.skillsLimits ?? {};
    return typeof maxSkillsPromptChars === "number" ? { maxSkillsPromptChars } : undefined;
}
