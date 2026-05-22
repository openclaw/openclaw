import path from "node:path";
//#region src/media/file-name.ts
function basenameFromAnyPath(value) {
	return path.win32.basename(path.posix.basename(value));
}
function extnameFromAnyPath(value) {
	return path.extname(basenameFromAnyPath(value));
}
function nameFromAnyPath(value) {
	const base = basenameFromAnyPath(value);
	const ext = path.extname(base);
	return path.basename(base, ext);
}
//#endregion
export { extnameFromAnyPath as n, nameFromAnyPath as r, basenameFromAnyPath as t };
