import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { MemoryFileWatcher } from "./file-watcher.js";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";

const log = createSubsystemLogger("memory");

function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err: unknown) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  private fileWatcher: MemoryFileWatcher | undefined;
  private memoryWatcherReady: Promise<void> = Promise.resolve();
  protected get memoryWatchCapacityDegraded(): boolean {
    return this.fileWatcher?.capacityDegraded ?? false;
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.closed) {
      return;
    }
    if (this.memoryFiles) {
      if (this.memoryWatchSubscription || this.memoryWatchUnavailable) {
        return;
      }
      const subscription = new AbortController();
      this.memoryWatchSubscription = subscription;
      const markDirty = (event: "change" | "unavailable") => {
        if (subscription.signal.aborted || this.closed) {
          return;
        }
        this.markMemoryWatchDirty();
        this.memoryWatchUnavailable ||= event === "unavailable";
        // Remote notifications have already passed native file settling on the host.
        runDetachedMemorySync(() => this.sync({ reason: "watch" }), "watch");
      };
      void this.memoryFiles
        .watch(
          {
            agentId: this.agentId,
            settings: {
              extraPaths: this.settings.extraPaths,
              multimodal: this.settings.multimodal,
              sync: { watchDebounceMs: this.settings.sync.watchDebounceMs },
            },
          },
          markDirty,
          subscription.signal,
        )
        .then(
          () => markDirty("unavailable"),
          (error: unknown) => {
            markDirty("unavailable");
            if (!subscription.signal.aborted) {
              log.warn(`memory workspace watcher unavailable: ${String(error)}`);
            }
          },
        );
      return;
    }
    if (this.fileWatcher) {
      return;
    }
    this.fileWatcher = new MemoryFileWatcher({
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      settings: this.settings,
      onDirty: () => this.markMemoryWatchDirty(),
      onChange: () => {
        this.markMemoryWatchDirty();
        return this.sync({ reason: "watch" });
      },
      onUnavailable: () => {
        this.memoryWatchUnavailable = true;
        this.dirty = true;
      },
    });
    this.memoryWatcherReady = this.fileWatcher.start().catch((error: unknown) => {
      if (!this.closed) {
        this.memoryWatchUnavailable = true;
        this.dirty = true;
        log.warn(`memory workspace watcher unavailable: ${String(error)}`);
      }
    });
  }

  protected async awaitMemoryWatcherReady(): Promise<void> {
    await this.memoryWatcherReady;
  }

  protected async closeWatchResources(): Promise<void> {
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.memoryWatchSubscription?.abort();
    this.memoryWatchSubscription = undefined;
    await this.fileWatcher?.close();
    this.fileWatcher = undefined;
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = resolveTimerTimeoutMs(minutes * 60 * 1000, 0, 0);
    if (ms <= 0) {
      return;
    }
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }
}
