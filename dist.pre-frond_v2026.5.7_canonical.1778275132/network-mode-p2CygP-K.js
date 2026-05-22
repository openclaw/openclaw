import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as resolvePathViaExistingAncestorSync } from "./boundary-path-DbcMiy8Y.js";
import { posix } from "node:path";
//#region src/agents/sandbox/bind-spec.ts
function splitSandboxBindSpec(spec) {
	const separator = getHostContainerSeparatorIndex(spec);
	if (separator === -1) return null;
	const host = spec.slice(0, separator);
	const rest = spec.slice(separator + 1);
	const optionsStart = rest.indexOf(":");
	if (optionsStart === -1) return {
		host,
		container: rest,
		options: ""
	};
	return {
		host,
		container: rest.slice(0, optionsStart),
		options: rest.slice(optionsStart + 1)
	};
}
function getHostContainerSeparatorIndex(spec) {
	const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(spec);
	for (let i = hasDriveLetterPrefix ? 2 : 0; i < spec.length; i += 1) if (spec[i] === ":") return i;
	return -1;
}
//#endregion
//#region src/agents/sandbox/host-paths.ts
function stripWindowsNamespacePrefix(input) {
	if (input.startsWith("\\\\?\\")) {
		const withoutPrefix = input.slice(4);
		if (withoutPrefix.toUpperCase().startsWith("UNC\\")) return `\\\\${withoutPrefix.slice(4)}`;
		return withoutPrefix;
	}
	if (input.startsWith("//?/")) {
		const withoutPrefix = input.slice(4);
		if (withoutPrefix.toUpperCase().startsWith("UNC/")) return `//${withoutPrefix.slice(4)}`;
		return withoutPrefix;
	}
	return input;
}
function isWindowsDriveAbsolutePath(raw) {
	return /^[A-Za-z]:[\\/]/.test(stripWindowsNamespacePrefix(raw.trim()));
}
function isSandboxHostPathAbsolute(raw) {
	const trimmed = stripWindowsNamespacePrefix(raw.trim());
	return trimmed.startsWith("/") || isWindowsDriveAbsolutePath(trimmed);
}
/**
* Normalize a host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
* Windows drive-letter paths preserve the drive root and uppercase the drive letter.
*/
function normalizeSandboxHostPath(raw) {
	const trimmed = stripWindowsNamespacePrefix(raw.trim());
	if (!trimmed) return "/";
	let normalTrimmed = trimmed.replaceAll("\\", "/");
	if (isWindowsDriveAbsolutePath(normalTrimmed)) normalTrimmed = normalTrimmed.charAt(0).toUpperCase() + normalTrimmed.slice(1);
	const withoutTrailingSlash = posix.normalize(normalTrimmed).replace(/\/+$/, "") || "/";
	if (/^[A-Z]:$/.test(withoutTrailingSlash)) return `${withoutTrailingSlash}/`;
	return withoutTrailingSlash;
}
function getSandboxHostPathPolicyKey(raw) {
	const normalized = normalizeSandboxHostPath(raw);
	if (isWindowsDriveAbsolutePath(normalized)) return normalized.toLowerCase();
	return normalized;
}
/**
* Resolve a path through the deepest existing ancestor so parent symlinks are honored
* even when the final source leaf does not exist yet.
*/
function resolveSandboxHostPathViaExistingAncestor(sourcePath) {
	if (!isSandboxHostPathAbsolute(sourcePath)) return sourcePath;
	if (isWindowsDriveAbsolutePath(sourcePath) && process.platform !== "win32") return normalizeSandboxHostPath(sourcePath);
	return normalizeSandboxHostPath(resolvePathViaExistingAncestorSync(sourcePath));
}
//#endregion
//#region src/agents/sandbox/network-mode.ts
function normalizeNetworkMode(network) {
	return normalizeOptionalLowercaseString(network) || void 0;
}
function getBlockedNetworkModeReason(params) {
	const normalized = normalizeNetworkMode(params.network);
	if (!normalized) return null;
	if (normalized === "host") return "host";
	if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) return "container_namespace_join";
	return null;
}
function isDangerousNetworkMode(network) {
	const normalized = normalizeNetworkMode(network);
	return normalized === "host" || normalized?.startsWith("container:") === true;
}
//#endregion
export { isSandboxHostPathAbsolute as a, splitSandboxBindSpec as c, getSandboxHostPathPolicyKey as i, isDangerousNetworkMode as n, normalizeSandboxHostPath as o, normalizeNetworkMode as r, resolveSandboxHostPathViaExistingAncestor as s, getBlockedNetworkModeReason as t };
