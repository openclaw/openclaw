import { d as resolveConfigDir } from "./utils-CpmNtyoq.js";
import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-DLYui4Ze.js";
import { t as note } from "./note-Do3tkH_E.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-browser.ts
function loadBrowserDoctorSurface() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "browser",
		artifactBasename: "browser-doctor.js"
	});
}
function mayHaveLegacyClawdBrowserProfileResidue(deps) {
	const configDir = deps?.configDir ?? resolveConfigDir(deps?.env ?? process.env);
	const legacyProfileDir = path.join(configDir, "browser", "clawd");
	const legacyUserDataDir = path.join(legacyProfileDir, "user-data");
	const pathExists = deps?.pathExists ?? fs.existsSync;
	try {
		return pathExists(legacyProfileDir) || pathExists(legacyUserDataDir);
	} catch {
		return true;
	}
}
async function noteChromeMcpBrowserReadiness(cfg, deps) {
	try {
		await loadBrowserDoctorSurface().noteChromeMcpBrowserReadiness(cfg, deps);
	} catch (error) {
		(deps?.noteFn ?? note)(`- Browser health check is unavailable: ${error instanceof Error ? error.message : String(error)}`, "Browser");
	}
}
async function detectLegacyClawdBrowserProfileResidue(cfg, deps) {
	if (!mayHaveLegacyClawdBrowserProfileResidue(deps)) return null;
	const detect = loadBrowserDoctorSurface().detectLegacyClawdBrowserProfileResidue;
	if (!detect) return null;
	return detect(cfg, deps);
}
async function maybeArchiveLegacyClawdBrowserProfileResidue(cfg, deps) {
	if (!mayHaveLegacyClawdBrowserProfileResidue(deps)) return {
		changes: [],
		warnings: []
	};
	try {
		const repair = loadBrowserDoctorSurface().maybeArchiveLegacyClawdBrowserProfileResidue;
		if (!repair) return {
			changes: [],
			warnings: []
		};
		return await repair(cfg, deps);
	} catch (error) {
		return {
			changes: [],
			warnings: [`Browser profile cleanup is unavailable: ${error instanceof Error ? error.message : String(error)}`]
		};
	}
}
//#endregion
export { maybeArchiveLegacyClawdBrowserProfileResidue as n, noteChromeMcpBrowserReadiness as r, detectLegacyClawdBrowserProfileResidue as t };
