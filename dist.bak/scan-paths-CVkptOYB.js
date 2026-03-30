import path from "node:path";
import fs from "node:fs";

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
export { isPathInside as n, isPathInsideWithRealpath as r, extensionUsesSkippedScannerPath as t };