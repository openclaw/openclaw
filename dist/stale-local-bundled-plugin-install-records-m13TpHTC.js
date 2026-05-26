import { d as normalizeBundledLookupPath } from "./discovery-GEDtU7uI.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { i as resolveBundledPluginSources } from "./bundled-sources-Bb5DSmIr.js";
import path from "node:path";
//#region src/plugins/stale-local-bundled-plugin-install-records.ts
function normalizePathForCompare(rawPath, env) {
	return path.resolve(normalizeBundledLookupPath(resolveUserPath(rawPath, env)));
}
function primaryInstallRecordPath(record) {
	if (typeof record.installPath === "string" && record.installPath.trim()) return {
		field: "installPath",
		path: record.installPath
	};
	if (typeof record.sourcePath === "string" && record.sourcePath.trim()) return {
		field: "sourcePath",
		path: record.sourcePath
	};
	return null;
}
function looksLikeCompiledBundledPluginPath(targetPath, pluginId) {
	const segments = normalizeBundledLookupPath(targetPath).split(/[\\/]+/u);
	return segments.some((segment, index) => {
		return (segment === "dist" || segment === "dist-runtime") && segments[index + 1] === "extensions" && segments[index + 2] === pluginId;
	});
}
function hasStaleBundledVersion(record, bundledSource) {
	const recordVersion = record.version?.trim();
	const bundledVersion = bundledSource.version?.trim();
	return Boolean(recordVersion && bundledVersion && recordVersion !== bundledVersion);
}
function listStaleLocalBundledPluginInstallRecords(params) {
	const bundled = params.bundled ?? resolveBundledPluginSources({
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const stale = [];
	for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (record.source !== "path") continue;
		const bundledSource = bundled.get(pluginId);
		if (!bundledSource?.localPath) continue;
		if (!hasStaleBundledVersion(record, bundledSource)) continue;
		const recordPath = primaryInstallRecordPath(record);
		if (!recordPath) continue;
		const stalePath = normalizePathForCompare(recordPath.path, params.env);
		const bundledPath = normalizePathForCompare(bundledSource.localPath, params.env);
		if (stalePath === bundledPath) continue;
		if (!looksLikeCompiledBundledPluginPath(stalePath, pluginId)) continue;
		stale.push({
			pluginId,
			record,
			recordPathField: recordPath.field,
			stalePath,
			bundledPath
		});
	}
	return stale;
}
function pruneStaleLocalBundledPluginInstallRecords(params) {
	const stale = listStaleLocalBundledPluginInstallRecords(params);
	if (stale.length === 0) return {
		records: params.installRecords,
		stale
	};
	const staleIds = new Set(stale.map((record) => record.pluginId));
	return {
		records: Object.fromEntries(Object.entries(params.installRecords).filter(([pluginId]) => !staleIds.has(pluginId))),
		stale
	};
}
//#endregion
export { pruneStaleLocalBundledPluginInstallRecords as n, listStaleLocalBundledPluginInstallRecords as t };
