import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTruthyEnvValue, logAcceptedEnvOption } from "../../infra/env.js";
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
  usePolling: boolean;
  interval?: number;
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

const SKILLS_WATCH_POLLING_ENV = "OPENCLAW_SKILLS_WATCH_POLLING";
const SKILLS_WATCH_POLL_INTERVAL_ENV = "OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS";

function resolveSkillsWatchPollingEnabled(): boolean {
  const enabled = isTruthyEnvValue(process.env[SKILLS_WATCH_POLLING_ENV]);
  if (enabled) {
    logAcceptedEnvOption({
      key: SKILLS_WATCH_POLLING_ENV,
      description: "enable chokidar polling fallback for the skills watcher",
    });
  }
  return enabled;
}

function resolveSkillsWatchPollIntervalMs(): number | undefined {
  const raw = process.env[SKILLS_WATCH_POLL_INTERVAL_ENV];
  if (!raw?.trim()) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const interval = Math.floor(value);
  if (interval < 1) {
    return undefined;
  }
  logAcceptedEnvOption({
    key: SKILLS_WATCH_POLL_INTERVAL_ENV,
    description: "set the chokidar polling interval for the skills watcher in milliseconds",
  });
  return interval;
}

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

function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "") || normalized;
}

function resolveWatchTargets(workspaceDir: string, config?: OpenClawConfig): string[] {
  const targets = new Set<string>();
  for (const root of resolveWatchPaths(workspaceDir, config)) {
    targets.add(toWatchRoot(root));
  }
  return Array.from(targets).toSorted();
}

export function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const normalized = watchPath.replaceAll("\\", "/");
  return path.posix.basename(normalized) !== "SKILL.md";
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

  const watchTargets = resolveWatchTargets(workspaceDir, params.config);
  const pathsKey = watchTargets.join("|");
  const usePolling = resolveSkillsWatchPollingEnabled();
  const interval = usePolling ? resolveSkillsWatchPollIntervalMs() : undefined;
  if (
    existing &&
    existing.pathsKey === pathsKey &&
    existing.debounceMs === debounceMs &&
    existing.usePolling === usePolling &&
    existing.interval === interval
  ) {
    return;
  }
  if (existing) {
    watchers.delete(workspaceDir);
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    void existing.watcher.close().catch(() => {});
  }

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    usePolling,
    ...(typeof interval === "number" ? { interval } : {}),
    ignored: shouldIgnoreSkillsWatchPath,
  });

  const state: SkillsWatchState = { watcher, pathsKey, debounceMs, usePolling, interval };

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

  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("unlinkDir", (p) => schedule(p));
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
