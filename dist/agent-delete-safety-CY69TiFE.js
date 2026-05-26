import { r as lowercasePreservingWhitespace } from "./string-coerce-DyL154ka.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import "./agent-scope-CtLXGcWm.js";
import "./path-guards-CBe_wA_B.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { o as resolveAgentWorkspaceDir, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/agent-delete-safety.ts
function normalizeWorkspacePathForComparison(input) {
	const resolved = path.resolve(input.replaceAll("\0", ""));
	let normalized = resolved;
	try {
		normalized = fs.realpathSync.native(resolved);
	} catch {}
	if (process.platform === "win32") return lowercasePreservingWhitespace(normalized);
	return normalized;
}
function workspacePathsOverlap(left, right) {
	const normalizedLeft = normalizeWorkspacePathForComparison(left);
	const normalizedRight = normalizeWorkspacePathForComparison(right);
	return isPathInside(normalizedRight, normalizedLeft) || isPathInside(normalizedLeft, normalizedRight);
}
function findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir) {
	const entries = listAgentEntries(cfg);
	const normalizedAgentId = normalizeAgentId(agentId);
	const overlappingAgentIds = [];
	for (const entry of entries) {
		const otherAgentId = normalizeAgentId(entry.id);
		if (otherAgentId === normalizedAgentId) continue;
		if (workspacePathsOverlap(workspaceDir, resolveAgentWorkspaceDir(cfg, otherAgentId))) overlappingAgentIds.push(otherAgentId);
	}
	return overlappingAgentIds;
}
//#endregion
export { findOverlappingWorkspaceAgentIds as t };
