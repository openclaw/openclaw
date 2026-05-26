import { c as normalizeOptionalString } from "../../string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "../../command-format-BPjMauol.js";
import { p as resolveUserPath, t as CONFIG_DIR } from "../../utils-sBTEdeml.js";
import { n as asNullableRecord } from "../../record-coerce-aMlBWINm.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as note } from "../../note-Dg2Luaaq.js";
import { q as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME } from "../../cdp.helpers-D-78hr0t.js";
import { n as resolveBrowserConfig } from "../../config-F211Ihcd.js";
import { i as resolveGoogleChromeExecutableForPlatform, n as readBrowserVersion, r as resolveBrowserExecutableForPlatform, t as parseBrowserMajorVersion } from "../../chrome.executables-C_GQZhm-.js";
import { t as movePathToTrash } from "../../trash-9JTCtLvh.js";
import "../../record-shared-D84z0tk0.js";
import "../../sdk-setup-tools-C1n7gEuG.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/browser/src/doctor-browser.ts
const CHROME_MCP_MIN_MAJOR = 144;
const LEGACY_CLAWD_BROWSER_PROFILE_NAME = "clawd";
const REMOTE_DEBUGGING_PAGES = [
	"chrome://inspect/#remote-debugging",
	"brave://inspect/#remote-debugging",
	"edge://inspect/#remote-debugging"
].join(", ");
function collectChromeMcpProfiles(cfg) {
	const browser = asNullableRecord(cfg.browser);
	if (!browser) return [];
	const profiles = /* @__PURE__ */ new Map();
	if ((normalizeOptionalString(browser.defaultProfile) ?? "") === "user") profiles.set("user", { name: "user" });
	const configuredProfiles = asNullableRecord(browser.profiles);
	if (!configuredProfiles) return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
	for (const [profileName, rawProfile] of Object.entries(configuredProfiles)) {
		const profile = asNullableRecord(rawProfile);
		if ((normalizeOptionalString(profile?.driver) ?? "") === "existing-session") profiles.set(profileName, {
			name: profileName,
			userDataDir: normalizeOptionalString(profile?.userDataDir)
		});
	}
	return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
function collectManagedProfiles(cfg) {
	const browser = asNullableRecord(cfg.browser);
	if (!browser) return [];
	const profiles = /* @__PURE__ */ new Map();
	const defaultProfile = normalizeOptionalString(browser.defaultProfile) ?? "";
	if (defaultProfile && defaultProfile !== "user") profiles.set(defaultProfile, { name: defaultProfile });
	const configuredProfiles = asNullableRecord(browser.profiles);
	if (!configuredProfiles) return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
	for (const [profileName, rawProfile] of Object.entries(configuredProfiles)) if ((normalizeOptionalString(asNullableRecord(rawProfile)?.driver) ?? "openclaw") !== "existing-session") profiles.set(profileName, { name: profileName });
	return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
function resolveManagedBrowserProfileDir(configDir, profileName) {
	return path.join(configDir, "browser", profileName);
}
function resolveManagedBrowserUserDataDir(configDir, profileName) {
	return path.join(resolveManagedBrowserProfileDir(configDir, profileName), "user-data");
}
function normalizeComparablePath(targetPath) {
	return path.resolve(targetPath);
}
function isSameOrChildPath(candidatePath, parentPath) {
	const candidate = normalizeComparablePath(candidatePath);
	const parent = normalizeComparablePath(parentPath);
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
function isLegacyClawdProfileConfigured(cfg, legacyProfileDir) {
	const browser = asNullableRecord(cfg.browser);
	if (!browser) return false;
	if (normalizeOptionalString(browser.defaultProfile) === LEGACY_CLAWD_BROWSER_PROFILE_NAME) return true;
	const configuredProfiles = asNullableRecord(browser.profiles);
	if (!configuredProfiles) return false;
	if (Object.prototype.hasOwnProperty.call(configuredProfiles, LEGACY_CLAWD_BROWSER_PROFILE_NAME)) return true;
	for (const rawProfile of Object.values(configuredProfiles)) {
		const userDataDir = normalizeOptionalString(asNullableRecord(rawProfile)?.userDataDir);
		if (userDataDir && isSameOrChildPath(resolveUserPath(userDataDir), legacyProfileDir)) return true;
	}
	return false;
}
function detectLegacyClawdBrowserProfileResidue(cfg, deps) {
	const configDir = deps?.configDir ?? CONFIG_DIR;
	const legacyProfileDir = resolveManagedBrowserProfileDir(configDir, LEGACY_CLAWD_BROWSER_PROFILE_NAME);
	const legacyUserDataDir = resolveManagedBrowserUserDataDir(configDir, LEGACY_CLAWD_BROWSER_PROFILE_NAME);
	const pathExists = deps?.pathExists ?? fs.existsSync;
	if (!pathExists(legacyProfileDir) && !pathExists(legacyUserDataDir)) return null;
	if (isLegacyClawdProfileConfigured(cfg, legacyProfileDir)) return null;
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const defaultProfile = resolved.profiles[resolved.defaultProfile];
	if (resolved.defaultProfile !== "openclaw" || defaultProfile?.driver === "existing-session") return null;
	return {
		legacyProfileDir,
		legacyUserDataDir,
		canonicalUserDataDir: resolveManagedBrowserUserDataDir(configDir, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME)
	};
}
function formatLegacyClawdBrowserProfileResidueNote(residue) {
	return [
		`- Legacy managed browser profile residue was found at ${residue.legacyProfileDir}.`,
		`- The canonical OpenClaw-managed browser profile is ${residue.canonicalUserDataDir}.`,
		`- If no browser is using the legacy profile, run ${formatCliCommand("openclaw doctor --fix")} to archive it safely instead of deleting it in place.`
	].join("\n");
}
async function noteChromeMcpBrowserReadiness(cfg, deps) {
	const noteFn = deps?.noteFn ?? note;
	const platform = deps?.platform ?? process.platform;
	const env = deps?.env ?? process.env;
	const getUid = deps?.getUid ?? (() => process.getuid?.() ?? -1);
	const resolveManagedExecutable = deps?.resolveManagedExecutable ?? resolveBrowserExecutableForPlatform;
	const resolveChromeExecutable = deps?.resolveChromeExecutable ?? resolveGoogleChromeExecutableForPlatform;
	const readVersion = deps?.readVersion ?? readBrowserVersion;
	const managedProfiles = collectManagedProfiles(cfg);
	const managedProfileLabel = managedProfiles.map((profile) => profile.name).join(", ");
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const legacyClawdResidue = detectLegacyClawdBrowserProfileResidue(cfg, {
		configDir: deps?.configDir,
		pathExists: deps?.pathExists
	});
	if (legacyClawdResidue) noteFn(formatLegacyClawdBrowserProfileResidueNote(legacyClawdResidue), "Browser");
	const browserExecutable = managedProfiles.length > 0 ? resolveManagedExecutable(resolved, platform) : null;
	const missingDisplay = platform === "linux" && managedProfiles.length > 0 && !resolved.headless && !normalizeOptionalString(env.DISPLAY) && !normalizeOptionalString(env.WAYLAND_DISPLAY);
	const shouldWarnRootNoSandbox = platform === "linux" && managedProfiles.length > 0 && !resolved.noSandbox && getUid() === 0;
	if (!browserExecutable && managedProfiles.length > 0) noteFn([
		`- OpenClaw-managed browser profile(s) are configured: ${managedProfileLabel}.`,
		"- No Chromium-based browser executable was found on this host for OpenClaw-managed launch.",
		"- Install Chrome, Chromium, Brave, Edge, or set browser.executablePath explicitly."
	].join("\n"), "Browser");
	if (missingDisplay || shouldWarnRootNoSandbox) {
		const lines = [`- OpenClaw-managed browser profile(s) are configured: ${managedProfileLabel}.`];
		if (missingDisplay) lines.push("- No DISPLAY or WAYLAND_DISPLAY is set, and browser.headless is false. Managed browser launch needs a desktop session, Xvfb, or browser.headless: true.");
		if (shouldWarnRootNoSandbox) lines.push("- The Gateway is running as root and browser.noSandbox is false. Chromium commonly requires browser.noSandbox: true in container/root runtimes.");
		noteFn(lines.join("\n"), "Browser");
	}
	const profiles = collectChromeMcpProfiles(cfg);
	if (profiles.length === 0) return;
	const explicitProfiles = profiles.filter((profile) => profile.userDataDir);
	const autoConnectProfiles = profiles.filter((profile) => !profile.userDataDir);
	const profileLabel = profiles.map((profile) => profile.name).join(", ");
	if (autoConnectProfiles.length === 0) {
		noteFn([
			`- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
			"- These profiles use an explicit Chromium user data directory instead of Chrome's default auto-connect path.",
			`- Verify the matching Chromium-based browser is version ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node.`,
			`- Enable remote debugging in that browser's inspect page (${REMOTE_DEBUGGING_PAGES}).`,
			"- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects."
		].join("\n"), "Browser");
		return;
	}
	const chrome = resolveChromeExecutable(platform);
	const autoProfileLabel = autoConnectProfiles.map((profile) => profile.name).join(", ");
	if (!chrome) {
		const lines = [
			`- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
			`- Google Chrome was not found on this host for auto-connect profile(s): ${autoProfileLabel}. OpenClaw does not bundle Chrome.`,
			`- Install Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node, or set browser.profiles.<name>.userDataDir for a different Chromium-based browser.`,
			`- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`,
			"- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
			"- Docker, headless, and sandbox browser flows stay on raw CDP; this check only applies to host-local Chrome MCP attach."
		];
		if (explicitProfiles.length > 0) lines.push(`- Profiles with explicit userDataDir skip Chrome auto-detection: ${explicitProfiles.map((profile) => profile.name).join(", ")}.`);
		noteFn(lines.join("\n"), "Browser");
		return;
	}
	const versionRaw = readVersion(chrome.path);
	const major = parseBrowserMajorVersion(versionRaw);
	const lines = [`- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`, `- Chrome path: ${chrome.path}`];
	if (!versionRaw || major === null) lines.push(`- Could not determine the installed Chrome version. Chrome MCP requires Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on this host.`);
	else if (major < CHROME_MCP_MIN_MAJOR) lines.push(`- Detected Chrome ${versionRaw}, which is too old for Chrome MCP existing-session attach. Upgrade to Chrome ${CHROME_MCP_MIN_MAJOR}+.`);
	else lines.push(`- Detected Chrome ${versionRaw}.`);
	lines.push(`- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`);
	lines.push("- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.");
	if (explicitProfiles.length > 0) lines.push(`- Profiles with explicit userDataDir still need manual validation of the matching Chromium-based browser: ${explicitProfiles.map((profile) => profile.name).join(", ")}.`);
	noteFn(lines.join("\n"), "Browser");
}
async function maybeArchiveLegacyClawdBrowserProfileResidue(cfg, deps) {
	const residue = detectLegacyClawdBrowserProfileResidue(cfg, deps);
	if (!residue) return {
		changes: [],
		warnings: []
	};
	const move = deps?.movePathToTrash ?? movePathToTrash;
	try {
		const archivedPath = await move(residue.legacyProfileDir);
		return {
			changes: [[
				"Archived legacy clawd managed browser profile residue.",
				`- legacy profile: ${residue.legacyProfileDir}`,
				`- canonical profile: ${residue.canonicalUserDataDir}`,
				`- archived at: ${archivedPath}`
			].join("\n")],
			warnings: []
		};
	} catch (error) {
		return {
			changes: [],
			warnings: [`Legacy clawd browser profile residue could not be archived: ${error instanceof Error ? error.message : String(error)}`]
		};
	}
}
//#endregion
export { detectLegacyClawdBrowserProfileResidue, maybeArchiveLegacyClawdBrowserProfileResidue, noteChromeMcpBrowserReadiness };
