import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { d as normalizeBundledLookupPath, u as buildBundledPluginLoadPathAliases } from "./discovery-GEDtU7uI.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as resolveBundledPluginSources } from "./bundled-sources-Bb5DSmIr.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
//#region src/commands/doctor/shared/bundled-plugin-load-paths.ts
function resolveBundledWorkspaceDir(cfg) {
	return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ?? void 0;
}
function scanBundledPluginLoadPathMigrations(cfg, env = process.env) {
	const load = asObjectRecord(asObjectRecord(cfg.plugins)?.load);
	const rawPaths = Array.isArray(load?.paths) ? load.paths : [];
	if (rawPaths.length === 0) return [];
	const bundled = resolveBundledPluginSources({
		workspaceDir: resolveBundledWorkspaceDir(cfg),
		env
	});
	if (bundled.size === 0) return [];
	const bundledPathMap = /* @__PURE__ */ new Map();
	for (const source of bundled.values()) for (const alias of buildBundledPluginLoadPathAliases(source.localPath)) bundledPathMap.set(normalizeBundledLookupPath(alias.path), {
		pluginId: source.pluginId,
		toPath: source.localPath
	});
	const hits = [];
	for (const rawPath of rawPaths) {
		if (typeof rawPath !== "string") continue;
		const normalized = normalizeBundledLookupPath(resolveUserPath(rawPath, env));
		const match = bundledPathMap.get(normalized);
		if (!match) continue;
		hits.push({
			pluginId: match.pluginId,
			fromPath: rawPath,
			toPath: match.toPath,
			pathLabel: "plugins.load.paths"
		});
	}
	return hits;
}
function collectBundledPluginLoadPathWarnings(params) {
	if (params.hits.length === 0) return [];
	const lines = params.hits.map((hit) => `- ${hit.pathLabel}: bundled plugin path "${hit.fromPath}" still aliases ${hit.pluginId}; OpenClaw loads the packaged bundled plugin from "${hit.toPath}".`);
	lines.push(`- Run "${params.doctorFixCommand}" to remove these redundant bundled plugin paths.`);
	return lines.map((line) => sanitizeForLog(line));
}
function maybeRepairBundledPluginLoadPaths(cfg, env = process.env) {
	const hits = scanBundledPluginLoadPathMigrations(cfg, env);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const paths = next.plugins?.load?.paths;
	if (!Array.isArray(paths)) return {
		config: cfg,
		changes: []
	};
	const removable = new Set(hits.map((hit) => normalizeBundledLookupPath(resolveUserPath(hit.fromPath, env))));
	const seen = /* @__PURE__ */ new Set();
	const rewritten = [];
	for (const entry of paths) {
		if (typeof entry !== "string") {
			rewritten.push(entry);
			continue;
		}
		const resolved = normalizeBundledLookupPath(resolveUserPath(entry, env));
		if (removable.has(resolved)) continue;
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		rewritten.push(entry);
	}
	next.plugins = {
		...next.plugins,
		load: {
			...next.plugins?.load,
			paths: rewritten
		}
	};
	return {
		config: next,
		changes: hits.map((hit) => `- plugins.load.paths: removed bundled ${hit.pluginId} path alias ${hit.fromPath}`)
	};
}
//#endregion
export { maybeRepairBundledPluginLoadPaths as n, scanBundledPluginLoadPathMigrations as r, collectBundledPluginLoadPathWarnings as t };
