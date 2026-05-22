import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { u as resolveGatewayPort } from "./paths-C1_Y0cDn.js";
import { p as resolveUserPath } from "./utils-CCskKJVV.js";
import { d as isPathInside, u as isNotFoundPathError } from "./boundary-file-read-7ScTVYIc.js";
import { a as normalizeOptionalTrimmedStringList } from "./string-normalization-rJ4BOsjW.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-24Sjadc6.js";
import { i as isLoopbackHost } from "./net-xqHkLqZe.js";
import { s as openFileWithinRoot, t as SafeOpenError } from "./fs-safe-B3pr-X7V.js";
import "./text-runtime-icMZVCaq.js";
import "./sdk-security-runtime-Cv30jxE4.js";
import { I as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, M as DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS, O as DEFAULT_BROWSER_ACTION_TIMEOUT_MS, P as DEFAULT_OPENCLAW_BROWSER_COLOR, d as parseBrowserHttpUrl, j as DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS } from "./cdp.helpers-Cxaezg7w.js";
import { i as parseBooleanValue, n as deriveDefaultBrowserCdpPortRange, r as deriveDefaultBrowserControlPort } from "./sdk-config-Dx-K6r_b.js";
import "./tmp-openclaw-dir-D3BKK110.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/browser/src/browser/paths.ts
const DEFAULT_FALLBACK_BROWSER_TMP_DIR = "/tmp/openclaw";
function canUseNodeFs() {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return false;
	try {
		return getBuiltinModule("fs") !== void 0;
	} catch {
		return false;
	}
}
const DEFAULT_BROWSER_TMP_DIR = canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : DEFAULT_FALLBACK_BROWSER_TMP_DIR;
const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");
function invalidPath(scopeLabel) {
	return {
		ok: false,
		error: `Invalid path: must stay within ${scopeLabel}`
	};
}
async function resolveRealPathIfExists(targetPath) {
	try {
		return await fs.realpath(targetPath);
	} catch {
		return;
	}
}
async function resolveTrustedRootRealPath(rootDir) {
	try {
		const rootLstat = await fs.lstat(rootDir);
		if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) return;
		return await fs.realpath(rootDir);
	} catch {
		return;
	}
}
async function validateCanonicalPathWithinRoot(params) {
	try {
		const candidateLstat = await fs.lstat(params.candidatePath);
		if (candidateLstat.isSymbolicLink()) return "invalid";
		if (params.expect === "directory" && !candidateLstat.isDirectory()) return "invalid";
		if (params.expect === "file" && !candidateLstat.isFile()) return "invalid";
		if (params.expect === "file" && candidateLstat.nlink > 1) return "invalid";
		const candidateRealPath = await fs.realpath(params.candidatePath);
		return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
	} catch (err) {
		return isNotFoundPathError(err) ? "not-found" : "invalid";
	}
}
function resolvePathWithinRoot(params) {
	const root = path.resolve(params.rootDir);
	const raw = params.requestedPath.trim();
	if (!raw) {
		if (!params.defaultFileName) return {
			ok: false,
			error: "path is required"
		};
		return {
			ok: true,
			path: path.join(root, params.defaultFileName)
		};
	}
	const resolved = path.resolve(root, raw);
	const rel = path.relative(root, resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return {
		ok: false,
		error: `Invalid path: must stay within ${params.scopeLabel}`
	};
	return {
		ok: true,
		path: resolved
	};
}
async function resolveWritablePathWithinRoot(params) {
	const lexical = resolvePathWithinRoot(params);
	if (!lexical.ok) return lexical;
	const rootRealPath = await resolveTrustedRootRealPath(path.resolve(params.rootDir));
	if (!rootRealPath) return invalidPath(params.scopeLabel);
	const requestedPath = lexical.path;
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: path.dirname(requestedPath),
		expect: "directory"
	}) !== "ok") return invalidPath(params.scopeLabel);
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: requestedPath,
		expect: "file"
	}) === "invalid") return invalidPath(params.scopeLabel);
	return lexical;
}
async function resolveExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot(params, true);
}
async function resolveStrictExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot(params, false);
}
async function resolveCheckedPathsWithinRoot(params, allowMissingFallback) {
	const rootDir = path.resolve(params.rootDir);
	const rootRealPath = await resolveRealPathIfExists(rootDir);
	const isInRoot = (relativePath) => Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
	const resolveExistingRelativePath = async (requestedPath) => {
		const raw = requestedPath.trim();
		const lexicalPathResult = resolvePathWithinRoot({
			rootDir,
			requestedPath,
			scopeLabel: params.scopeLabel
		});
		if (lexicalPathResult.ok) return {
			ok: true,
			relativePath: path.relative(rootDir, lexicalPathResult.path),
			fallbackPath: lexicalPathResult.path
		};
		if (!rootRealPath || !raw || !path.isAbsolute(raw)) return lexicalPathResult;
		try {
			const resolvedExistingPath = await fs.realpath(raw);
			const relativePath = path.relative(rootRealPath, resolvedExistingPath);
			if (!isInRoot(relativePath)) return lexicalPathResult;
			return {
				ok: true,
				relativePath,
				fallbackPath: resolvedExistingPath
			};
		} catch {
			return lexicalPathResult;
		}
	};
	const resolvedPaths = [];
	for (const raw of params.requestedPaths) {
		const pathResult = await resolveExistingRelativePath(raw);
		if (!pathResult.ok) return {
			ok: false,
			error: pathResult.error
		};
		let opened;
		try {
			opened = await openFileWithinRoot({
				rootDir,
				relativePath: pathResult.relativePath
			});
			resolvedPaths.push(opened.realPath);
		} catch (err) {
			if (allowMissingFallback && err instanceof SafeOpenError && err.code === "not-found") {
				resolvedPaths.push(pathResult.fallbackPath);
				continue;
			}
			if (err instanceof SafeOpenError && err.code === "outside-workspace") return {
				ok: false,
				error: `File is outside ${params.scopeLabel}`
			};
			return {
				ok: false,
				error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`
			};
		} finally {
			await opened?.handle.close().catch(() => {});
		}
	}
	return {
		ok: true,
		paths: resolvedPaths
	};
}
//#endregion
//#region extensions/browser/src/browser/config.ts
const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const MAX_BROWSER_STARTUP_TIMEOUT_MS = 12e4;
const OPENCLAW_BROWSER_HEADLESS_ENV = "OPENCLAW_BROWSER_HEADLESS";
function normalizeHexColor(raw) {
	const value = (raw ?? "").trim();
	if (!value) return DEFAULT_OPENCLAW_BROWSER_COLOR;
	const normalized = value.startsWith("#") ? value : `#${value}`;
	if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return DEFAULT_OPENCLAW_BROWSER_COLOR;
	return normalized.toUpperCase();
}
function normalizeTimeoutMs(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return value < 0 ? fallback : value;
}
function normalizeStartupTimeoutMs(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	if (value <= 0) return fallback;
	return Math.min(value, MAX_BROWSER_STARTUP_TIMEOUT_MS);
}
function normalizeNonNegativeInteger(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return value < 0 ? fallback : value;
}
function normalizePositiveInteger(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return value <= 0 ? fallback : value;
}
function normalizeExecutablePath(raw) {
	const value = normalizeOptionalString(raw);
	if (!value) return;
	if (!/^~(?=$|[\\/])/.test(value)) return value;
	return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}
function normalizeExistingSessionCdpUrl(raw, profileName) {
	const value = normalizeOptionalString(raw);
	if (!value) return;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`browser.profiles.${profileName}.cdpUrl must be a valid URL.`);
	}
	if (![
		"http:",
		"https:",
		"ws:",
		"wss:"
	].includes(parsed.protocol)) throw new Error(`browser.profiles.${profileName}.cdpUrl must use http, https, ws, or wss.`);
	return {
		cdpUrl: parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString().replace(/\/$/, "") : parsed.toString(),
		cdpHost: parsed.hostname,
		cdpIsLoopback: isLoopbackHost(parsed.hostname)
	};
}
function hasLinuxDisplay(env) {
	return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}
function isLocalManagedProfile(profile) {
	return profile.driver === "openclaw" && profile.cdpIsLoopback && !profile.attachOnly;
}
function resolveBrowserTabCleanupConfig(cfg) {
	const raw = cfg?.tabCleanup;
	return {
		enabled: raw?.enabled ?? true,
		idleMinutes: normalizeNonNegativeInteger(raw?.idleMinutes, 120),
		maxTabsPerSession: normalizeNonNegativeInteger(raw?.maxTabsPerSession, 8),
		sweepMinutes: normalizePositiveInteger(raw?.sweepMinutes, 5)
	};
}
function resolveCdpPortRangeStart(rawStart, fallbackStart, rangeSpan) {
	const start = typeof rawStart === "number" && Number.isFinite(rawStart) ? Math.floor(rawStart) : fallbackStart;
	if (start < 1 || start > 65535) throw new Error(`browser.cdpPortRangeStart must be between 1 and 65535, got: ${start}`);
	const maxStart = 65535 - rangeSpan;
	if (start > maxStart) throw new Error(`browser.cdpPortRangeStart (${start}) is too high for a ${rangeSpan + 1}-port range; max is ${maxStart}.`);
	return start;
}
const normalizeStringList = normalizeOptionalTrimmedStringList;
function resolveBrowserSsrFPolicy(cfg) {
	const rawPolicy = cfg?.ssrfPolicy;
	const allowPrivateNetwork = rawPolicy?.allowPrivateNetwork;
	const dangerouslyAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork;
	const allowedHostnames = normalizeStringList(rawPolicy?.allowedHostnames);
	const hostnameAllowlist = normalizeStringList(rawPolicy?.hostnameAllowlist);
	const hasExplicitPrivateSetting = allowPrivateNetwork !== void 0 || dangerouslyAllowPrivateNetwork !== void 0;
	const resolvedAllowPrivateNetwork = dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true;
	if (!resolvedAllowPrivateNetwork && !hasExplicitPrivateSetting && !allowedHostnames && !hostnameAllowlist) return {};
	return {
		...resolvedAllowPrivateNetwork || dangerouslyAllowPrivateNetwork === false || allowPrivateNetwork === false ? { dangerouslyAllowPrivateNetwork: resolvedAllowPrivateNetwork } : {},
		...allowedHostnames ? { allowedHostnames } : {},
		...hostnameAllowlist ? { hostnameAllowlist } : {}
	};
}
function ensureDefaultProfile(profiles, defaultColor, legacyCdpPort, derivedDefaultCdpPort, legacyCdpUrl) {
	const result = { ...profiles };
	if (!result["openclaw"]) result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] = {
		cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? DEFAULT_BROWSER_CDP_PORT_RANGE_START,
		color: defaultColor,
		...legacyCdpUrl ? { cdpUrl: legacyCdpUrl } : {}
	};
	return result;
}
function ensureDefaultUserBrowserProfile(profiles) {
	const result = { ...profiles };
	if (result.user) return result;
	result.user = {
		driver: "existing-session",
		attachOnly: true,
		color: "#00AA00"
	};
	return result;
}
function resolveBrowserConfig(cfg, rootConfig) {
	const enabled = cfg?.enabled ?? true;
	const evaluateEnabled = cfg?.evaluateEnabled ?? true;
	const controlPort = deriveDefaultBrowserControlPort(resolveGatewayPort(rootConfig) ?? 18791);
	const defaultColor = normalizeHexColor(cfg?.color);
	const remoteCdpTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpTimeoutMs, 1500);
	const remoteCdpHandshakeTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpHandshakeTimeoutMs, Math.max(2e3, remoteCdpTimeoutMs * 2));
	const localLaunchTimeoutMs = normalizeStartupTimeoutMs(cfg?.localLaunchTimeoutMs, DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS);
	const localCdpReadyTimeoutMs = normalizeStartupTimeoutMs(cfg?.localCdpReadyTimeoutMs, DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS);
	const actionTimeoutMs = normalizeTimeoutMs(cfg?.actionTimeoutMs, DEFAULT_BROWSER_ACTION_TIMEOUT_MS);
	const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);
	const cdpRangeSpan = derivedCdpRange.end - derivedCdpRange.start;
	const cdpPortRangeStart = resolveCdpPortRangeStart(cfg?.cdpPortRangeStart, derivedCdpRange.start, cdpRangeSpan);
	const cdpPortRangeEnd = cdpPortRangeStart + cdpRangeSpan;
	const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
	let cdpInfo;
	if (rawCdpUrl) cdpInfo = parseBrowserHttpUrl(rawCdpUrl, "browser.cdpUrl");
	else {
		const derivedPort = controlPort + 1;
		if (derivedPort > 65535) throw new Error(`Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`);
		const derived = new URL(`http://127.0.0.1:${derivedPort}`);
		cdpInfo = {
			parsed: derived,
			port: derivedPort,
			normalized: derived.toString().replace(/\/$/, "")
		};
	}
	const headless = cfg?.headless === true;
	const headlessSource = typeof cfg?.headless === "boolean" ? "config" : "default";
	const noSandbox = cfg?.noSandbox === true;
	const attachOnly = cfg?.attachOnly === true;
	const executablePath = normalizeExecutablePath(cfg?.executablePath);
	const defaultProfileFromConfig = normalizeOptionalString(cfg?.defaultProfile);
	const legacyCdpPort = rawCdpUrl ? cdpInfo.port : void 0;
	const isWsUrl = cdpInfo.parsed.protocol === "ws:" || cdpInfo.parsed.protocol === "wss:";
	const legacyCdpUrl = rawCdpUrl && isWsUrl ? cdpInfo.normalized : void 0;
	const profiles = ensureDefaultUserBrowserProfile(ensureDefaultProfile(cfg?.profiles, defaultColor, legacyCdpPort, cdpPortRangeStart, legacyCdpUrl));
	const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";
	const defaultProfile = defaultProfileFromConfig ?? (profiles["openclaw"] ? "openclaw" : profiles["openclaw"] ? "openclaw" : "user");
	const extraArgs = Array.isArray(cfg?.extraArgs) ? cfg.extraArgs.filter((value) => typeof value === "string" && value.trim().length > 0) : [];
	return {
		enabled,
		evaluateEnabled,
		controlPort,
		cdpPortRangeStart,
		cdpPortRangeEnd,
		cdpProtocol,
		cdpHost: cdpInfo.parsed.hostname,
		cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
		remoteCdpTimeoutMs,
		remoteCdpHandshakeTimeoutMs,
		localLaunchTimeoutMs,
		localCdpReadyTimeoutMs,
		actionTimeoutMs,
		color: defaultColor,
		executablePath,
		headless,
		headlessSource,
		noSandbox,
		attachOnly,
		defaultProfile,
		profiles,
		tabCleanup: resolveBrowserTabCleanupConfig(cfg),
		ssrfPolicy: resolveBrowserSsrFPolicy(cfg),
		extraArgs
	};
}
function resolveProfile(resolved, profileName) {
	const profile = resolved.profiles[profileName];
	if (!profile) return null;
	const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
	let cdpHost = resolved.cdpHost;
	let cdpPort = profile.cdpPort ?? 0;
	let cdpUrl = "";
	const driver = profile.driver === "existing-session" ? "existing-session" : "openclaw";
	const headless = profile.headless ?? resolved.headless;
	const headlessSource = typeof profile.headless === "boolean" ? "profile" : resolved.headlessSource;
	const executablePath = normalizeExecutablePath(profile.executablePath) ?? resolved.executablePath;
	if (driver === "existing-session") {
		const existingSessionCdp = normalizeExistingSessionCdpUrl(rawProfileUrl, profileName);
		return {
			name: profileName,
			cdpPort: 0,
			cdpUrl: existingSessionCdp?.cdpUrl ?? "",
			cdpHost: existingSessionCdp?.cdpHost ?? "",
			cdpIsLoopback: existingSessionCdp?.cdpIsLoopback ?? true,
			userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || void 0,
			mcpCommand: normalizeOptionalString(profile.mcpCommand),
			mcpArgs: normalizeStringList(profile.mcpArgs) ?? void 0,
			color: profile.color,
			driver,
			executablePath,
			headless,
			headlessSource,
			attachOnly: true
		};
	}
	if (rawProfileUrl !== "" && cdpPort > 0 && /^wss?:\/\//i.test(rawProfileUrl) && /\/devtools\/browser\//i.test(rawProfileUrl)) {
		cdpHost = new URL(rawProfileUrl).hostname;
		cdpUrl = `${resolved.cdpProtocol}://${cdpHost}:${cdpPort}`;
	} else if (rawProfileUrl) {
		const parsed = parseBrowserHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
		cdpHost = parsed.parsed.hostname;
		cdpPort = parsed.port;
		cdpUrl = parsed.normalized;
	} else if (cdpPort) cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;
	else throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);
	return {
		name: profileName,
		cdpPort,
		cdpUrl,
		cdpHost,
		cdpIsLoopback: isLoopbackHost(cdpHost),
		color: profile.color,
		driver,
		executablePath,
		headless,
		headlessSource,
		attachOnly: profile.attachOnly ?? resolved.attachOnly
	};
}
function resolveManagedBrowserHeadlessMode(resolved, profile, params = {}) {
	if (!isLocalManagedProfile(profile)) return {
		headless: profile.headless,
		source: profile.headlessSource ?? "default"
	};
	if (typeof params.headlessOverride === "boolean") return {
		headless: params.headlessOverride,
		source: "request"
	};
	const env = params.env ?? process.env;
	const platform = params.platform ?? process.platform;
	const envHeadless = parseBooleanValue(env[OPENCLAW_BROWSER_HEADLESS_ENV]);
	if (envHeadless !== void 0) return {
		headless: envHeadless,
		source: "env"
	};
	const profileHeadlessSource = profile.headlessSource ?? "default";
	if (profileHeadlessSource !== "default") return {
		headless: profile.headless,
		source: profileHeadlessSource
	};
	if (platform === "linux" && !hasLinuxDisplay(env)) return {
		headless: true,
		source: "linux-display-fallback"
	};
	return {
		headless: resolved.headless,
		source: "default"
	};
}
function getManagedBrowserMissingDisplayError(resolved, profile, params = {}) {
	if (!isLocalManagedProfile(profile)) return null;
	const env = params.env ?? process.env;
	const platform = params.platform ?? process.platform;
	if (platform !== "linux" || hasLinuxDisplay(env)) return null;
	const mode = resolveManagedBrowserHeadlessMode(resolved, profile, {
		env,
		platform
	});
	if (mode.headless) return null;
	const sourceHint = mode.source === "request" ? "request override" : mode.source === "env" ? `${OPENCLAW_BROWSER_HEADLESS_ENV}=0` : mode.source === "profile" ? `browser.profiles.${profile.name}.headless=false` : "browser.headless=false";
	return `Headed browser start requested for profile "${profile.name}" via ${sourceHint}, but no Linux display server was detected (\$DISPLAY/\$WAYLAND_DISPLAY unset). Set ${OPENCLAW_BROWSER_HEADLESS_ENV}=1, remove the headed override, or launch under Xvfb.`;
}
//#endregion
export { DEFAULT_DOWNLOAD_DIR as a, resolveExistingPathsWithinRoot as c, resolveProfile as i, resolveStrictExistingPathsWithinRoot as l, resolveBrowserConfig as n, DEFAULT_TRACE_DIR as o, resolveManagedBrowserHeadlessMode as r, DEFAULT_UPLOAD_DIR as s, getManagedBrowserMissingDisplayError as t, resolveWritablePathWithinRoot as u };
