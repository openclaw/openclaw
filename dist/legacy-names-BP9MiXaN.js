import fs from "node:fs";
import path from "node:path";

//#region src/security/scan-paths.ts
function isPathInside(basePath, candidatePath) {
	const base = path.resolve(basePath);
	const candidate = path.resolve(candidatePath);
	const rel = path.relative(base, candidate);
	return rel === "" || !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}
function safeRealpathSync(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return null;
	}
}
function isPathInsideWithRealpath(basePath, candidatePath, opts) {
	if (!isPathInside(basePath, candidatePath)) return false;
	const baseReal = safeRealpathSync(basePath);
	const candidateReal = safeRealpathSync(candidatePath);
	if (!baseReal || !candidateReal) return opts?.requireRealpath !== true;
	return isPathInside(baseReal, candidateReal);
}
function extensionUsesSkippedScannerPath(entry) {
	return entry.split(/[\\/]+/).filter(Boolean).some((segment) => segment === "node_modules" || segment.startsWith(".") && segment !== "." && segment !== "..");
}

//#endregion
//#region src/compat/legacy-names.ts
const PROJECT_NAME = "openclaw";
const LEGACY_PROJECT_NAMES = [];
const MANIFEST_KEY = PROJECT_NAME;
const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;

//#endregion
export { isPathInsideWithRealpath as a, isPathInside as i, MANIFEST_KEY as n, extensionUsesSkippedScannerPath as r, LEGACY_MANIFEST_KEYS as t };