import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";

type SkillsChangeEvent = {
  workspaceDir?: string;
  reason: "watch" | "manual" | "remote-node";
  changedPath?: string;
};

type SkillsWatchState = {
  watcher: FSWatcher;
  pathsKey: string;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
};

const log = createSubsystemLogger("gateway/skills");
const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
const watchers = new Map<string, SkillsWatchState>();
let globalVersion = 0;

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Ignore common binary/data files to prevent FD exhaustion.
  // A skills directory with thousands of .wav/.bin files can exhaust
  // the process file-descriptor limit and break all exec calls.
  /\.(?:wav|mp3|mp4|avi|mov|flac|ogg|bin|pkl|pt|pth|onnx|h5|hdf5|safetensors|gguf|tar|gz|zip|7z|rar|iso|dmg|exe|dll|so|dylib|o|a|class|jar|joblib|npy|npz|parquet|arrow|feather|tfrecord)$/i,
];

/**
 * Resolves the watch ignored patterns by merging user-provided patterns with defaults.
 * User patterns are provided as regex strings and converted to RegExp objects.
 */
export function resolveWatchIgnoredPatterns(customPatterns?: string[]): RegExp[] {
  const combined = [...DEFAULT_SKILLS_WATCH_IGNORED];
  if (!customPatterns || customPatterns.length === 0) {
    return combined;
  }
  for (const pattern of customPatterns) {
    if (typeof pattern !== "string") {
      continue;
    }
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }
    try {
      // Try to parse as RegExp (pattern might be like "/pattern/flags")
      const regexMatch = trimmed.match(/^\/(.*)\/([gimsuy]*)$/);
      if (regexMatch) {
        combined.push(new RegExp(regexMatch[1], regexMatch[2]));
      } else {
        // Treat as a plain regex pattern string
        combined.push(new RegExp(trimmed));
      }
    } catch (err) {
      log.warn(`Invalid watchIgnoredPattern "${trimmed}": ${String(err)}`);
    }
  }
  return combined;
}

function bumpVersion(current: number): number {
  const now = Date.now();
  return now <= current ? current + 1 : now;
}

function emit(event: SkillsChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`skills change listener failed: ${String(err)}`);
    }
  }
}

function resolveWatchPaths(workspaceDir: string, config?: OpenClawConfig): string[] {
  const paths: string[] = [];
  if (workspaceDir.trim()) {
    paths.push(path.join(workspaceDir, "skills"));
  }
  paths.push(path.join(CONFIG_DIR, "skills"));
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  paths.push(...extraDirs);
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  paths.push(...pluginSkillDirs);
  return paths;
}

export function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
}): number {
  const reason = params?.reason ?? "manual";
  const changedPath = params?.changedPath;
  if (params?.workspaceDir) {
    const current = workspaceVersions.get(params.workspaceDir) ?? 0;
    const next = bumpVersion(current);
    workspaceVersions.set(params.workspaceDir, next);
    emit({ workspaceDir: params.workspaceDir, reason, changedPath });
    return next;
  }
  globalVersion = bumpVersion(globalVersion);
  emit({ reason, changedPath });
  return globalVersion;
}

export function getSkillsSnapshotVersion(workspaceDir?: string): number {
  if (!workspaceDir) {
    return globalVersion;
  }
  const local = workspaceVersions.get(workspaceDir) ?? 0;
  return Math.max(globalVersion, local);
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

  const watchPaths = resolveWatchPaths(workspaceDir, params.config);
  const pathsKey = watchPaths.join("|");
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

  const customIgnoredPatterns = params.config?.skills?.load?.watchIgnoredPatterns;
  const ignoredPatterns = resolveWatchIgnoredPatterns(customIgnoredPatterns);

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    // Avoid FD exhaustion on macOS when a workspace contains huge trees.
    // This watcher only needs to react to skill changes.
    ignored: ignoredPatterns,
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

  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${workspaceDir}): ${String(err)}`);
  });

  watchers.set(workspaceDir, state);
}
