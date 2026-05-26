import fs from "node:fs";
import path from "node:path";
//#region src/infra/is-main.ts
function normalizePathCandidate(candidate, cwd) {
	if (!candidate) return;
	const resolved = path.resolve(cwd, candidate);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
function resolveDefaultCwd(currentFile) {
	try {
		return process.cwd();
	} catch {
		return path.dirname(currentFile);
	}
}
function isMainModule({ currentFile, argv = process.argv, env = process.env, cwd, wrapperEntryPairs = [] }) {
	const resolvedCwd = cwd ?? resolveDefaultCwd(currentFile);
	const normalizedCurrent = normalizePathCandidate(currentFile, resolvedCwd);
	const normalizedArgv1 = normalizePathCandidate(argv[1], resolvedCwd);
	if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) return true;
	const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, resolvedCwd);
	if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) return true;
	if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
		const currentBase = path.basename(normalizedCurrent);
		const argvBase = path.basename(normalizedArgv1);
		if (wrapperEntryPairs.some(({ wrapperBasename, entryBasename }) => currentBase === entryBasename && argvBase === wrapperBasename)) return true;
	}
	return false;
}
//#endregion
export { isMainModule as t };
