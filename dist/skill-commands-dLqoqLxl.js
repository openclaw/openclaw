import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { f as resolveAgentSkillsFilter } from "./agent-scope-CtLXGcWm.js";
import { n as listAgentIds, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as buildWorkspaceSkillCommandSpecs } from "./skills-JUNRkaHl.js";
import { t as listReservedChatSlashCommandNames } from "./skill-commands-base-DSCgaXEW.js";
import { t as canExecRequestNode } from "./exec-defaults-60zNtKRO.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-BCbpja7h.js";
import fs from "node:fs";
//#region src/auto-reply/skill-commands.ts
function listSkillCommandsForWorkspace(params) {
	return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
		config: params.cfg,
		agentId: params.agentId,
		skillFilter: params.skillFilter,
		eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
			cfg: params.cfg,
			agentId: params.agentId
		}) }) },
		reservedNames: listReservedChatSlashCommandNames()
	});
}
function dedupeBySkillName(commands) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const cmd of commands) {
		const key = normalizeOptionalLowercaseString(cmd.skillName);
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		out.push(cmd);
	}
	return out;
}
function listSkillCommandsForAgents(params) {
	const mergeSkillFilters = (existing, incoming) => {
		if (existing === void 0 || incoming === void 0) return;
		if (existing.length === 0) return Array.from(new Set(incoming));
		if (incoming.length === 0) return Array.from(new Set(existing));
		return Array.from(new Set([...existing, ...incoming]));
	};
	const agentIds = params.agentIds ?? listAgentIds(params.cfg);
	const used = listReservedChatSlashCommandNames();
	const entries = [];
	const workspaceFilters = /* @__PURE__ */ new Map();
	for (const agentId of agentIds) {
		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
		if (!fs.existsSync(workspaceDir)) {
			logVerbose(`Skipping agent "${agentId}": workspace does not exist: ${workspaceDir}`);
			continue;
		}
		let canonicalDir;
		try {
			canonicalDir = fs.realpathSync(workspaceDir);
		} catch {
			logVerbose(`Skipping agent "${agentId}": cannot resolve workspace: ${workspaceDir}`);
			continue;
		}
		const skillFilter = resolveAgentSkillsFilter(params.cfg, agentId);
		const existing = workspaceFilters.get(canonicalDir);
		if (existing) {
			existing.skillFilter = mergeSkillFilters(existing.skillFilter, skillFilter);
			continue;
		}
		workspaceFilters.set(canonicalDir, {
			workspaceDir,
			skillFilter
		});
	}
	for (const { workspaceDir, skillFilter } of workspaceFilters.values()) {
		const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
			config: params.cfg,
			skillFilter,
			eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({ cfg: params.cfg }) }) },
			reservedNames: used
		});
		for (const command of commands) {
			used.add(normalizeLowercaseStringOrEmpty(command.name));
			entries.push(command);
		}
	}
	return dedupeBySkillName(entries);
}
//#endregion
export { listSkillCommandsForWorkspace as n, listSkillCommandsForAgents as t };
