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
function isMainModule({ currentFile, argv = process.argv, env = process.env, cwd = process.cwd(), wrapperEntryPairs = [] }) {
	const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
	const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);
	if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) return true;
	const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
	if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) return true;
	if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
		const currentBase = path.basename(normalizedCurrent);
		const argvBase = path.basename(normalizedArgv1);
		if (wrapperEntryPairs.some(({ wrapperBasename, entryBasename }) => currentBase === entryBasename && argvBase === wrapperBasename)) return true;
	}
	if (normalizedCurrent && normalizedArgv1 && path.basename(normalizedCurrent) === path.basename(normalizedArgv1)) return true;
	return false;
}

//#endregion
export { isMainModule as t };