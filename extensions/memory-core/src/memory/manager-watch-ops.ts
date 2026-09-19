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
  protected get memoryWatchCapacityDegraded(): boolean {
    return this.fileWatcher?.capacityDegraded ?? false;
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.closed) {
      return;
    }
    if (this.fileWatcher) {
      return;
    }
    this.fileWatcher = new MemoryFileWatcher({
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      settings: this.settings,
      onDirty: () => {
        this.dirty = true;
      },
      onChange: () => this.sync({ reason: "watch" }),
      onUnavailable: () => {
        this.dirty = true;
      },
    });
    this.fileWatcher.start();
  }

  protected async closeMemoryWatcher(): Promise<void> {
    await this.fileWatcher?.close();
    this.fileWatcher = undefined;
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
