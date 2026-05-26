import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { t as collectUnavailableAgentSkills } from "./doctor-skills-core-cCtqEFSV.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DPLbsdcw.js";
//#region src/flows/doctor-core-checks.runtime.ts
function detectUnavailableSkills(cfg) {
	const agentId = resolveDefaultAgentId(cfg);
	return collectUnavailableAgentSkills(buildWorkspaceSkillStatus(resolveAgentWorkspaceDir(cfg, agentId), {
		config: cfg,
		agentId
	}));
}
//#endregion
export { detectUnavailableSkills };
