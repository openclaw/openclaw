import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { t as note } from "./note-Dg2Luaaq.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor/shared/plugin-runtime-symlinks.ts
const PLUGIN_RUNTIME_DEPS_MARKER = "plugin-runtime-deps";
const MAX_REPORTED = 6;
const DEFAULT_FS = {
	readdir: (dir, options) => fs.readdir(dir, options),
	lstat: (file) => fs.lstat(file),
	readlink: (file) => fs.readlink(file),
	stat: (file) => fs.stat(file),
	rm: (file, options) => fs.rm(file, options),
	unlink: (file) => fs.unlink(file)
};
async function collectStalePluginRuntimeSymlinks(packageRoot, options = {}) {
	if (!packageRoot) return [];
	const containingNodeModules = path.dirname(packageRoot);
	if (path.basename(containingNodeModules) !== "node_modules") return [];
	const fsApi = options.fs ?? DEFAULT_FS;
	const staleRoots = uniqueResolvedRoots(options.staleRoots ?? []);
	const stale = [];
	const entries = await fsApi.readdir(containingNodeModules, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith("@")) {
			const scopeDir = path.join(containingNodeModules, entry.name);
			const scopeEntries = await fsApi.readdir(scopeDir, { withFileTypes: true }).catch(() => []);
			for (const scopeEntry of scopeEntries) {
				const fullPath = path.join(scopeDir, scopeEntry.name);
				const target = await inspectCandidate(fullPath, fsApi, staleRoots);
				if (target) stale.push({
					name: `${entry.name}/${scopeEntry.name}`,
					path: fullPath,
					target
				});
			}
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		const fullPath = path.join(containingNodeModules, entry.name);
		const target = await inspectCandidate(fullPath, fsApi, staleRoots);
		if (target) stale.push({
			name: entry.name,
			path: fullPath,
			target
		});
	}
	return stale.toSorted((left, right) => left.name.localeCompare(right.name));
}
async function noteStalePluginRuntimeSymlinks(packageRoot, options = {}) {
	const stale = await collectStalePluginRuntimeSymlinks(packageRoot, options);
	if (stale.length === 0) return;
	const shortenPath = options.shortenPath ?? shortenHomePath;
	const lines = [
		"- Plugin-runtime symlinks under the global Node prefix point at pruned",
		`  ${PLUGIN_RUNTIME_DEPS_MARKER} directories from a previous OpenClaw install.`,
		"- Bundled plugin ESM imports can fail with ERR_MODULE_NOT_FOUND until repaired."
	];
	for (const item of stale.slice(0, MAX_REPORTED)) lines.push(`  - ${item.name} -> ${shortenPath(item.target)}`);
	if (stale.length > MAX_REPORTED) lines.push(`  - ...and ${stale.length - MAX_REPORTED} more`);
	lines.push("- Repair: run `openclaw doctor --fix` to remove the dangling symlinks.");
	(options.noteFn ?? note)(lines.join("\n"), "Plugin-runtime symlinks");
}
async function removeStalePluginRuntimeSymlinks(packageRoot, options = {}) {
	const fsApi = options.fs ?? DEFAULT_FS;
	const changes = [];
	const warnings = [];
	for (const item of await collectStalePluginRuntimeSymlinks(packageRoot, options)) try {
		if (fsApi.unlink) await fsApi.unlink(item.path);
		else await fsApi.rm(item.path, { force: true });
		changes.push(`Removed stale plugin-runtime symlink: ${item.path}`);
	} catch (error) {
		warnings.push(`Failed to remove stale plugin-runtime symlink ${item.path}: ${String(error)}`);
	}
	return {
		changes,
		warnings
	};
}
function uniqueResolvedRoots(values) {
	return [...new Set(values.map((value) => path.resolve(value)))].toSorted((left, right) => left.localeCompare(right));
}
function isPathInsideRoot(candidate, root) {
	const relativePath = path.relative(root, candidate);
	return relativePath === "" || !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
async function inspectCandidate(fullPath, fsApi, staleRoots) {
	if (!(await fsApi.lstat(fullPath).catch(() => null))?.isSymbolicLink()) return null;
	const target = await fsApi.readlink(fullPath).catch(() => null);
	if (!target || !target.includes(PLUGIN_RUNTIME_DEPS_MARKER)) return null;
	const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(fullPath), target);
	if (staleRoots.some((root) => isPathInsideRoot(resolvedTarget, root))) return resolvedTarget;
	try {
		await fsApi.stat(resolvedTarget);
		return null;
	} catch (error) {
		const code = error?.code;
		return code === "ENOENT" || code === "ENOTDIR" ? resolvedTarget : null;
	}
}
//#endregion
export { noteStalePluginRuntimeSymlinks as n, removeStalePluginRuntimeSymlinks as r, collectStalePluginRuntimeSymlinks as t };
