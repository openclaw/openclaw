// Memory Core owns memory watcher resources and their degraded lifecycle.
import fsSync from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { getFileWatchCapacityCode } from "openclaw/plugin-sdk/file-access-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import {
  countChokidarWatchedEntries,
  type MemoryWatchPressureUnit,
  type MemoryWatchPressureWarningState,
  warnIfMemoryWatchPressureHigh,
} from "./watch-pressure.js";
import {
  MEMORY_WATCH_MAX_PATHS,
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

const MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS = 10_000;
const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

// Native watch ignores listener results; the queue owns rejection and shutdown.
// Injected factories can await that same completion to control event ordering.
type MemoryNativeWatchFactory = (
  filename: string,
  options: { recursive: boolean },
  listener: (eventType: fsSync.WatchEventType, filename: string | null) => void | Promise<void>,
) => fsSync.FSWatcher;

export type MemoryFileWatchCallbacks = {
  onChange: () => void | Promise<void>;
  onUnavailable: () => void;
  onDirty?: () => void;
};

export type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher | null;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
  reconcile?: () => Promise<void>;
};

export type LinuxMemoryDirectoryWatcher = {
  watcher: fsSync.FSWatcher;
  ino: number;
};

export abstract class MemoryFileWatchResources {
  protected closed = false;
  protected watcher: FSWatcher | null = null;
  protected memoryWatchPressureStartupTimer: NodeJS.Timeout | null = null;
  private readonly pendingWatchPaths: MemoryWatchSettleQueue = new Map();
  private pendingChange = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private reconciling: Promise<void> | null = null;
  private settling: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  private readonly pendingReconciliations = new Map<string, () => Promise<void>>();
  private reconcileAll = false;

  constructor(
    protected readonly agentId: string,
    private readonly watchSettings: MemoryWorkspaceWatchRequest["settings"],
    private readonly callbacks: MemoryFileWatchCallbacks,
  ) {}
  protected readonly nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
  private readonly memoryWatchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  protected memoryWatchCapacityDegraded = false;

  get capacityDegraded(): boolean {
    return this.memoryWatchCapacityDegraded;
  }

  protected scheduleMemoryWatchPressureStartupCheck(): void {
    if (
      this.memoryWatchPressureStartupTimer ||
      this.memoryWatchPressureWarning.shown ||
      this.closed ||
      (this.nativeMemoryWatchPairs.length === 0 && !this.watcher)
    ) {
      return;
    }
    this.memoryWatchPressureStartupTimer = setTimeout(() => {
      this.memoryWatchPressureStartupTimer = null;
      if (this.closed || this.memoryWatchPressureWarning.shown) {
        return;
      }
      if (this.watcher) {
        this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(this.watcher), "paths");
      }
      if (this.memoryWatchPressureWarning.shown) {
        return;
      }
      let directoryCount = 0;
      for (const pair of this.nativeMemoryWatchPairs) {
        directoryCount += pair.treeWatchers?.size ?? 0;
      }
      this.warnIfMemoryWatchPressure(directoryCount, "directories");
    }, MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS);
  }

  protected warnIfMemoryWatchPressure(count: number, unit: MemoryWatchPressureUnit): void {
    const reindexCommand = formatCliCommand(
      `openclaw memory index --force --agent ${this.agentId}`,
    );
    warnIfMemoryWatchPressureHigh(
      this.memoryWatchPressureWarning,
      count,
      unit,
      "Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files.",
      `Remove unnecessary memory.search.extraPaths entries or narrow their directory roots, including per-agent entries; otherwise review the host's file-watch/open-file limits. After changes, restart the Gateway. To refresh the affected index, run in the Gateway's environment: ${reindexCommand}.`,
      (message) => log.warn(message),
    );
  }

  protected closeNativeMemoryWatchChildren(pair: NativeMemoryWatchPair): void {
    if (pair.treeWatchers) {
      for (const entry of pair.treeWatchers.values()) {
        try {
          entry.watcher.close();
        } catch {
          // ignore close failures
        }
      }
      pair.treeWatchers.clear();
    } else if (pair.main) {
      try {
        pair.main.close();
      } catch {
        // ignore close failures
      }
    }
    pair.main = null;
  }

  protected closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    this.closeNativeMemoryWatchChildren(pair);
    if (pair.parent) {
      try {
        pair.parent.close();
      } catch {
        // ignore close failures
      }
      pair.parent = null;
    }
    this.removeNativeMemoryWatchPair(pair);
  }

  protected closeNativeMemoryWatchPairs(): void {
    while (this.nativeMemoryWatchPairs.length > 0) {
      const pair = this.nativeMemoryWatchPairs[0];
      if (!pair) {
        return;
      }
      this.closeNativeMemoryWatchPair(pair);
    }
  }

  // Watcher create/error only. Scan-side codes (readdir/lstat/stat ENOSPC)
  // can mean a full disk, not an exhausted watch table; those callers keep
  // closeAndFallback so watching can resume after the host recovers.
  protected degradeMemoryWatchCapacity(
    watchPath: string,
    err: unknown,
    markDirty: () => void,
  ): boolean {
    const code = getFileWatchCapacityCode(err);
    if (!code) {
      return false;
    }
    if (this.memoryWatchCapacityDegraded) {
      return true;
    }
    this.memoryWatchCapacityDegraded = true;
    this.callbacks.onUnavailable();
    this.closeNativeMemoryWatchPairs();
    const watcher = this.watcher;
    if (watcher) {
      void watcher.close().catch((error: unknown) => {
        log.warn(`memory watcher close failed: ${String(error)}`);
      });
      // Chokidar removes error listeners before pending filesystem operations settle.
      watcher.on("error", () => {});
    }
    markDirty();
    log.warn(
      `memory watcher capacity exhausted on ${watchPath} (${code}); ` +
        "watching disabled, memory will refresh on search",
    );
    return true;
  }

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }

  start(): Promise<void> {
    return (this.starting ??= this.startWatching());
  }

  protected abstract startWatching(): Promise<void>;

  protected markMemoryWatchDirty(watchPath?: string, stats?: MemoryWatchEventStats): void {
    this.pendingChange = true;
    recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
    this.callbacks.onDirty?.();
    this.scheduleWatchSync();
  }

  protected resolveMemoryWatchFactory(): typeof chokidar.watch {
    if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
      const override: unknown = Reflect.get(globalThis, TEST_MEMORY_WATCH_FACTORY_KEY);
      if (typeof override === "function") {
        // SAFETY: Only test fixtures install the chokidar-compatible factory at this test-only symbol.
        return override as typeof chokidar.watch;
      }
    }
    return chokidar.watch.bind(chokidar);
  }

  protected resolveMemoryNativeWatchFactory(): MemoryNativeWatchFactory {
    if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
      const override: unknown = Reflect.get(globalThis, TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY);
      if (typeof override === "function") {
        // SAFETY: Only test fixtures install the fs.watch-compatible factory at this test-only symbol.
        return override as MemoryNativeWatchFactory;
      }
    }
    return fsSync.watch.bind(fsSync);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.pendingReconciliations.clear();
    this.reconcileAll = false;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.memoryWatchPressureStartupTimer) {
      clearTimeout(this.memoryWatchPressureStartupTimer);
      this.memoryWatchPressureStartupTimer = null;
    }
    this.closeNativeMemoryWatchPairs();
    await Promise.allSettled([this.starting, this.reconciling, this.settling]);
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.pendingWatchPaths.clear();
    this.pendingChange = false;
  }

  private scheduleWatchSync() {
    if (this.closed) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      if (this.settling) {
        return;
      }
      const settle = (async () => {
        if (this.closed) {
          return;
        }
        await this.reconciling;
        if (!(await settleMemoryWatchEventPaths(this.pendingWatchPaths, this.lifetime.signal))) {
          return;
        }
        if (this.closed) {
          return;
        }
        this.pendingChange = false;
        await this.callbacks.onChange();
      })()
        .catch((error: unknown) => {
          if (!this.closed) {
            log.warn(`memory sync failed (watch): ${String(error)}`);
          }
        })
        .finally(() => {
          if (this.settling === settle) {
            this.settling = null;
            // New facts wait behind the accepted generation without timer polling
            // while indexing is slow (watchDebounceMs can be zero).
            if (this.pendingChange) {
              this.scheduleWatchSync();
            }
          }
        });
      this.settling = settle;
    }, this.watchSettings.sync.watchDebounceMs);
  }

  protected enqueueReconciliation(key: string, run: () => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (!this.reconcileAll) {
      // Replacements overlap their old handles. Coalesce within one handle's
      // generation so a late old callback cannot erase its successor's work.
      this.pendingReconciliations.set(key, run);
      if (this.pendingReconciliations.size > MEMORY_WATCH_MAX_PATHS) {
        // Lost selection facts require root reconciliation, not dropped coverage
        // or one retained Promise/closure for every event in an import burst.
        this.pendingReconciliations.clear();
        this.reconcileAll = true;
      }
    }
    if (!this.reconciling) {
      const pending = Promise.resolve()
        .then(async () => {
          await this.starting;
          while (!this.closed) {
            if (this.reconcileAll) {
              this.reconcileAll = false;
              // Reconciliation can replace pairs while awaiting filesystem probes.
              const pairs = [...this.nativeMemoryWatchPairs];
              for (const pair of pairs) {
                await pair.reconcile?.();
              }
              continue;
            }
            const next = this.pendingReconciliations.entries().next().value;
            if (!next) {
              // Release admission before resolving: an event arriving during the
              // Promise continuation must start a new drain, not join a retired one.
              this.reconciling = null;
              return;
            }
            this.pendingReconciliations.delete(next[0]);
            await next[1]();
          }
        })
        .catch((error: unknown) => {
          if (!this.closed) {
            this.pendingReconciliations.clear();
            this.reconcileAll = false;
            this.pendingChange = true;
            this.callbacks.onDirty?.();
            this.callbacks.onUnavailable();
            this.scheduleWatchSync();
            log.warn(`memory watch reconciliation failed: ${String(error)}`);
          }
        })
        .finally(() => {
          if (this.reconciling === pending) {
            this.reconciling = null;
          }
        });
      this.reconciling = pending;
    }
    return this.reconciling;
  }
}
