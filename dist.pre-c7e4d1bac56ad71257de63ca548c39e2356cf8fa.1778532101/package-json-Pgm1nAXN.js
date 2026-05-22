import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/package-json.ts
async function readPackageVersion(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const version = JSON.parse(raw)?.version?.trim();
		return version ? version : null;
	} catch {
		return null;
	}
}
async function readPackageName(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const name = JSON.parse(raw)?.name?.trim();
		return name ? name : null;
	} catch {
		return null;
	}
}
//#endregion
export { readPackageVersion as n, readPackageName as t };
