import { r as lowercasePreservingWhitespace } from "./string-coerce-Bje8XVt9.js";
import { c as normalizeAgentId } from "./session-key-CTLAw4n4.js";
import { g as listAgentEntries, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
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
function isPathWithinRoot(candidatePath, rootPath) {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function workspacePathsOverlap(left, right) {
	const normalizedLeft = normalizeWorkspacePathForComparison(left);
	const normalizedRight = normalizeWorkspacePathForComparison(right);
	return isPathWithinRoot(normalizedLeft, normalizedRight) || isPathWithinRoot(normalizedRight, normalizedLeft);
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
