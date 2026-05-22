import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { C as safeFileURLToPath } from "./fs-safe-Cwlcdma7.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-DG9b7Tlg.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-BUbm4C3v.js";
import "./agent-scope-CcthxFej.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C5ciZZyc.js";
import "./local-file-access-BCy2Hv8O.js";
import { t as isPassThroughRemoteMediaSource } from "./media-source-url-DpDG7sad.js";
import { n as resolveEffectiveToolFsRootExpansionAllowed, r as resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy-BdOlWKjT.js";
import path from "node:path";
//#region src/media/local-roots.ts
let cachedPreferredTmpDir;
const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
function resolveCachedPreferredTmpDir() {
	if (!cachedPreferredTmpDir) cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
	return cachedPreferredTmpDir;
}
function buildMediaLocalRoots(stateDir, configDir, options = {}) {
	const resolvedStateDir = path.resolve(stateDir);
	const resolvedConfigDir = path.resolve(configDir);
	const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
	return Array.from(new Set([
		preferredTmpDir,
		path.join(resolvedConfigDir, "media"),
		path.join(resolvedStateDir, "media"),
		path.join(resolvedStateDir, "canvas"),
		path.join(resolvedStateDir, "workspace"),
		path.join(resolvedStateDir, "sandboxes")
	]));
}
function getDefaultMediaLocalRoots() {
	return buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
}
function getAgentScopedMediaLocalRoots(cfg, agentId) {
	const roots = buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
	const normalizedAgentId = normalizeOptionalString(agentId);
	if (!normalizedAgentId) return roots;
	const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
	if (!workspaceDir) return roots;
	const normalizedWorkspaceDir = path.resolve(workspaceDir);
	if (!roots.includes(normalizedWorkspaceDir)) roots.push(normalizedWorkspaceDir);
	return roots;
}
function resolveLocalMediaPath(source) {
	const trimmed = source.trim();
	if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) return;
	if (trimmed.startsWith("file://")) try {
		return safeFileURLToPath(trimmed);
	} catch {
		return;
	}
	if (trimmed.startsWith("~")) return resolveUserPath(trimmed);
	if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) return path.resolve(trimmed);
}
function appendLocalMediaParentRoots(roots, mediaSources) {
	const appended = Array.from(new Set(roots.map((root) => path.resolve(root))));
	for (const source of mediaSources ?? []) {
		const localPath = resolveLocalMediaPath(source);
		if (!localPath) continue;
		const parentDir = path.dirname(localPath);
		if (parentDir === path.parse(parentDir).root) continue;
		const normalizedParent = path.resolve(parentDir);
		if (!appended.includes(normalizedParent)) appended.push(normalizedParent);
	}
	return appended;
}
function getAgentScopedMediaLocalRootsForSources(params) {
	const roots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
	if (resolveEffectiveToolFsWorkspaceOnly({
		cfg: params.cfg,
		agentId: params.agentId
	})) return roots;
	if (!resolveEffectiveToolFsRootExpansionAllowed({
		cfg: params.cfg,
		agentId: params.agentId
	})) return roots;
	return appendLocalMediaParentRoots(roots, params.mediaSources);
}
//#endregion
export { getDefaultMediaLocalRoots as a, getAgentScopedMediaLocalRootsForSources as i, buildMediaLocalRoots as n, getAgentScopedMediaLocalRoots as r, appendLocalMediaParentRoots as t };
