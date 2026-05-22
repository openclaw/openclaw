import { n as getWindowsProgramFilesRoots, t as getWindowsInstallRoots } from "./windows-install-roots-2thIF_8W.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/resolve-system-bin.ts
const UNIX_BASE_TRUSTED_DIRS = [
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin"
];
const DARWIN_STANDARD_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const LINUX_STANDARD_DIRS = ["/usr/local/bin"];
const WIN_PATHEXT = [
	".exe",
	".cmd",
	".bat",
	".com"
];
const resolvedCacheStrict = /* @__PURE__ */ new Map();
const resolvedCacheStandard = /* @__PURE__ */ new Map();
function defaultIsExecutable(filePath) {
	try {
		if (process.platform === "win32") fs.accessSync(filePath, fs.constants.R_OK);
		else fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
let isExecutableFn = defaultIsExecutable;
/**
* Build the trusted-dir list for Windows. Only system-managed directories
* are included; user-profile paths like %LOCALAPPDATA% are excluded.
*/
function buildWindowsTrustedDirs() {
	const dirs = [];
	const { systemRoot } = getWindowsInstallRoots();
	dirs.push(path.win32.join(systemRoot, "System32"));
	dirs.push(path.win32.join(systemRoot, "SysWOW64"));
	for (const programFilesRoot of getWindowsProgramFilesRoots()) {
		dirs.push(path.win32.join(programFilesRoot, "OpenSSL-Win64", "bin"));
		dirs.push(path.win32.join(programFilesRoot, "OpenSSL", "bin"));
		dirs.push(path.win32.join(programFilesRoot, "ffmpeg", "bin"));
	}
	return dirs;
}
/**
* Build the trusted-dir list for Unix (macOS, Linux, etc.), extending
* UNIX_BASE_TRUSTED_DIRS with platform/environment-specific paths.
*
* Strict: only fixed OS-managed directories.
*
* Standard: strict dirs plus platform package-manager directories appended
* after, so OS binaries always take priority.
*/
function buildUnixTrustedDirs(trust) {
	const dirs = [...UNIX_BASE_TRUSTED_DIRS];
	const platform = process.platform;
	if (platform === "linux") {
		dirs.push("/run/current-system/sw/bin");
		dirs.push("/snap/bin");
	}
	if (trust === "standard") {
		if (platform === "darwin") dirs.push(...DARWIN_STANDARD_DIRS);
		else if (platform === "linux") dirs.push(...LINUX_STANDARD_DIRS);
	}
	return dirs;
}
let trustedDirsStrict = null;
let trustedDirsStandard = null;
function getTrustedDirs(trust) {
	if (process.platform === "win32") {
		trustedDirsStrict ??= buildWindowsTrustedDirs();
		return trustedDirsStrict;
	}
	if (trust === "standard") {
		trustedDirsStandard ??= buildUnixTrustedDirs("standard");
		return trustedDirsStandard;
	}
	trustedDirsStrict ??= buildUnixTrustedDirs("strict");
	return trustedDirsStrict;
}
/**
* Resolve a binary name to an absolute path by searching only trusted system
* directories. Returns `null` when the binary is not found. Results are cached
* for the lifetime of the process.
*
* This MUST be used instead of bare binary names in `execFile`/`spawn` calls
* for internal infrastructure binaries (ffmpeg, ffprobe, openssl, etc.) to
* prevent PATH-hijack attacks via user-writable directories.
*/
function resolveSystemBin(name, opts) {
	const trust = opts?.trust ?? "strict";
	const hasExtra = (opts?.extraDirs?.length ?? 0) > 0;
	const cache = trust === "standard" ? resolvedCacheStandard : resolvedCacheStrict;
	if (!hasExtra) {
		const cached = cache.get(name);
		if (cached !== void 0) return cached;
	}
	const dirs = [...getTrustedDirs(trust), ...opts?.extraDirs ?? []];
	const isWin = process.platform === "win32";
	const hasExt = isWin && path.win32.extname(name).length > 0;
	for (const dir of dirs) if (isWin && !hasExt) for (const ext of WIN_PATHEXT) {
		const candidate = path.win32.join(dir, name + ext);
		if (isExecutableFn(candidate)) {
			if (!hasExtra) cache.set(name, candidate);
			return candidate;
		}
	}
	else {
		const candidate = path.join(dir, name);
		if (isExecutableFn(candidate)) {
			if (!hasExtra) cache.set(name, candidate);
			return candidate;
		}
	}
	return null;
}
//#endregion
export { resolveSystemBin as t };
