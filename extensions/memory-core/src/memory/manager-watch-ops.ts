import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { createMemoryBackgroundContext } from "./background-context.js";
import { MemoryFileWatcher } from "./file-watcher.js";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  protected readonly runInBackground = createMemoryBackgroundContext();
  private fileWatcher: MemoryFileWatcher | undefined;
  protected memoryWatcherReady: Promise<void> = Promise.resolve();
  private remoteWatchRetirement: Promise<void> | undefined;
  private remoteWatchCloseFailure: { error: unknown } | undefined;
  protected get memoryWatchCapacityDegraded(): boolean {
    return this.fileWatcher?.capacityDegraded ?? false;
  }

  // Settle asynchronous work inside its detached admission, not the publishing turn.
  protected runBackgroundTask(
    run: () => void | Promise<unknown>,
    errorMessage: string,
  ): Promise<void> {
    const reportError = (err: unknown) => log.warn(`${errorMessage}: ${String(err)}`);
    try {
      return this.runInBackground(async () => {
        try {
          await run();
        } catch (err) {
          reportError(err);
        }
      });
    } catch (err) {
      // Retired owners can reject admission before the detached callback starts.
      reportError(err);
      return Promise.resolve();
    }
  }

  protected get memoryWatcherHealth() {
    return this.fileWatcher?.health();
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
        void this.runBackgroundTask(() => {
          this.markMemoryWatchDirty();
          this.memoryWatchUnavailable ||= event === "unavailable";
          // Remote notifications have already passed native file settling on the host.
          return this.sync({ reason: "watch" });
        }, "memory sync failed (watch)");
      };
      this.remoteWatchRetirement = this.memoryFiles
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
            } else if (error !== subscription.signal.reason) {
              // Cancellation is expected; a distinct transport retirement failure
              // must survive shutdown instead of being mistaken for a joined worker.
              this.remoteWatchCloseFailure = { error };
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
      onChange: () =>
        this.runInBackground(() => {
          this.markMemoryWatchDirty();
          return this.sync({ reason: "watch" });
        }),
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
    const results = await Promise.allSettled([
      (async () => {
        // Abort only requests remote cancellation. Its transport owns and joins
        // the worker; retain the subscription until that physical join settles.
        await this.remoteWatchRetirement;
        if (this.remoteWatchCloseFailure) {
          throw this.remoteWatchCloseFailure.error;
        }
        this.remoteWatchRetirement = undefined;
      })(),
      (async () => {
        await this.fileWatcher?.close();
        // A failed observer retains its rejected retirement join.
        this.fileWatcher = undefined;
      })(),
      (async () => {
        this.sessionUnsubscribe?.();
        this.sessionUnsubscribe = null;
      })(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Memory watch resources cleanup failed");
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
      void this.runBackgroundTask(
        () => this.sync({ reason: "interval" }),
        "memory sync failed (interval)",
      );
    }, ms);
  }
}
