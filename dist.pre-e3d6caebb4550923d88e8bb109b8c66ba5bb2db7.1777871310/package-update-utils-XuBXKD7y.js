import { i as openBoundaryFileSync } from "./boundary-file-read-7ScTVYIc.js";
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
async function readInstalledPackageVersion(dir) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "installed package directory"
	});
	if (!opened.ok) return;
	try {
		const raw = fs.readFileSync(opened.fd, "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	} finally {
		fs.closeSync(opened.fd);
	}
}
//#endregion
export { readInstalledPackageVersion as n, expectedIntegrityForUpdate as t };
