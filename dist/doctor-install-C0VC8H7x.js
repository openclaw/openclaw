import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-install.ts
function noteSourceInstallIssues(root) {
	if (!root) return;
	const srcEntry = path.join(root, "src", "entry.ts");
	const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
	if (!fs.existsSync(workspaceMarker) || !fs.existsSync(srcEntry)) return;
	const warnings = [];
	const nodeModules = path.join(root, "node_modules");
	const pnpmStore = path.join(nodeModules, ".pnpm");
	const tsxBin = path.join(nodeModules, ".bin", "tsx");
	if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) warnings.push("- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.");
	if (fs.existsSync(path.join(root, "package-lock.json"))) warnings.push("- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.");
	if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) warnings.push("- tsx binary is missing for source runs. Run: pnpm install.");
	if (warnings.length > 0) note(warnings.join("\n"), "Install");
}
//#endregion
export { noteSourceInstallIssues };
