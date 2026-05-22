import { t as sameFileIdentity } from "./file-identity-PAmF0zvV.js";
import { i as guardedRenameSync, o as guardedRmSync } from "./write-queue-BKRKUV0w.js";
import { s as getFsSafeTestHooks } from "./secure-temp-dir-GC3bO7Qi.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region node_modules/@openclaw/fs-safe/dist/trash.js
const TRASH_DESTINATION_COLLISION_CODES = new Set([
	"EEXIST",
	"ENOTEMPTY",
	"ERR_FS_CP_EEXIST"
]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;
function getFsErrorCode(error) {
	if (!error || typeof error !== "object" || !("code" in error)) return;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
function isTrashDestinationCollision(error) {
	const code = getFsErrorCode(error);
	return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}
function isSameOrChildPath(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
function resolveAllowedTrashRoots(allowedRoots) {
	const roots = [...allowedRoots ?? [os.homedir(), os.tmpdir()]].flatMap((root) => {
		const lexicalRoot = path.resolve(root);
		try {
			return [path.resolve(fs.realpathSync.native(root)), lexicalRoot];
		} catch {
			return [lexicalRoot];
		}
	});
	return [...new Set(roots)];
}
function resolveTrashTargetPath(targetPath) {
	try {
		return {
			path: path.resolve(fs.realpathSync.native(targetPath)),
			resolved: true
		};
	} catch {
		return {
			path: path.resolve(targetPath),
			resolved: false
		};
	}
}
function assertAllowedTrashTarget(targetPath, allowedRoots) {
	const stat = fs.lstatSync(path.resolve(targetPath));
	const resolvedTarget = resolveTrashTargetPath(targetPath);
	const resolvedTargetPath = resolvedTarget.path;
	if (!resolveAllowedTrashRoots(allowedRoots).some((root) => resolvedTargetPath !== root && isSameOrChildPath(resolvedTargetPath, root))) throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
	return {
		path: path.resolve(targetPath),
		realPath: resolvedTargetPath,
		realPathResolved: resolvedTarget.resolved,
		stat
	};
}
function assertTrashTargetGuard(guard) {
	if (!sameFileIdentity(fs.lstatSync(guard.path), guard.stat)) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
	const current = resolveTrashTargetPath(guard.path);
	if (guard.realPathResolved && (!current.resolved || current.path !== guard.realPath)) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
	if (!guard.realPathResolved && current.resolved) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
}
function resolveTrashDir() {
	const homeDir = os.homedir();
	const trashDir = path.join(homeDir, ".Trash");
	fs.mkdirSync(trashDir, {
		recursive: true,
		mode: 448
	});
	const trashDirStat = fs.lstatSync(trashDir);
	if (!trashDirStat.isDirectory() || trashDirStat.isSymbolicLink()) throw new Error(`Refusing to use non-directory/symlink trash directory: ${trashDir}`);
	const realHome = path.resolve(fs.realpathSync.native(homeDir));
	const resolvedTrashDir = path.resolve(fs.realpathSync.native(trashDir));
	if (resolvedTrashDir === realHome || !isSameOrChildPath(resolvedTrashDir, realHome)) throw new Error(`Trash directory escaped home directory: ${trashDir}`);
	return resolvedTrashDir;
}
function trashBaseName(targetPath) {
	const resolvedTargetPath = path.resolve(targetPath);
	if (resolvedTargetPath === path.parse(resolvedTargetPath).root) throw new Error(`Refusing to trash root path: ${targetPath}`);
	const base = path.basename(resolvedTargetPath).replace(/[\\/]+/g, "");
	if (!base) throw new Error(`Unable to derive safe trash basename for: ${targetPath}`);
	return base;
}
function resolveContainedPath(root, leaf) {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, leaf);
	if (!isSameOrChildPath(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) throw new Error(`Trash destination escaped trash directory: ${resolvedPath}`);
	return resolvedPath;
}
function reserveTrashDestination(trashDir, base, timestamp) {
	const containerPrefix = resolveContainedPath(trashDir, `${base}-${timestamp}-`);
	const container = fs.mkdtempSync(containerPrefix);
	const resolvedContainer = path.resolve(container);
	const resolvedTrashDir = path.resolve(trashDir);
	if (resolvedContainer === resolvedTrashDir || !isSameOrChildPath(resolvedContainer, resolvedTrashDir)) throw new Error(`Trash destination escaped trash directory: ${container}`);
	return resolveContainedPath(container, base);
}
function movePathToDestination(target, dest) {
	getFsSafeTestHooks()?.beforeTrashMove?.(target.path, dest);
	assertTrashTargetGuard(target);
	try {
		guardedRenameSync({
			from: target.path,
			to: dest
		});
		return true;
	} catch (error) {
		if (getFsErrorCode(error) !== "EXDEV") {
			if (isTrashDestinationCollision(error)) return false;
			throw error;
		}
	}
	try {
		assertTrashTargetGuard(target);
		fs.cpSync(target.path, dest, {
			recursive: true,
			force: false,
			errorOnExist: true
		});
		assertTrashTargetGuard(target);
		guardedRmSync({
			target: target.path,
			recursive: true,
			force: false,
			verifyAfter: false
		});
		return true;
	} catch (error) {
		if (isTrashDestinationCollision(error)) return false;
		throw error;
	}
}
async function movePathToTrash(targetPath, options = {}) {
	const base = trashBaseName(targetPath);
	const target = assertAllowedTrashTarget(targetPath, options.allowedRoots);
	const trashDir = resolveTrashDir();
	const timestamp = Date.now();
	for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
		const dest = reserveTrashDestination(trashDir, base, timestamp);
		if (movePathToDestination(target, dest)) return dest;
	}
	throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
//#endregion
export { movePathToTrash as t };
