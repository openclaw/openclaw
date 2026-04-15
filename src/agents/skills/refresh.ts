import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import {
  type SkillsChangeEvent,
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
  shouldRefreshSnapshotForVersion,
} from "./refresh-state.js";
export {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  shouldRefreshSnapshotForVersion,
  type SkillsChangeEvent,
} from "./refresh-state.js";

type SkillsWatchState = {
  watcher: FSWatcher;
  pathsKey: string;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
};

const log = createSubsystemLogger("gateway/skills");
const watchers = new Map<string, SkillsWatchState>();

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

function resolveWatchPaths(workspaceDir: string, config?: OpenClawConfig): string[] {
  const paths: string[] = [];
  if (workspaceDir.trim()) {
    paths.push(path.join(workspaceDir, "skills"));
    paths.push(path.join(workspaceDir, ".agents", "skills"));
  }
  paths.push(path.join(CONFIG_DIR, "skills"));
  paths.push(path.join(os.homedir(), ".agents", "skills"));
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  paths.push(...extraDirs);
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  paths.push(...pluginSkillDirs);
  return paths;
}

/** Max directory depth under each skill root (see chokidar `depth`). 2 covers `SKILL.md` and `<skill>/SKILL.md`. */
const SKILLS_WATCH_TREE_DEPTH = 2;

function resolveSkillWatchRootDirs(workspaceDir: string, config?: OpenClawConfig): string[] {
  const seen = new Set<string>();
  for (const raw of resolveWatchPaths(workspaceDir, config)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    seen.add(path.resolve(trimmed));
  }
  return Array.from(seen).toSorted();
}

export function shouldTriggerSkillsRefresh(params: {
  event: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
  eventPath: string;
  roots: string[];
}): boolean {
  const eventPath = path.resolve(params.eventPath);
  for (const root of params.roots) {
    const rootResolved = path.resolve(root);
    if (params.event === "unlinkDir" && eventPath === rootResolved) {
      return true;
    }
    if (eventPath === rootResolved) {
      continue;
    }
    const rel = path.relative(rootResolved, eventPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    const segments = rel.split(path.sep).filter(Boolean);

    if (params.event === "unlinkDir") {
      // Entire skill directory removed (macOS glob watches miss this; directory watch does not).
      if (path.resolve(path.dirname(eventPath)) === rootResolved) {
        return true;
      }
      continue;
    }

    if (params.event === "addDir") {
      continue;
    }

    if (path.basename(eventPath) !== "SKILL.md") {
      continue;
    }
    // `<root>/SKILL.md` or `<root>/<skill>/SKILL.md`
    if (segments.length === 1 && segments[0] === "SKILL.md") {
      return true;
    }
    if (segments.length === 2 && segments[1] === "SKILL.md") {
      return true;
    }
  }
  return false;
}

export function ensureSkillsWatcher(params: { workspaceDir: string; config?: OpenClawConfig }) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const debounceMsRaw = params.config?.skills?.load?.watchDebounceMs;
  const debounceMs =
    typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw)
      ? Math.max(0, debounceMsRaw)
      : 250;

  const existing = watchers.get(workspaceDir);
  if (!watchEnabled) {
    if (existing) {
      watchers.delete(workspaceDir);
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      void existing.watcher.close().catch(() => {});
    }
    return;
  }

  const watchRoots = resolveSkillWatchRootDirs(workspaceDir, params.config);
  const pathsKey = watchRoots.join("|");
  if (existing && existing.pathsKey === pathsKey && existing.debounceMs === debounceMs) {
    return;
  }
  if (existing) {
    watchers.delete(workspaceDir);
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    void existing.watcher.close().catch(() => {});
  }

  const watcher = chokidar.watch(watchRoots, {
    ignoreInitial: true,
    depth: SKILLS_WATCH_TREE_DEPTH,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    // Watch each skill root shallowly (depth) and filter in code. Glob patterns
    // like `<root>/*/SKILL.md` miss `unlinkDir` when a skill folder is deleted on macOS.
    ignored: DEFAULT_SKILLS_WATCH_IGNORED,
  });

  const state: SkillsWatchState = { watcher, pathsKey, debounceMs };

  const schedule = (changedPath?: string) => {
    state.pendingPath = changedPath ?? state.pendingPath;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      state.pendingPath = undefined;
      state.timer = undefined;
      bumpSkillsSnapshotVersion({
        workspaceDir,
        reason: "watch",
        changedPath: pendingPath,
      });
    }, debounceMs);
  };

  const onFsEvent = (event: "add" | "addDir" | "change" | "unlink" | "unlinkDir", p: string) => {
    if (!shouldTriggerSkillsRefresh({ event, eventPath: p, roots: watchRoots })) {
      return;
    }
    schedule(p);
  };

  watcher.on("add", (p) => onFsEvent("add", p));
  watcher.on("addDir", (p) => onFsEvent("addDir", p));
  watcher.on("change", (p) => onFsEvent("change", p));
  watcher.on("unlink", (p) => onFsEvent("unlink", p));
  watcher.on("unlinkDir", (p) => onFsEvent("unlinkDir", p));
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${workspaceDir}): ${String(err)}`);
  });

  watchers.set(workspaceDir, state);
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  resetSkillsRefreshStateForTest();

  const active = Array.from(watchers.values());
  watchers.clear();
  await Promise.all(
    active.map(async (state) => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      try {
        await state.watcher.close();
      } catch {
        // Best-effort test cleanup.
      }
    }),
  );
}
