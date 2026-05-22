import { d as resolveConfigDir, p as resolveUserPath } from "./utils-D5swhEXt.js";
import { a as safePathSegmentHashed, i as safeDirName, o as unscopedPackageName, r as resolveSafeInstallDir } from "./install-safe-path-CFEnKpw5.js";
import path from "node:path";
//#region src/plugins/install-paths.ts
function safePluginInstallFileName(input) {
	return safeDirName(input);
}
function encodePluginInstallDirName(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed.includes("/")) return safeDirName(trimmed);
	return `@${safePathSegmentHashed(trimmed)}`;
}
function validatePluginId(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed) return "invalid plugin name: missing";
	if (trimmed.includes("\\")) return "invalid plugin name: path separators not allowed";
	const segments = trimmed.split("/");
	if (segments.some((segment) => !segment)) return "invalid plugin name: malformed scope";
	if (segments.some((segment) => segment === "." || segment === "..")) return "invalid plugin name: reserved path segment";
	if (segments.length === 1) {
		if (trimmed.startsWith("@")) return "invalid plugin name: scoped ids must use @scope/name format";
		return null;
	}
	if (segments.length !== 2) return "invalid plugin name: path separators not allowed";
	if (!segments[0]?.startsWith("@") || segments[0].length < 2) return "invalid plugin name: scoped ids must use @scope/name format";
	return null;
}
function matchesExpectedPluginId(params) {
	if (!params.expectedPluginId) return true;
	if (params.expectedPluginId === params.pluginId) return true;
	return !params.manifestPluginId && params.pluginId === params.npmPluginId && params.expectedPluginId === unscopedPackageName(params.npmPluginId);
}
function resolveDefaultPluginExtensionsDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "extensions");
}
function resolveDefaultPluginNpmDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "npm");
}
function resolveDefaultPluginGitDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "git");
}
function resolvePluginInstallDir(pluginId, extensionsDir) {
	const extensionsBase = extensionsDir ? resolveUserPath(extensionsDir) : resolveDefaultPluginExtensionsDir();
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) throw new Error(pluginIdError);
	const targetDirResult = resolveSafeInstallDir({
		baseDir: extensionsBase,
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected",
		nameEncoder: encodePluginInstallDirName
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
}
//#endregion
export { resolveDefaultPluginNpmDir as a, validatePluginId as c, resolveDefaultPluginGitDir as i, matchesExpectedPluginId as n, resolvePluginInstallDir as o, resolveDefaultPluginExtensionsDir as r, safePluginInstallFileName as s, encodePluginInstallDirName as t };
