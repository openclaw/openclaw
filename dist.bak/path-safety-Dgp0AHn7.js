import { f as isPathInside } from "./openclaw-root-PhSD0wUu.js";
import path from "node:path";

//#region src/infra/path-safety.ts
function resolveSafeBaseDir(rootDir) {
	const resolved = path.resolve(rootDir);
	return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}
function isWithinDir(rootDir, targetPath) {
	return isPathInside(rootDir, targetPath);
}

//#endregion
export { resolveSafeBaseDir as n, isWithinDir as t };