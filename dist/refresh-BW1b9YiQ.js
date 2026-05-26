import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { p as resolveUserPath, t as CONFIG_DIR } from "./utils-CKsuXgDI.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { t as resolvePluginSkillDirs } from "./plugin-skills-mwungOcN.js";
import { a as setSkillsChangeListenerErrorHandler, i as resetSkillsRefreshStateForTest, t as bumpSkillsSnapshotVersion } from "./refresh-state-CJpHWFGC.js";
import path from "node:path";
import os from "node:os";
import chokidar from "chokidar";
//#region src/agents/skills/refresh.ts
const log = createSubsystemLogger("gateway/skills");
const watchers = /* @__PURE__ */ new Map();
setSkillsChangeListenerErrorHandler((err) => {
	log.warn(`skills change listener failed: ${String(err)}`);
});
const DEFAULT_SKILLS_WATCH_IGNORED = [
	/(^|[\\/])\.git([\\/]|$)/,
	/(^|[\\/])node_modules([\\/]|$)/,
	/(^|[\\/])dist([\\/]|$)/,
	/(^|[\\/])\.venv([\\/]|$)/,
	/(^|[\\/])venv([\\/]|$)/,
	/(^|[\\/])__pycache__([\\/]|$)/,
	/(^|[\\/])\.mypy_cache([\\/]|$)/,
	/(^|[\\/])\.pytest_cache([\\/]|$)/,
	/(^|[\\/])build([\\/]|$)/,
	/(^|[\\/])\.cache([\\/]|$)/
];
function resolveWatchPaths(workspaceDir, config) {
	const paths = [];
	if (workspaceDir.trim()) {
		paths.push(path.join(workspaceDir, "skills"));
		paths.push(path.join(workspaceDir, ".agents", "skills"));
	}
	paths.push(path.join(CONFIG_DIR, "skills"));
	paths.push(path.join(os.homedir(), ".agents", "skills"));
	const extraDirs = (config?.skills?.load?.extraDirs ?? []).map((d) => normalizeOptionalString(d) ?? "").filter(Boolean).map((dir) => resolveUserPath(dir));
	paths.push(...extraDirs);
	const pluginSkillDirs = resolvePluginSkillDirs({
		workspaceDir,
		config
	});
	paths.push(...pluginSkillDirs);
	return paths;
}
function toWatchRoot(raw) {
	const normalized = raw.replaceAll("\\", "/");
	return normalized.replace(/\/+$/, "") || normalized;
}
function resolveWatchTargets(workspaceDir, config) {
	const targets = /* @__PURE__ */ new Set();
	for (const root of resolveWatchPaths(workspaceDir, config)) targets.add(toWatchRoot(root));
	return Array.from(targets).toSorted();
}
function shouldIgnoreSkillsWatchPath(watchPath, stats) {
	if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) return true;
	if (stats?.isDirectory?.()) return false;
	if (!stats) return false;
	const normalized = watchPath.replaceAll("\\", "/");
	return path.posix.basename(normalized) !== "SKILL.md";
}
function ensureSkillsWatcher(params) {
	const workspaceDir = params.workspaceDir.trim();
	if (!workspaceDir) return;
	const watchEnabled = params.config?.skills?.load?.watch !== false;
	const debounceMsRaw = params.config?.skills?.load?.watchDebounceMs;
	const debounceMs = typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw) ? Math.max(0, debounceMsRaw) : 250;
	const existing = watchers.get(workspaceDir);
	if (!watchEnabled) {
		if (existing) {
			watchers.delete(workspaceDir);
			if (existing.timer) clearTimeout(existing.timer);
			existing.watcher.close().catch(() => {});
		}
		return;
	}
	const watchTargets = resolveWatchTargets(workspaceDir, params.config);
	const pathsKey = watchTargets.join("|");
	if (existing && existing.pathsKey === pathsKey && existing.debounceMs === debounceMs) return;
	if (existing) {
		watchers.delete(workspaceDir);
		if (existing.timer) clearTimeout(existing.timer);
		existing.watcher.close().catch(() => {});
	}
	const watcher = chokidar.watch(watchTargets, {
		ignoreInitial: true,
		depth: 2,
		awaitWriteFinish: {
			stabilityThreshold: debounceMs,
			pollInterval: 100
		},
		ignored: shouldIgnoreSkillsWatchPath
	});
	const state = {
		watcher,
		pathsKey,
		debounceMs
	};
	const schedule = (changedPath) => {
		state.pendingPath = changedPath ?? state.pendingPath;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			const pendingPath = state.pendingPath;
			state.pendingPath = void 0;
			state.timer = void 0;
			bumpSkillsSnapshotVersion({
				workspaceDir,
				reason: "watch",
				changedPath: pendingPath
			});
		}, debounceMs);
	};
	watcher.on("add", (p) => schedule(p));
	watcher.on("change", (p) => schedule(p));
	watcher.on("unlink", (p) => schedule(p));
	watcher.on("unlinkDir", (p) => schedule(p));
	watcher.on("error", (err) => {
		log.warn(`skills watcher error (${workspaceDir}): ${String(err)}`);
	});
	watchers.set(workspaceDir, state);
}
async function resetSkillsRefreshForTest() {
	resetSkillsRefreshStateForTest();
	const active = Array.from(watchers.values());
	watchers.clear();
	await Promise.all(active.map(async (state) => {
		if (state.timer) clearTimeout(state.timer);
		try {
			await state.watcher.close();
		} catch {}
	}));
}
//#endregion
export { shouldIgnoreSkillsWatchPath as i, ensureSkillsWatcher as n, resetSkillsRefreshForTest as r, DEFAULT_SKILLS_WATCH_IGNORED as t };
