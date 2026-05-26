import { o as tryReadJson } from "./json-files-C2hqjU--.js";
import path from "node:path";
//#region src/infra/package-json.ts
function normalizeString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
async function readPackageJson(root) {
	const parsed = await tryReadJson(path.join(root, "package.json"));
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}
async function readPackageVersion(root) {
	return normalizeString((await readPackageJson(root))?.version);
}
async function readPackageName(root) {
	return normalizeString((await readPackageJson(root))?.name);
}
async function readPackageManagerSpec(root) {
	return normalizeString((await readPackageJson(root))?.packageManager);
}
//#endregion
export { readPackageName as n, readPackageVersion as r, readPackageManagerSpec as t };
