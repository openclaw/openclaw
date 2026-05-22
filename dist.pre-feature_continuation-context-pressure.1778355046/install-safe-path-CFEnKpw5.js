import { s as isPathInside } from "./boundary-path-DbcMiy8Y.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
//#region src/infra/install-safe-path.ts
function unscopedPackageName(name) {
	const trimmed = name.trim();
	if (!trimmed) return trimmed;
	return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
}
function packageNameMatchesId(packageName, id) {
	const trimmedId = id.trim();
	if (!trimmedId) return false;
	const trimmedPackageName = packageName.trim();
	if (!trimmedPackageName) return false;
	return trimmedId === trimmedPackageName || trimmedId === unscopedPackageName(trimmedPackageName);
}
function safeDirName(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}
function safePathSegmentHashed(input) {
	const trimmed = input.trim();
	const base = trimmed.replaceAll(/[\\/]/g, "-").replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").replaceAll(/^-+/g, "").replaceAll(/-+$/g, "");
	const normalized = base.length > 0 ? base : "skill";
	const safe = normalized === "." || normalized === ".." ? "skill" : normalized;
	const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
	if (safe !== trimmed) return `${safe.length > 50 ? safe.slice(0, 50) : safe}-${hash}`;
	if (safe.length > 60) return `${safe.slice(0, 50)}-${hash}`;
	return safe;
}
function resolveSafeInstallDir(params) {
	const encodedName = (params.nameEncoder ?? safeDirName)(params.id);
	const targetDir = path.join(params.baseDir, encodedName);
	const resolvedBase = path.resolve(params.baseDir);
	const resolvedTarget = path.resolve(targetDir);
	const relative = path.relative(resolvedBase, resolvedTarget);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return {
		ok: false,
		error: params.invalidNameMessage
	};
	return {
		ok: true,
		path: targetDir
	};
}
async function assertCanonicalPathWithinBase(params) {
	const baseDir = path.resolve(params.baseDir);
	const candidatePath = path.resolve(params.candidatePath);
	if (!isPathInside(baseDir, candidatePath)) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	const baseLstat = await fs.lstat(baseDir);
	if (baseLstat.isSymbolicLink()) {
		if (!(await fs.stat(baseDir)).isDirectory()) throw new Error(`Invalid ${params.boundaryLabel}: base directory must resolve to a directory`);
	} else if (!baseLstat.isDirectory()) throw new Error(`Invalid ${params.boundaryLabel}: base directory must be a directory`);
	const baseRealPath = await fs.realpath(baseDir);
	const validateDirectory = async (dirPath) => {
		const resolvedDirPath = path.resolve(dirPath);
		const dirLstat = await fs.lstat(dirPath);
		if (dirLstat.isSymbolicLink()) {
			if (resolvedDirPath !== baseDir) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
			if (!(await fs.stat(dirPath)).isDirectory()) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
		} else if (!dirLstat.isDirectory()) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
		if (!isPathInside(baseRealPath, await fs.realpath(dirPath))) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	};
	try {
		await validateDirectory(candidatePath);
		return;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	await validateDirectory(path.dirname(candidatePath));
}
//#endregion
export { safePathSegmentHashed as a, safeDirName as i, packageNameMatchesId as n, unscopedPackageName as o, resolveSafeInstallDir as r, assertCanonicalPathWithinBase as t };
