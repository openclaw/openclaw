import fs from "node:fs";
import path from "node:path";
//#region src/infra/git-root.ts
const DEFAULT_GIT_DISCOVERY_MAX_DEPTH = 12;
function walkUpFrom(startDir, opts, resolveAtDir) {
	let current = path.resolve(startDir);
	const maxDepth = opts.maxDepth ?? DEFAULT_GIT_DISCOVERY_MAX_DEPTH;
	for (let i = 0; i < maxDepth; i += 1) {
		const resolved = resolveAtDir(current);
		if (resolved !== null && resolved !== void 0) return resolved;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}
function hasGitMarker(repoRoot) {
	const gitPath = path.join(repoRoot, ".git");
	try {
		const stat = fs.statSync(gitPath);
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}
function findGitRoot(startDir, opts = {}) {
	return walkUpFrom(startDir, opts, (repoRoot) => hasGitMarker(repoRoot) ? repoRoot : null);
}
function resolveGitDirFromMarker(repoRoot) {
	const gitPath = path.join(repoRoot, ".git");
	try {
		const stat = fs.statSync(gitPath);
		if (stat.isDirectory()) return gitPath;
		if (!stat.isFile()) return null;
		const match = fs.readFileSync(gitPath, "utf-8").match(/gitdir:\s*(.+)/i);
		if (!match?.[1]) return null;
		return path.resolve(repoRoot, match[1].trim());
	} catch {
		return null;
	}
}
function resolveGitHeadPath(startDir, opts = {}) {
	return walkUpFrom(startDir, opts, (repoRoot) => {
		const gitDir = resolveGitDirFromMarker(repoRoot);
		return gitDir ? path.join(gitDir, "HEAD") : null;
	});
}
//#endregion
export { resolveGitHeadPath as n, findGitRoot as t };
