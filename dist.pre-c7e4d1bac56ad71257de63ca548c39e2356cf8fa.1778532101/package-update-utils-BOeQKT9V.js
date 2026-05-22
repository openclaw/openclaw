import { i as openBoundaryFileSync } from "./boundary-file-read-oFRaIDYB.js";
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
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "installed package directory"
	});
	if (!opened.ok) return;
	try {
		const parsed = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	} finally {
		fs.closeSync(opened.fd);
	}
}
async function readInstalledPackageVersion(dir) {
	const manifest = readInstalledPackageManifest(dir);
	return typeof manifest?.version === "string" ? manifest.version : void 0;
}
function installedPackageNeedsOpenClawPeerLinkRepair(dir) {
	const manifest = readInstalledPackageManifest(dir);
	const peerDependencies = isRecord(manifest?.peerDependencies) ? manifest.peerDependencies : {};
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
export { installedPackageNeedsOpenClawPeerLinkRepair as n, readInstalledPackageVersion as r, expectedIntegrityForUpdate as t };
