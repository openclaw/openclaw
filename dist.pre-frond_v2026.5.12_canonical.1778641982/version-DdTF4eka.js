import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { createRequire } from "node:module";
//#region src/version.ts
const CORE_PACKAGE_NAME = "openclaw";
const PACKAGE_JSON_CANDIDATES = [
	"../package.json",
	"../../package.json",
	"../../../package.json",
	"./package.json"
];
const BUILD_INFO_CANDIDATES = [
	"../build-info.json",
	"../../build-info.json",
	"./build-info.json"
];
function readVersionFromJsonCandidates(moduleUrl, candidates, opts = {}) {
	try {
		const require = createRequire(moduleUrl);
		for (const candidate of candidates) try {
			const parsed = require(candidate);
			const version = normalizeOptionalString(parsed.version);
			if (!version) continue;
			if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) continue;
			return version;
		} catch {}
		return null;
	} catch {
		return null;
	}
}
function firstNonEmpty(...values) {
	for (const value of values) {
		const trimmed = normalizeOptionalString(value);
		if (trimmed) return trimmed;
	}
}
function readVersionFromPackageJsonForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, { requirePackageName: true });
}
function readVersionFromBuildInfoForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}
function resolveVersionFromModuleUrl(moduleUrl) {
	return readVersionFromPackageJsonForModuleUrl(moduleUrl) || readVersionFromBuildInfoForModuleUrl(moduleUrl);
}
function resolveBinaryVersion(params) {
	return firstNonEmpty(params.injectedVersion) || resolveVersionFromModuleUrl(params.moduleUrl) || firstNonEmpty(params.bundledVersion) || params.fallback || "0.0.0";
}
const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
function resolveUsableRuntimeVersion(version) {
	const trimmed = normalizeOptionalString(version);
	if (!trimmed || trimmed === "0.0.0") return;
	return trimmed;
}
function resolveVersionFromRuntimeSources(params) {
	return firstNonEmpty(...params.preference === "env-first" ? [params.env["OPENCLAW_VERSION"], params.runtimeVersion] : [params.runtimeVersion, params.env["OPENCLAW_VERSION"]], params.env["OPENCLAW_SERVICE_VERSION"], params.env["npm_package_version"]) ?? params.fallback;
}
function resolveRuntimeServiceVersion(env = process.env, fallback = RUNTIME_SERVICE_VERSION_FALLBACK) {
	return resolveVersionFromRuntimeSources({
		env,
		runtimeVersion: resolveUsableRuntimeVersion(VERSION),
		fallback,
		preference: "env-first"
	});
}
function resolveCompatibilityHostVersion(env = process.env, fallback = RUNTIME_SERVICE_VERSION_FALLBACK) {
	const explicitCompatibilityVersion = firstNonEmpty(env.OPENCLAW_COMPATIBILITY_HOST_VERSION);
	if (explicitCompatibilityVersion) return explicitCompatibilityVersion;
	return resolveVersionFromRuntimeSources({
		env,
		runtimeVersion: resolveUsableRuntimeVersion(VERSION),
		fallback,
		preference: env === process.env ? "runtime-first" : "env-first"
	});
}
const VERSION = resolveBinaryVersion({
	moduleUrl: import.meta.url,
	injectedVersion: typeof __OPENCLAW_VERSION__ === "string" ? __OPENCLAW_VERSION__ : void 0,
	bundledVersion: process.env.OPENCLAW_BUNDLED_VERSION
});
//#endregion
export { resolveBinaryVersion as a, resolveUsableRuntimeVersion as c, readVersionFromPackageJsonForModuleUrl as i, resolveVersionFromModuleUrl as l, VERSION as n, resolveCompatibilityHostVersion as o, readVersionFromBuildInfoForModuleUrl as r, resolveRuntimeServiceVersion as s, RUNTIME_SERVICE_VERSION_FALLBACK as t };
