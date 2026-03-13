import { t as __exportAll } from "./rolldown-runtime-DUslC3ob.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-BUEPRLe3.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
function walkUpFrom(startDir, opts, resolveAtDir) {
	let current = path.resolve(startDir);
	const maxDepth = opts.maxDepth ?? 12;
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
//#region src/infra/git-commit.ts
var git_commit_exports = /* @__PURE__ */ __exportAll({
	__testing: () => __testing,
	resolveCommitHash: () => resolveCommitHash
});
const formatCommit = (value) => {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/[0-9a-fA-F]{7,40}/);
	if (!match) return null;
	return match[0].slice(0, 7).toLowerCase();
};
const cachedGitCommitBySearchDir = /* @__PURE__ */ new Map();
function isMissingPathError(error) {
	if (!(error instanceof Error)) return false;
	const code = error.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
const resolveCommitSearchDir = (options) => {
	if (options.cwd) return path.resolve(options.cwd);
	if (options.moduleUrl) try {
		return path.dirname(fileURLToPath(options.moduleUrl));
	} catch {}
	return process.cwd();
};
/** Read at most `limit` bytes from a file to avoid unbounded reads. */
const safeReadFilePrefix = (filePath, limit = 256) => {
	const fd = fs.openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(limit);
		const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
		return buf.subarray(0, bytesRead).toString("utf-8");
	} finally {
		fs.closeSync(fd);
	}
};
const cacheGitCommit = (searchDir, commit) => {
	cachedGitCommitBySearchDir.set(searchDir, commit);
	return commit;
};
const clearCachedGitCommits = () => {
	cachedGitCommitBySearchDir.clear();
};
const resolveGitLookupDepth = (searchDir, packageRoot) => {
	if (!packageRoot) return;
	const relative = path.relative(packageRoot, searchDir);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return;
	return (relative ? relative.split(path.sep).filter(Boolean).length : 0) + 1;
};
const readCommitFromGit = (searchDir, packageRoot) => {
	const headPath = resolveGitHeadPath(searchDir, { maxDepth: resolveGitLookupDepth(searchDir, packageRoot) });
	if (!headPath) return;
	const head = fs.readFileSync(headPath, "utf-8").trim();
	if (!head) return null;
	if (head.startsWith("ref:")) {
		const refPath = resolveRefPath(headPath, head.replace(/^ref:\s*/i, "").trim());
		if (!refPath) return null;
		return formatCommit(safeReadFilePrefix(refPath).trim());
	}
	return formatCommit(head);
};
const resolveGitRefsBase = (headPath) => {
	const gitDir = path.dirname(headPath);
	try {
		const commonDir = safeReadFilePrefix(path.join(gitDir, "commondir")).trim();
		if (commonDir) return path.resolve(gitDir, commonDir);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}
	return gitDir;
};
/** Safely resolve a git ref path, rejecting traversal attacks from a crafted HEAD file. */
const resolveRefPath = (headPath, ref) => {
	if (!ref.startsWith("refs/")) return null;
	if (path.isAbsolute(ref)) return null;
	if (ref.split(/[/]/).includes("..")) return null;
	const refsBase = resolveGitRefsBase(headPath);
	const resolved = path.resolve(refsBase, ref);
	const rel = path.relative(refsBase, resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return resolved;
};
const readCommitFromPackageJson = () => {
	try {
		const pkg = createRequire(import.meta.url)("../../package.json");
		return formatCommit(pkg.gitHead ?? pkg.githead ?? null);
	} catch {
		return null;
	}
};
const readCommitFromBuildInfo = () => {
	try {
		const require = createRequire(import.meta.url);
		for (const candidate of ["../build-info.json", "./build-info.json"]) try {
			const formatted = formatCommit(require(candidate).commit ?? null);
			if (formatted) return formatted;
		} catch {}
		return null;
	} catch {
		return null;
	}
};
const resolveCommitHash = (options = {}) => {
	const env = options.env ?? process.env;
	const readers = options.readers ?? {};
	const readGitCommit = readers.readGitCommit ?? readCommitFromGit;
	const normalized = formatCommit(env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim());
	if (normalized) return normalized;
	const searchDir = resolveCommitSearchDir(options);
	if (cachedGitCommitBySearchDir.has(searchDir)) return cachedGitCommitBySearchDir.get(searchDir) ?? null;
	const packageRoot = resolveOpenClawPackageRootSync({
		cwd: options.cwd,
		moduleUrl: options.moduleUrl
	});
	try {
		const gitCommit = readGitCommit(searchDir, packageRoot);
		if (gitCommit !== void 0) return cacheGitCommit(searchDir, gitCommit);
	} catch {}
	const buildInfoCommit = readers.readBuildInfoCommit?.() ?? readCommitFromBuildInfo();
	if (buildInfoCommit) return cacheGitCommit(searchDir, buildInfoCommit);
	const pkgCommit = readers.readPackageJsonCommit?.() ?? readCommitFromPackageJson();
	if (pkgCommit) return cacheGitCommit(searchDir, pkgCommit);
	try {
		return cacheGitCommit(searchDir, readGitCommit(searchDir, packageRoot) ?? null);
	} catch {
		return cacheGitCommit(searchDir, null);
	}
};
const __testing = { clearCachedGitCommits };
//#endregion
export { resolveCommitHash as n, findGitRoot as r, git_commit_exports as t };
