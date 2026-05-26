import path from "node:path";
import fs from "node:fs/promises";
//#region src/memory/root-memory-files.ts
const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
const ROOT_MEMORY_REPAIR_RELATIVE_DIR = ".openclaw-repair/root-memory";
function resolveCanonicalRootMemoryPath(workspaceDir) {
	return path.join(workspaceDir, CANONICAL_ROOT_MEMORY_FILENAME);
}
function resolveLegacyRootMemoryPath(workspaceDir) {
	return path.join(workspaceDir, LEGACY_ROOT_MEMORY_FILENAME);
}
function resolveRootMemoryRepairDir(workspaceDir) {
	return path.join(workspaceDir, ".openclaw-repair", "root-memory");
}
function normalizeWorkspaceRelativePath(value) {
	return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
async function exactWorkspaceEntryExists(dir, name) {
	try {
		return (await fs.readdir(dir)).includes(name);
	} catch {
		return false;
	}
}
async function resolveCanonicalRootMemoryFile(workspaceDir) {
	try {
		const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
		for (const entry of entries) if (entry.name === "MEMORY.md" && entry.isFile() && !entry.isSymbolicLink()) return path.join(workspaceDir, entry.name);
	} catch {}
	return null;
}
function shouldSkipRootMemoryAuxiliaryPath(params) {
	const relative = path.relative(params.workspaceDir, params.absPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	const normalized = normalizeWorkspaceRelativePath(relative);
	return normalized === "memory.md" || normalized === ROOT_MEMORY_REPAIR_RELATIVE_DIR || normalized.startsWith(`${ROOT_MEMORY_REPAIR_RELATIVE_DIR}/`);
}
//#endregion
export { resolveCanonicalRootMemoryPath as a, shouldSkipRootMemoryAuxiliaryPath as c, resolveCanonicalRootMemoryFile as i, LEGACY_ROOT_MEMORY_FILENAME as n, resolveLegacyRootMemoryPath as o, exactWorkspaceEntryExists as r, resolveRootMemoryRepairDir as s, CANONICAL_ROOT_MEMORY_FILENAME as t };
