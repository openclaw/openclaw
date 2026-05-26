import fs from "node:fs";
import path from "node:path";
//#region src/shared/config-eval.ts
function isTruthy(value) {
	if (value === void 0 || value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}
function resolveConfigPath(config, pathStr) {
	const parts = pathStr.split(".").filter(Boolean);
	let current = config;
	for (const part of parts) {
		if (typeof current !== "object" || current === null) return;
		current = current[part];
	}
	return current;
}
function isConfigPathTruthyWithDefaults(config, pathStr, defaults) {
	const value = resolveConfigPath(config, pathStr);
	if (value === void 0 && pathStr in defaults) return defaults[pathStr] ?? false;
	return isTruthy(value);
}
function evaluateRuntimeRequires(params) {
	const requires = params.requires;
	if (!requires) return true;
	const requiredBins = requires.bins ?? [];
	if (requiredBins.length > 0) for (const bin of requiredBins) {
		if (params.hasBin(bin)) continue;
		if (params.hasRemoteBin?.(bin)) continue;
		return false;
	}
	const requiredAnyBins = requires.anyBins ?? [];
	if (requiredAnyBins.length > 0) {
		if (!requiredAnyBins.some((bin) => params.hasBin(bin)) && !params.hasAnyRemoteBin?.(requiredAnyBins)) return false;
	}
	const requiredEnv = requires.env ?? [];
	if (requiredEnv.length > 0) {
		for (const envName of requiredEnv) if (!params.hasEnv(envName)) return false;
	}
	const requiredConfig = requires.config ?? [];
	if (requiredConfig.length > 0) {
		for (const configPath of requiredConfig) if (!params.isConfigPathTruthy(configPath)) return false;
	}
	return true;
}
function evaluateRuntimeEligibility(params) {
	const osList = params.os ?? [];
	const remotePlatforms = params.remotePlatforms ?? [];
	if (osList.length > 0 && !osList.includes(resolveRuntimePlatform()) && !remotePlatforms.some((platform) => osList.includes(platform))) return false;
	if (params.always === true) return true;
	return evaluateRuntimeRequires({
		requires: params.requires,
		hasBin: params.hasBin,
		hasRemoteBin: params.hasRemoteBin,
		hasAnyRemoteBin: params.hasAnyRemoteBin,
		hasEnv: params.hasEnv,
		isConfigPathTruthy: params.isConfigPathTruthy
	});
}
function resolveRuntimePlatform() {
	return process.platform;
}
function windowsPathExtensions() {
	const raw = process.env.PATHEXT;
	return ["", ...(raw !== void 0 ? raw.split(";").map((v) => v.trim()) : [
		".EXE",
		".CMD",
		".BAT",
		".COM"
	]).filter(Boolean)];
}
let cachedHasBinaryPath;
let cachedHasBinaryPathExt;
const hasBinaryCache = /* @__PURE__ */ new Map();
function hasBinary(bin) {
	const pathEnv = process.env.PATH ?? "";
	const pathExt = process.platform === "win32" ? process.env.PATHEXT ?? "" : "";
	if (cachedHasBinaryPath !== pathEnv || cachedHasBinaryPathExt !== pathExt) {
		cachedHasBinaryPath = pathEnv;
		cachedHasBinaryPathExt = pathExt;
		hasBinaryCache.clear();
	}
	if (hasBinaryCache.has(bin)) return hasBinaryCache.get(bin);
	const parts = pathEnv.split(path.delimiter).filter(Boolean);
	const extensions = process.platform === "win32" ? windowsPathExtensions() : [""];
	for (const part of parts) for (const ext of extensions) {
		const candidate = path.join(part, bin + ext);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			hasBinaryCache.set(bin, true);
			return true;
		} catch {}
	}
	hasBinaryCache.set(bin, false);
	return false;
}
//#endregion
export { resolveRuntimePlatform as a, resolveConfigPath as i, hasBinary as n, isConfigPathTruthyWithDefaults as r, evaluateRuntimeEligibility as t };
