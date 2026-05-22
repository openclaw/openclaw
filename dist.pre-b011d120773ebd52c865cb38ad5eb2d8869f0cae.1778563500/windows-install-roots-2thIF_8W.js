import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
//#region src/infra/windows-install-roots.ts
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";
const WINDOWS_NT_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const WINDOWS_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";
const REG_QUERY_TIMEOUT_MS = 5e3;
let queryRegistryValueFn = defaultQueryRegistryValue;
let isReadableFileFn = defaultIsReadableFile;
let cachedProcessInstallRoots = null;
function defaultIsReadableFile(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
function trimTrailingSeparators(value) {
	const parsed = path.win32.parse(value);
	let trimmed = value;
	while (trimmed.length > parsed.root.length && /[\\/]/.test(trimmed.at(-1) ?? "")) trimmed = trimmed.slice(0, -1);
	return trimmed;
}
/**
* Windows install roots should be local absolute directories, not drive-relative
* paths, UNC shares, or PATH-like lists that could widen trust unexpectedly.
*/
function normalizeWindowsInstallRoot(raw) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.includes("\0") || trimmed.includes("\r") || trimmed.includes("\n") || trimmed.includes(";")) return null;
	const normalized = trimTrailingSeparators(path.win32.normalize(trimmed));
	if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) return null;
	const parsed = path.win32.parse(normalized);
	if (!/^[A-Za-z]:\\$/.test(parsed.root)) return null;
	if (normalized.length <= parsed.root.length) return null;
	return normalized;
}
function getEnvValueCaseInsensitive(env, expectedKey) {
	const direct = env[expectedKey];
	if (direct !== void 0) return direct;
	const upper = expectedKey.toUpperCase();
	const actualKey = Object.keys(env).find((key) => key.toUpperCase() === upper);
	return actualKey ? env[actualKey] : void 0;
}
function getWindowsRegExeCandidates() {
	return [path.win32.join(DEFAULT_WINDOWS_SYSTEM_ROOT, "System32", "reg.exe")];
}
function locateWindowsRegExe() {
	for (const candidate of getWindowsRegExeCandidates()) if (isReadableFileFn(candidate)) return candidate;
	return null;
}
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseRegQueryValue(stdout, valueName) {
	const pattern = new RegExp(`^\\s*${escapeRegex(valueName)}\\s+REG_[A-Z0-9_]+\\s+(.+)$`, "im");
	return stdout.match(pattern)?.[1]?.trim() || null;
}
function runRegQuery(regExe, key, valueName, use64BitView) {
	const args = [
		"query",
		key,
		"/v",
		valueName
	];
	if (use64BitView) args.push("/reg:64");
	return execFileSync(regExe, args, {
		encoding: "utf8",
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		timeout: REG_QUERY_TIMEOUT_MS,
		windowsHide: true
	});
}
function defaultQueryRegistryValue(key, valueName) {
	const regExe = locateWindowsRegExe();
	if (!regExe) return null;
	for (const use64BitView of [true, false]) try {
		const parsed = parseRegQueryValue(runRegQuery(regExe, key, valueName, use64BitView), valueName);
		if (parsed) return parsed;
	} catch {}
	return null;
}
function getRegistryInstallRoots() {
	return {
		systemRoot: normalizeWindowsInstallRoot(queryRegistryValueFn(WINDOWS_NT_CURRENT_VERSION_KEY, "SystemRoot") ?? void 0) ?? void 0,
		programFiles: normalizeWindowsInstallRoot(queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir") ?? void 0) ?? void 0,
		programFilesX86: normalizeWindowsInstallRoot(queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir (x86)") ?? void 0) ?? void 0,
		programW6432: normalizeWindowsInstallRoot(queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramW6432Dir") ?? void 0) ?? void 0
	};
}
function buildWindowsInstallRoots(env, useRegistryRoots) {
	const registryRoots = useRegistryRoots ? getRegistryInstallRoots() : {};
	const envProgramW6432 = normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramW6432"));
	const programW6432 = registryRoots.programW6432 ?? envProgramW6432 ?? null;
	return {
		systemRoot: registryRoots.systemRoot ?? normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ?? normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ?? "C:\\Windows",
		programFiles: registryRoots.programFiles ?? normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles")) ?? programW6432 ?? DEFAULT_PROGRAM_FILES,
		programFilesX86: registryRoots.programFilesX86 ?? normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles(x86)")) ?? DEFAULT_PROGRAM_FILES_X86,
		programW6432
	};
}
function getWindowsInstallRoots(env = process.env) {
	if (env === process.env) {
		cachedProcessInstallRoots ??= buildWindowsInstallRoots(env, true);
		return cachedProcessInstallRoots;
	}
	return buildWindowsInstallRoots(env, false);
}
function getWindowsProgramFilesRoots(env = process.env) {
	const roots = getWindowsInstallRoots(env);
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const value of [
		roots.programW6432,
		roots.programFiles,
		roots.programFilesX86
	]) {
		if (!value) continue;
		const key = normalizeLowercaseStringOrEmpty(value);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}
//#endregion
export { getWindowsProgramFilesRoots as n, getWindowsInstallRoots as t };
