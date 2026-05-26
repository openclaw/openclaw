import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-Cog8gw3V.js";
import path from "node:path";
//#region src/plugin-sdk/browser-control-auth.ts
let cachedBrowserControlAuthSurface;
function loadBrowserControlAuthSurface() {
	cachedBrowserControlAuthSurface ??= loadBundledPluginPublicSurfaceModuleSync({
		dirName: "browser",
		artifactBasename: "browser-control-auth.js"
	});
	return cachedBrowserControlAuthSurface;
}
function resolveBrowserControlAuth(cfg, env = process.env) {
	return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}
async function ensureBrowserControlAuth(params) {
	return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
//#endregion
//#region src/plugin-sdk/browser-profiles.ts
const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 6e4;
const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 8e4;
const DEFAULT_UPLOAD_DIR = path.join(resolvePreferredOpenClawTmpDir(), "uploads");
let cachedBrowserProfilesSurface;
function loadBrowserProfilesSurface() {
	cachedBrowserProfilesSurface ??= loadBundledPluginPublicSurfaceModuleSync({
		dirName: "browser",
		artifactBasename: "browser-profiles.js"
	});
	return cachedBrowserProfilesSurface;
}
function resolveBrowserConfig(cfg, rootConfig) {
	return loadBrowserProfilesSurface().resolveBrowserConfig(cfg, rootConfig);
}
function resolveProfile(resolved, profileName) {
	return loadBrowserProfilesSurface().resolveProfile(resolved, profileName);
}
//#endregion
export { DEFAULT_OPENCLAW_BROWSER_COLOR as a, DEFAULT_UPLOAD_DIR as c, ensureBrowserControlAuth as d, resolveBrowserControlAuth as f, DEFAULT_BROWSER_EVALUATE_ENABLED as i, resolveBrowserConfig as l, DEFAULT_BROWSER_ACTION_TIMEOUT_MS as n, DEFAULT_OPENCLAW_BROWSER_ENABLED as o, DEFAULT_BROWSER_DEFAULT_PROFILE_NAME as r, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as s, DEFAULT_AI_SNAPSHOT_MAX_CHARS as t, resolveProfile as u };
