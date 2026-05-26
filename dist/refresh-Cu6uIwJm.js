import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { p as resolveUserPath, t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as resolvePluginSkillDirs } from "./plugin-skills-D8eZ0xBY.js";
import { a as setSkillsChangeListenerErrorHandler, i as resetSkillsRefreshStateForTest, t as bumpSkillsSnapshotVersion } from "./refresh-state-PCEDjmSb.js";
import path from "node:path";
import os from "node:os";
import chokidar from "chokidar";
//#region src/agents/skills/refresh.ts
const log = createSubsystemLogger("gateway/skills");
const pathWatchers = /* @__PURE__ */ new Map();
const workspaceWatchTargets = /* @__PURE__ */ new Map();
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
function resolveWatchDebounceMs(config) {
	const raw = config?.skills?.load?.watchDebounceMs;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 250;
}
function sameWatchTargets(a, b) {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}
function createSkillsPathWatcher(watchPath, debounceMs) {
	const watcher = chokidar.watch(watchPath, {
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
		debounceMs,
		subscribers: /* @__PURE__ */ new Set()
	};
	const schedule = (changedPath) => {
		state.pendingPath = changedPath ?? state.pendingPath;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			const pendingPath = state.pendingPath;
			state.pendingPath = void 0;
			state.timer = void 0;
			for (const workspaceDir of state.subscribers) bumpSkillsSnapshotVersion({
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
		log.warn(`skills watcher error (${watchPath}): ${String(err)}`);
	});
	return state;
}
function teardownSkillsPathWatcher(state) {
	if (state.timer) clearTimeout(state.timer);
	state.watcher.close().catch(() => {});
}
function subscribeWorkspaceToPath(workspaceDir, watchPath, debounceMs) {
	const existing = pathWatchers.get(watchPath);
	if (existing && existing.debounceMs === debounceMs) {
		existing.subscribers.add(workspaceDir);
		return;
	}
	if (existing) {
		const next = createSkillsPathWatcher(watchPath, debounceMs);
		for (const subscriber of existing.subscribers) next.subscribers.add(subscriber);
		next.subscribers.add(workspaceDir);
		teardownSkillsPathWatcher(existing);
		pathWatchers.set(watchPath, next);
		return;
	}
	const state = createSkillsPathWatcher(watchPath, debounceMs);
	state.subscribers.add(workspaceDir);
	pathWatchers.set(watchPath, state);
}
function unsubscribeWorkspaceFromPath(workspaceDir, watchPath) {
	const state = pathWatchers.get(watchPath);
	if (!state) return;
	state.subscribers.delete(workspaceDir);
	if (state.subscribers.size === 0) {
		teardownSkillsPathWatcher(state);
		pathWatchers.delete(watchPath);
	}
}
function ensureSkillsWatcher(params) {
	const workspaceDir = params.workspaceDir.trim();
	if (!workspaceDir) return;
	const watchEnabled = params.config?.skills?.load?.watch !== false;
	const debounceMs = resolveWatchDebounceMs(params.config);
	const previousTargets = workspaceWatchTargets.get(workspaceDir) ?? [];
	if (!watchEnabled) {
		if (previousTargets.length > 0) {
			for (const watchPath of previousTargets) unsubscribeWorkspaceFromPath(workspaceDir, watchPath);
			workspaceWatchTargets.delete(workspaceDir);
		}
		return;
	}
	const watchTargets = resolveWatchTargets(workspaceDir, params.config);
	const targetsUnchanged = sameWatchTargets(previousTargets, watchTargets);
	const debounceUnchanged = watchTargets.every((watchPath) => pathWatchers.get(watchPath)?.debounceMs === debounceMs);
	if (targetsUnchanged && debounceUnchanged) return;
	const watchTargetsChanged = previousTargets.length > 0 && !targetsUnchanged;
	const nextTargets = new Set(watchTargets);
	for (const watchPath of previousTargets) if (!nextTargets.has(watchPath)) unsubscribeWorkspaceFromPath(workspaceDir, watchPath);
	for (const watchPath of watchTargets) subscribeWorkspaceToPath(workspaceDir, watchPath, debounceMs);
	workspaceWatchTargets.set(workspaceDir, watchTargets);
	if (watchTargetsChanged) bumpSkillsSnapshotVersion({
		workspaceDir,
		reason: "watch-targets",
		changedPath: watchTargets.join("|")
	});
}
async function resetSkillsRefreshForTest() {
	resetSkillsRefreshStateForTest();
	const active = Array.from(pathWatchers.values());
	pathWatchers.clear();
	workspaceWatchTargets.clear();
	await Promise.all(active.map(async (state) => {
		if (state.timer) clearTimeout(state.timer);
		try {
			await state.watcher.close();
		} catch {}
	}));
}
//#endregion
export { shouldIgnoreSkillsWatchPath as i, ensureSkillsWatcher as n, resetSkillsRefreshForTest as r, DEFAULT_SKILLS_WATCH_IGNORED as t };
