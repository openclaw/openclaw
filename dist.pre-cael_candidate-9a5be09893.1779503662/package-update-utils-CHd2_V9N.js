import { u as readRootJsonObjectSync } from "./json-files-C2hqjU--.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/package-update-utils.ts
function expectedIntegrityForUpdate(spec, integrity) {
	if (!integrity || !spec) return;
	const value = spec.trim();
	if (!value) return;
	const at = value.lastIndexOf("@");
	if (at <= 0 || at >= value.length - 1) return;
	const version = value.slice(at + 1).trim();
	if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return;
	return integrity;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readInstalledPackageManifest(dir) {
	const result = readRootJsonObjectSync({
		rootDir: dir,
		relativePath: "package.json",
		boundaryLabel: "installed package directory"
	});
	return result.ok ? result.value : void 0;
}
async function readInstalledPackageVersion(dir) {
	const manifest = readInstalledPackageManifest(dir);
	return typeof manifest?.version === "string" ? manifest.version : void 0;
}
function readInstalledPackagePeerDependencies(dir) {
	const manifest = readInstalledPackageManifest(dir);
	const peerDependencies = isRecord(manifest?.peerDependencies) ? manifest.peerDependencies : {};
	return Object.fromEntries(Object.entries(peerDependencies).filter((entry) => {
		const [, value] = entry;
		return typeof value === "string";
	}));
}
function installedPackageNeedsOpenClawPeerLinkRepair(dir) {
	const peerDependencies = readInstalledPackagePeerDependencies(dir);
	if (!Object.hasOwn(peerDependencies, "openclaw")) return false;
	try {
		fs.statSync(path.join(dir, "node_modules", "openclaw"));
		return false;
	} catch (error) {
		const code = error?.code;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}
//#endregion
export { readInstalledPackageVersion as i, installedPackageNeedsOpenClawPeerLinkRepair as n, readInstalledPackagePeerDependencies as r, expectedIntegrityForUpdate as t };
