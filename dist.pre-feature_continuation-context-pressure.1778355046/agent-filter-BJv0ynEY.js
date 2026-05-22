import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
import { n as normalizeSkillFilter } from "./filter-5X4NCOQk.js";
//#region src/agents/skills/agent-filter.ts
function resolveAgentEntry(cfg, agentId) {
	if (!cfg) return;
	const normalizedAgentId = normalizeAgentId(agentId);
	return cfg.agents?.list?.find((entry) => normalizeAgentId(entry.id) === normalizedAgentId);
}
/**
* Explicit per-agent skills win when present; otherwise fall back to shared defaults.
* Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
*/
function resolveEffectiveAgentSkillFilter(cfg, agentId) {
	if (!cfg) return;
	const agentEntry = resolveAgentEntry(cfg, agentId);
	if (agentEntry && Object.hasOwn(agentEntry, "skills")) return normalizeSkillFilter(agentEntry.skills);
	return normalizeSkillFilter(cfg.agents?.defaults?.skills);
}
function resolveEffectiveAgentSkillsLimits(cfg, agentId) {
	if (!agentId) return;
	const agentEntry = resolveAgentEntry(cfg, agentId);
	if (!agentEntry || !Object.hasOwn(agentEntry, "skillsLimits")) return;
	const { maxSkillsPromptChars } = agentEntry.skillsLimits ?? {};
	return typeof maxSkillsPromptChars === "number" ? { maxSkillsPromptChars } : void 0;
}
//#endregion
export { resolveEffectiveAgentSkillsLimits as n, resolveEffectiveAgentSkillFilter as t };
