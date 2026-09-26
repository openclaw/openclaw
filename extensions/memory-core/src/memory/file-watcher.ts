import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  isFileMissingError,
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
  type MemoryWorkspaceWatchRequest,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type LinuxMemoryDirectoryWatcher,
  MemoryFileWatchResources,
  type MemoryFileWatchCallbacks,
  type NativeMemoryWatchPair,
} from "./manager-watch-resources.js";
import { countChokidarWatchedEntries } from "./watch-pressure.js";
import type { MemoryWatchEventStats } from "./watch-settle.js";

const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);
const log = createSubsystemLogger("memory");

type NativeMemoryWatchResult = "attached" | "missing" | "failed";

function shouldIgnoreMemoryWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
  multimodalSettings?: ResolvedMemorySearchConfig["multimodal"],
): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  if (parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
  if (extension.length === 0 || extension === ".md") {
    return false;
  }
  if (!multimodalSettings) {
    return true;
  }
  return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}

export type MemoryFileWatcherOptions = MemoryFileWatchCallbacks & {
  workspaceDir: string;
  agentId: string;
  settings: MemoryWorkspaceWatchRequest["settings"];
};

/** Native Memory file coverage and settling, independent of index or provider state. */
export class MemoryFileWatcher extends MemoryFileWatchResources {
  private readonly workspaceDir: string;
  private readonly settings: MemoryFileWatcherOptions["settings"];
  private nextWatchGeneration = 0;

  constructor(options: MemoryFileWatcherOptions) {
    super(options.agentId, options.settings, options);
    this.workspaceDir = options.workspaceDir;
    this.settings = options.settings;
  }

  protected async startWatching(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (
      this.memoryWatchCapacityDegraded ||
      this.watcher ||
      this.nativeMemoryWatchPairs.length > 0
    ) {
      return;
    }
    // Core paths preserve original symlink-follow behavior (chokidar/fs.watch
    // resolve through symlinks by default); extraPaths preserves the original
    // explicit symlink-skip policy.
    const fileWatchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "USER.md"),
    ]);
    const memoryDir = path.join(this.workspaceDir, "memory");
    const dirWatchPaths = new Set<string>([memoryDir]);
    const additionalPaths = normalizeExtraMemoryPathEntries(
      this.workspaceDir,
      this.settings.extraPaths,
    );
    for (const entry of additionalPaths) {
      try {
        const stat = await fs.lstat(entry.path);
        if (this.closed) {
          return;
        }
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          dirWatchPaths.add(entry.path);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry.path).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry.path, this.settings.multimodal) !== null)
        ) {
          fileWatchPaths.add(entry.path);
        }
      } catch {
        continue;
      }
    }
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      if (this.closed) {
        return;
      }
      if (watchPath && stats && !stats.isDirectory?.()) {
        const normalizedWatchPath = path.resolve(watchPath);
        const matchingEntries = isPathInside(memoryDir, normalizedWatchPath)
          ? []
          : additionalPaths.filter((entry) => isPathInside(entry.path, normalizedWatchPath));
        if (
          matchingEntries.length > 0 &&
          !matchingEntries.some((entry) => matchesExtraMemoryPathEntry(entry, normalizedWatchPath))
        ) {
          return;
        }
      }
      this.markMemoryWatchDirty(watchPath, stats);
    };
    // Native recursive fs.watch for directory paths — one watcher per
    // directory on macOS (FSEvents) and Windows (ReadDirectoryChangesW).
    // Avoids chokidar's per-file fs.watch fan-out on large memory trees.
    //
    // Linux is intentionally handled by a separate directory-tree watcher
    // below: Node's `fs.watch(dir, { recursive: true })` routes through
    // `internal/fs/recursive_watch` and watches every file. Watching
    // directories only preserves Linux inotify semantics while avoiding
    // per-file watch descriptor fan-out.
    //
    // On any other native creation failure (e.g. unsupported filesystem,
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) the directory also falls back to
    // chokidar so freshness is preserved on the degraded path.
    const nativeRecursiveSupported = process.platform === "darwin" || process.platform === "win32";
    for (const dir of dirWatchPaths) {
      const attached = nativeRecursiveSupported
        ? await this.attachNativeMemoryWatchForDir(dir, markDirty)
        : process.platform === "linux"
          ? await this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)
          : "failed";
      if (attached !== "attached") {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
      if (this.memoryWatchCapacityDegraded) {
        return;
      }
    }
    if (fileWatchPaths.size > 0) {
      this.attachMemoryChokidarPaths(Array.from(fileWatchPaths), markDirty);
    }
    this.scheduleMemoryWatchPressureStartupCheck();
  }

  // Pair recursive coverage with a parent watch that survives root replacement.
  protected async attachNativeMemoryWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
    stillCurrent: () => boolean = () => true,
  ): Promise<NativeMemoryWatchResult> {
    if (this.closed || this.memoryWatchCapacityDegraded || !stillCurrent()) {
      return "failed";
    }
    let recordedInode: number | null;
    try {
      recordedInode = (await fs.stat(dir)).ino;
    } catch (err) {
      // Startup falls back; an existing parent can wait for a missing root.
      return isFileMissingError(err) ? "missing" : "failed";
    }
    const pair: NativeMemoryWatchPair = { dir, main: null, parent: null };
    // Capacity exhaustion in another root revokes probes already awaiting I/O.
    if (this.closed || this.memoryWatchCapacityDegraded || !stillCurrent()) {
      return "failed";
    }
    let mainWatcher: fsSync.FSWatcher | undefined;
    const generation = ++this.nextWatchGeneration;
    try {
      mainWatcher = this.resolveMemoryNativeWatchFactory()(
        dir,
        { recursive: true },
        (_eventType, filename) =>
          this.enqueueReconciliation(`${generation}\0${filename ?? ""}`, async () => {
            if (this.closed || (mainWatcher && pair.main !== mainWatcher)) {
              return;
            }
            if (filename == null) {
              // Node docs: filename may be null on some platforms even when
              // recursive watching is otherwise supported. Be conservative
              // and mark broadly dirty rather than dropping the event.
              markDirty();
              return;
            }
            const full = path.join(dir, filename);
            let stats: fsSync.Stats | undefined;
            try {
              stats = await fs.lstat(full);
            } catch {
              stats = undefined;
            }
            if (this.closed || pair.main !== mainWatcher) {
              return;
            }
            if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
              return;
            }
            // Pass stats so the watch-settle queue can debounce rapid
            // writes; without a snapshot the queue cannot detect stability.
            markDirty(full, stats);
          }),
      );
    } catch (err) {
      if (isFileMissingError(err)) {
        return "missing";
      }
      if (this.degradeMemoryWatchCapacity(dir, err, markDirty)) {
        return "failed";
      }
      log.warn(
        `failed to start native recursive watcher on ${dir}: ${String(err)}; falling back to chokidar`,
      );
      return "failed";
    }
    pair.main = mainWatcher;
    mainWatcher.on("error", (err) => {
      if (pair.main !== mainWatcher) {
        return;
      }
      if (this.degradeMemoryWatchCapacity(dir, err, markDirty)) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory native watcher error on ${dir}: ${message}`);
      // Per Node docs the FSWatcher is no longer usable after an error.
      this.closeNativeMemoryWatchPair(pair);
      if (this.closed) {
        return;
      }
      // Force a broad re-sync to cover the gap, then restore directory
      // coverage by reattaching to chokidar so subsequent file changes
      // still drive watch sync (intervalMinutes defaults to 0; without
      // a watcher the directory would stop being indexed).
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    });
    this.nativeMemoryWatchPairs.push(pair);
    pair.reconcile = async () => markDirty();
    await this.attachNativeMemoryParentWatch(
      pair,
      recordedInode,
      markDirty,
      "native",
      () =>
        this.attachNativeMemoryWatchForDir(dir, markDirty, () =>
          this.nativeMemoryWatchPairs.includes(pair),
        ),
      stillCurrent,
    );
    if (!stillCurrent()) {
      this.closeNativeMemoryWatchPair(pair);
      return "failed";
    }
    return "attached";
  }

  private async attachNativeMemoryParentWatch(
    pair: NativeMemoryWatchPair,
    recordedInode: number,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
    label: "native" | "Linux",
    reattach: () => Promise<NativeMemoryWatchResult>,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const { dir } = pair;
    let watchedInode: number | null = recordedInode;
    // Non-recursive parent watcher: catches root-directory replacement so
    // we can reattach the main watcher on the new inode. Without this,
    // `rm -rf memory && mkdir memory` would leave the main watcher bound
    // to the dead inode and silently miss subsequent file changes.
    const parentDir = path.dirname(dir);
    const baseName = path.basename(dir);
    let parentInode: number;
    try {
      parentInode = (await fs.stat(parentDir)).ino;
    } catch (err) {
      log.warn(`memory ${label} parent watcher could not start on ${parentDir}: ${String(err)}`);
      return;
    }
    if (this.closed || !stillCurrent() || !this.nativeMemoryWatchPairs.includes(pair)) {
      return;
    }
    let parentWatcher: fsSync.FSWatcher | null = null;
    const reconcileRoot = async () => {
      if (this.closed || !this.nativeMemoryWatchPairs.includes(pair)) {
        return;
      }
      let currentInode: number | null = null;
      let result: NativeMemoryWatchResult = "missing";
      try {
        currentInode = (await fs.stat(dir)).ino;
      } catch (err) {
        result = isFileMissingError(err) ? "missing" : "failed";
        if (result === "missing") {
          try {
            if ((await fs.stat(parentDir)).ino !== parentInode) {
              result = "failed";
            }
          } catch {
            result = "failed";
          }
        }
      }
      if (this.closed || !this.nativeMemoryWatchPairs.includes(pair)) {
        return;
      }
      if (currentInode === watchedInode && result !== "failed") {
        return;
      }
      // Keep the parent authoritative while the root is absent. Chokidar's
      // asynchronous missing-path setup can miss an immediate recreation.
      this.closeNativeMemoryWatchChildren(pair);
      watchedInode = null;
      markDirty();
      if (currentInode !== null) {
        result = await reattach();
      }
      if (this.closed || !this.nativeMemoryWatchPairs.includes(pair)) {
        return;
      }
      // A missing root can wait only while a live parent owns its recreation.
      // Parent errors can revoke that coverage while the inode probe awaits I/O.
      if (result === "missing" && pair.parent) {
        return;
      }
      // New coverage must attach before the old parent closes: the root
      // can disappear again between the inode check and native attachment.
      this.closeNativeMemoryWatchPair(pair);
      if (result !== "attached") {
        this.attachMemoryChokidarFallback(dir, markDirty);
      }
    };
    const reconcileChildren = pair.reconcile;
    pair.reconcile = async () => {
      await reconcileRoot();
      if (!this.closed && this.nativeMemoryWatchPairs.includes(pair) && pair.main) {
        await reconcileChildren?.();
      }
    };
    const generation = ++this.nextWatchGeneration;
    try {
      parentWatcher = this.resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          if (this.closed || pair.parent !== parentWatcher) {
            return undefined;
          }
          // A retained parent can itself be replaced while the root is absent.
          if (
            filename !== null &&
            filename !== baseName &&
            (pair.main || filename !== path.basename(parentDir))
          ) {
            return undefined;
          }
          // Share the drain Promise; an async wrapper retains a waiter per event.
          return this.enqueueReconciliation(`${generation}\0parent`, reconcileRoot);
        },
      );
      const attachedParent = parentWatcher;
      attachedParent.on("error", (err) => {
        if (pair.parent !== attachedParent) {
          return;
        }
        if (this.degradeMemoryWatchCapacity(dir, err, markDirty)) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory ${label} parent watcher error on ${path.dirname(dir)}: ${message}`);
        this.closeNativeMemoryWatcher(attachedParent);
        pair.parent = null;
        if (!pair.main) {
          this.closeNativeMemoryWatchPair(pair);
          if (!this.closed) {
            markDirty();
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        }
        // A live main watcher still covers normal events without its parent.
      });
      pair.parent = attachedParent;
      // The root can change while the parent inode probe awaits I/O. Recheck
      // after parent admission so neither side of that gap loses replacement.
      await reconcileRoot();
    } catch (err) {
      if (this.degradeMemoryWatchCapacity(dir, err, markDirty)) {
        return;
      }
      // A failed parent leaves the main watcher covering non-replacement events.
      log.warn(
        `memory ${label} parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
  }

  // Linux inotify reports direct child changes from a watched directory, but
  // it has no native recursive primitive. Watch directories only, then attach
  // newly-created subdirectories on demand; this avoids per-file watchers.
  protected async attachLinuxMemoryDirectoryTreeWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
    stillCurrent: () => boolean = () => true,
  ): Promise<NativeMemoryWatchResult> {
    if (this.closed || this.memoryWatchCapacityDegraded || !stillCurrent()) {
      return "failed";
    }
    let recordedInode: number | null;
    try {
      recordedInode = (await fs.stat(dir)).ino;
    } catch (err) {
      return isFileMissingError(err) ? "missing" : "failed";
    }

    let pair: NativeMemoryWatchPair | null = null;
    const treeWatchers = new Map<string, LinuxMemoryDirectoryWatcher>();
    let rootMissing = false;
    let installing = true;
    const current = () =>
      !this.closed &&
      !this.memoryWatchCapacityDegraded &&
      (!installing || stillCurrent()) &&
      (!pair || this.nativeMemoryWatchPairs.includes(pair));

    const closeAndFallback = (message: string, cause?: unknown) => {
      if (this.memoryWatchCapacityDegraded) {
        return;
      }
      if (cause !== undefined && this.degradeMemoryWatchCapacity(dir, cause, markDirty)) {
        return;
      }
      log.warn(message);
      if (pair) {
        this.closeNativeMemoryWatchPair(pair);
      }
      if (this.closed) {
        return;
      }
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    };

    const closeDirectorySubtree = (watchDir: string) => {
      const watchDirPrefix = `${watchDir}${path.sep}`;
      for (const [entryDir, entry] of Array.from(treeWatchers.entries())) {
        if (entryDir !== watchDir && !entryDir.startsWith(watchDirPrefix)) {
          continue;
        }
        this.closeNativeMemoryWatcher(entry.watcher);
        treeWatchers.delete(entryDir);
      }
    };

    const attachDirectory = async (watchDir: string): Promise<fsSync.FSWatcher | null> => {
      if (!current()) {
        return null;
      }
      let currentInode: number;
      try {
        const currentStat = await fs.stat(watchDir);
        if (!currentStat.isDirectory()) {
          return null;
        }
        currentInode = currentStat.ino;
      } catch (err) {
        rootMissing ||= watchDir === dir && isFileMissingError(err);
        return null;
      }
      if (!current()) {
        return null;
      }
      const existing = treeWatchers.get(watchDir);
      if (existing) {
        if (existing.ino === currentInode) {
          return existing.watcher;
        }
        closeDirectorySubtree(watchDir);
      }
      let watcher: fsSync.FSWatcher | undefined;
      const generation = ++this.nextWatchGeneration;
      try {
        watcher = this.resolveMemoryNativeWatchFactory()(
          watchDir,
          { recursive: false },
          (eventType, filename) =>
            this.enqueueReconciliation(`${generation}\0${filename ?? ""}`, async () => {
              if (this.closed || (watcher && treeWatchers.get(watchDir)?.watcher !== watcher)) {
                return;
              }
              if (filename == null) {
                markDirty();
                if (!(await this.attachLinuxSubtree(watchDir, attachDirectory, current))) {
                  closeAndFallback(
                    `failed to refresh Linux memory directory watchers under ${watchDir}; falling back to chokidar`,
                  );
                }
                return;
              }
              const full = path.join(watchDir, filename);
              let stats: fsSync.Stats | undefined;
              try {
                stats = await fs.lstat(full);
              } catch {
                stats = undefined;
              }
              if (!current() || treeWatchers.get(watchDir)?.watcher !== watcher) {
                return;
              }
              if (!stats) {
                closeDirectorySubtree(full);
              }
              if (stats?.isDirectory()) {
                if (eventType === "rename") {
                  closeDirectorySubtree(full);
                }
                if (!(await this.attachLinuxSubtree(full, attachDirectory, current))) {
                  closeAndFallback(
                    `failed to attach Linux memory directory watcher under ${full}; falling back to chokidar`,
                  );
                  return;
                }
              }
              if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
                return;
              }
              markDirty(full, stats);
            }),
        );
      } catch (err) {
        rootMissing ||= watchDir === dir && isFileMissingError(err);
        if (this.degradeMemoryWatchCapacity(watchDir, err, markDirty)) {
          return null;
        }
        if (watchDir === dir && !rootMissing) {
          log.warn(
            `failed to start Linux memory directory watcher on ${watchDir}: ${String(err)}; falling back to chokidar`,
          );
        }
        return null;
      }
      treeWatchers.set(watchDir, { watcher, ino: currentInode });
      watcher.on("error", (err) => {
        if (treeWatchers.get(watchDir)?.watcher !== watcher) {
          return;
        }
        const detail = err instanceof Error ? err.message : String(err);
        closeAndFallback(`memory Linux directory watcher error on ${watchDir}: ${detail}`, err);
      });
      return watcher;
    };

    const mainWatcher = await attachDirectory(dir);
    if (!mainWatcher) {
      return rootMissing ? "missing" : "failed";
    }
    pair = { dir, main: mainWatcher, parent: null, treeWatchers };
    this.nativeMemoryWatchPairs.push(pair);
    pair.reconcile = async () => {
      if (!current()) {
        return;
      }
      markDirty();
      // Core roots retain their symlink-following anchor even when subtree
      // discovery intentionally skips symlink traversal.
      const visited = new Set<string>([dir]);
      if (!(await this.attachLinuxSubtree(dir, attachDirectory, current, visited))) {
        closeAndFallback(
          `failed to refresh Linux memory directory watchers under ${dir}; falling back to chokidar`,
        );
        return;
      }
      for (const watchedDir of treeWatchers.keys()) {
        if (!visited.has(watchedDir)) {
          closeDirectorySubtree(watchedDir);
        }
      }
    };
    let subtreeAttached = await this.attachLinuxSubtree(dir, attachDirectory, current);
    // Scan errors can refer to a missing child, not the root. Only the root's
    // identity can decide whether an existing parent should retain coverage.
    try {
      subtreeAttached = (await fs.stat(dir)).ino === recordedInode && subtreeAttached;
    } catch (err) {
      this.closeNativeMemoryWatchPair(pair);
      if (!this.closed) {
        markDirty();
      }
      return isFileMissingError(err) ? "missing" : "failed";
    }
    if (!current()) {
      this.closeNativeMemoryWatchPair(pair);
      return "failed";
    }
    if (!subtreeAttached) {
      closeAndFallback(
        `failed to attach Linux memory directory watcher subtree under ${dir}; falling back to chokidar`,
      );
      return "attached";
    }

    await this.attachNativeMemoryParentWatch(
      pair,
      recordedInode,
      markDirty,
      "Linux",
      () =>
        this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty, () =>
          this.nativeMemoryWatchPairs.includes(pair!),
        ),
      stillCurrent,
    );
    if (!stillCurrent()) {
      this.closeNativeMemoryWatchPair(pair);
      return "failed";
    }
    installing = false;
    return "attached";
  }

  private async attachLinuxSubtree(
    root: string,
    attachDirectory: (dir: string) => Promise<fsSync.FSWatcher | null>,
    current: () => boolean,
    visited?: Set<string>,
  ): Promise<boolean> {
    if (!current()) {
      return true;
    }
    let rootStats: fsSync.Stats | undefined;
    try {
      rootStats = await fs.lstat(root);
    } catch {
      // Directory-scan failures (including ENOSPC disk-full) are not watcher
      // capacity. Returning false keeps closeAndFallback's Chokidar path.
      return false;
    }
    if (
      !rootStats?.isDirectory() ||
      shouldIgnoreMemoryWatchPath(root, rootStats, this.settings.multimodal)
    ) {
      return true;
    }
    if (!current()) {
      return true;
    }
    if (!(await attachDirectory(root))) {
      return false;
    }
    visited?.add(root);
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      // Same scan-side contract as the lstat catch above: do not permanently
      // disable watching after a full disk or a racy child listing.
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (
        !(await this.attachLinuxSubtree(
          path.join(root, entry.name),
          attachDirectory,
          current,
          visited,
        ))
      ) {
        return false;
      }
    }
    return true;
  }

  // Reattach `dir` to chokidar after a native watcher dies, so
  // subsequent memory changes under `dir` continue to drive watch sync.
  protected attachMemoryChokidarFallback(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed || this.memoryWatchCapacityDegraded) {
      return;
    }
    try {
      this.attachMemoryChokidarPaths(dir, markDirty);
    } catch (err) {
      log.warn(`failed to attach chokidar fallback for ${dir}: ${String(err)}`);
    }
  }

  private attachMemoryChokidarPaths(
    paths: string | string[],
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed || this.memoryWatchCapacityDegraded) {
      return;
    }
    // Linux subtree startup can create the fallback before ensureWatcher
    // attaches file paths. Reuse that watcher rather than replacing it.
    if (this.watcher) {
      this.watcher.add(paths);
      return;
    }
    const watcher = this.resolveMemoryWatchFactory()(typeof paths === "string" ? [paths] : paths, {
      ignoreInitial: true,
      ignored: (watchPath, stats) =>
        shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
    });
    this.watcher = watcher;
    watcher.on("add", markDirty);
    watcher.on("change", markDirty);
    watcher.on("unlink", markDirty);
    watcher.on("unlinkDir", markDirty);
    watcher.on("error", (err) => {
      if (this.degradeMemoryWatchCapacity("chokidar", err, markDirty)) {
        return;
      }
      // File watcher errors must not crash the gateway; manual search still works.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory watcher error: ${message}`);
    });
    watcher.once("ready", () => {
      this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
    });
  }
}
