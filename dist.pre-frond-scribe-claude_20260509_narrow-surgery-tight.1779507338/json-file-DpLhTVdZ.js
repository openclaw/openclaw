import "./fs-safe-defaults-B7hUN42l.js";
import { h as writeJsonSync, p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/json-file.ts
function resolveJsonSymlinkTarget(pathname) {
	let stat;
	try {
		stat = fs.lstatSync(pathname);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	if (!stat.isSymbolicLink()) return;
	return path.resolve(path.dirname(pathname), fs.readlinkSync(pathname));
}
function resolveJsonSaveTarget(pathname) {
	const target = resolveJsonSymlinkTarget(pathname);
	if (!target) return pathname;
	fs.statSync(path.dirname(target));
	return target;
}
function saveJsonFile(pathname, data) {
	writeJsonSync(resolveJsonSaveTarget(pathname), data);
}
function loadJsonFile(pathname) {
	const direct = tryReadJsonSync(pathname);
	if (direct !== null) return direct;
	const target = resolveJsonSymlinkTarget(pathname);
	return target ? tryReadJsonSync(target) ?? void 0 : void 0;
}
//#endregion
export { saveJsonFile as n, loadJsonFile as t };
