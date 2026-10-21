import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { LocalMemoryFileWatcher } from "./local-file-watcher.js";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  private fileWatcher: LocalMemoryFileWatcher | undefined;
  protected memoryWatcherReady: Promise<void> = Promise.resolve();
  private remoteWatchRetirement: Promise<void> | undefined;
  private remoteWatchCloseFailure: { error: unknown } | undefined;
  protected get memoryWatchCapacityDegraded(): boolean {
    return this.fileWatcher?.capacityDegraded ?? false;
  }

  protected get memoryWatcherHealth() {
    return this.fileWatcher?.health();
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || this.closed) {
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
        this.syncInBackground({ reason: "watch" });
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
    this.fileWatcher = new LocalMemoryFileWatcher({
      runInBackgroundContext: this.runInBackgroundContext,
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      settings: this.settings,
      onDirty: () => this.markMemoryWatchDirty(),
      onChange: () => {
        this.markMemoryWatchDirty();
        return this.syncBackground({ reason: "watch" });
      },
      onState: ({ health }) => {
        if (health.length && health.every((entry) => entry.state === "ready")) {
          this.memoryWatchUnavailable = false;
        }
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

  protected async closeWatchResources(): Promise<void> {
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
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

  protected syncInBackground(params: MemorySyncParams, failureReason = params.reason): void {
    const failed = (err: unknown) => {
      log.warn(`memory sync failed (${failureReason}): ${String(err)}`);
    };
    try {
      this.runInBackgroundContext(() => {
        void this.runInBackgroundContext(() => this.syncBackground(params)).catch(failed);
      });
    } catch (err) {
      failed(err);
    }
  }
}
