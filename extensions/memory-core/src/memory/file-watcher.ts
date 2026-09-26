import {
  watch,
  type WatchInvalidation,
  type WatchHealth,
  type WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "openclaw/plugin-sdk/file-access-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { runInMemoryBackgroundContext } from "./background-context.js";
import { MemoryWatchPolicy, type MemoryObservation } from "./watch-policy.js";
import { warnIfMemoryWatchPressureHigh } from "./watch-pressure.js";
import {
  MEMORY_WATCH_MAX_PATHS,
  MemoryWatchMetadataCloseError,
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchFile,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

const log = createSubsystemLogger("memory");
const RETRY_DELAYS_MS = [500, 2_000, 5_000];
export type MemoryFileWatcherOptions = {
  workspaceDir: string;
  agentId: string;
  settings: MemoryWorkspaceWatchRequest["settings"];
  onChange: () => void | Promise<void>;
  onUnavailable: () => void;
  onDirty?: () => void;
};
type Observation = {
  id: string;
  group: MemoryObservation;
  key: string;
  active: boolean;
  subscription?: WatchSubscription;
  constructed: boolean;
  construction: Promise<void>;
  closing?: Promise<void>;
};

/** Shared local/remote Memory policy. fs-safe exclusively owns filesystem observation. */
export class MemoryFileWatcher {
  private readonly policy: MemoryWatchPolicy;
  private readonly lifetime = new AbortController();
  private readonly observations = new Map<string, Observation>();
  private readonly rootIds = new WeakMap<MemoryObservation["root"], number>();
  private nextRootId = 0;
  private readonly pendingPaths: MemoryWatchSettleQueue = new Map();
  private readonly pressure = { shown: false };
  private readonly closeErrors: unknown[] = [];
  private readonly retiring = new Set<Promise<void>>();
  private closed = false;
  private degraded = false;
  private retries = 0;
  private retryExhausted = false;
  private starting?: Promise<void>;
  private refreshing?: Promise<void>;
  private refreshRequested = false;
  private recovering?: Promise<void>;
  private closing?: Promise<void>;
  private settling?: Promise<void>;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pendingChange = false;
  private broadChange = false;
  private revision = 0;

  constructor(private readonly options: MemoryFileWatcherOptions) {
    this.policy = new MemoryWatchPolicy(options.workspaceDir, options.settings);
  }

  get capacityDegraded(): boolean {
    return this.degraded;
  }

  start(): Promise<void> {
    // Both local and remote callers can arrive from a turn. Resource lifetimes
    // inherit the plugin service context, never the requesting turn's ALS store.
    return (this.starting ??= runInMemoryBackgroundContext(() => this.refresh()));
  }

  private refresh(): Promise<void> {
    if (
      this.closed ||
      this.degraded ||
      this.closeErrors.length ||
      this.recovering ||
      this.retryExhausted
    ) {
      return Promise.resolve();
    }
    this.refreshRequested = true;
    return (this.refreshing ??= Promise.resolve()
      .then(async () => {
        while (this.refreshRequested && !this.closed && !this.recovering) {
          this.refreshRequested = false;
          const admitted = await this.policy.observations(this.lifetime.signal);
          const groups = admitted.flatMap((group) => {
            let id = this.rootIds.get(group.root);
            if (id === undefined) {
              id = ++this.nextRootId;
              this.rootIds.set(group.root, id);
            }
            const chunks: Array<{ id: string; group: MemoryObservation }> = [];
            for (let offset = 0; offset < group.selections.length; offset += 128) {
              chunks.push({
                id: String(id) + ":" + offset,
                group: {
                  root: group.root,
                  selections: group.selections.slice(offset, offset + 128),
                },
              });
            }
            return chunks;
          });
          if (this.closed || this.recovering) {
            return;
          }
          const next = new Set(groups.map((group) => group.id));
          // Domain invalidation has already been published before any slow close.
          const removed = [...this.observations.values()].filter((entry) => !next.has(entry.id));
          await this.retire(removed);
          if (this.closed || this.recovering || this.closeErrors.length) {
            return;
          }
          const ready: Promise<void>[] = [];
          for (const { id, group } of groups) {
            if (this.closed || this.recovering) {
              return;
            }
            const scopes = this.policy.scopes(group);
            const key = JSON.stringify(scopes);
            let entry = this.observations.get(id);
            if (entry) {
              entry.group = group;
              if (entry.key !== key) {
                entry.key = key;
                ready.push(entry.subscription!.setScopes(scopes));
              }
              continue;
            }
            const mode = resolveFsObservationMode();
            const construction = createDeferred<void>();
            entry = {
              id,
              group,
              key,
              active: true,
              constructed: false,
              construction: construction.promise,
            };
            this.observations.set(id, entry);
            const owner = entry;
            try {
              owner.subscription = watch(group.root, {
                scopes,
                mode,
                ...(mode === "poll" ? { intervalMs: resolveFsObservationIntervalMs() } : {}),
                maxPendingPaths: MEMORY_WATCH_MAX_PATHS,
                signal: this.lifetime.signal,
                exclude: (file) => this.policy.exclude(owner.group, file),
                onInvalidate: (hint) => {
                  if (owner.active && !this.closed) {
                    this.dirty(owner.group, hint);
                  }
                },
                onHealth: (health) => {
                  if (owner.active && !this.closed) {
                    this.health(health);
                  }
                },
              });
              // A synchronous health/dirty callback may already have retired this
              // owner. Its retirement waits for construction before actual close.
              void owner.subscription.ready.catch(() => {});
              ready.push(owner.subscription.ready);
            } finally {
              owner.constructed = true;
              construction.resolve();
            }
          }
          await Promise.all(ready);
        }
      })
      .catch((error: unknown) => {
        if (!this.closed) {
          this.unavailable(error);
        }
      })
      .finally(() => {
        this.refreshing = undefined;
        if (this.refreshRequested && !this.retryTimer) {
          void this.refresh();
        }
      }));
  }

  private dirty(group: MemoryObservation, hint: WatchInvalidation): void {
    if (!hint.changes) {
      this.markDirty();
      void this.refresh();
      return;
    }
    // A changed polling snapshot is a file fact too; initial/whole-scope
    // reconciliation must not refresh the recovery budget.
    if (hint.changes.length && (hint.reason === "event" || hint.reason === "reconcile")) {
      this.retries = 0;
    }
    let structural = false;
    for (const change of hint.changes) {
      structural ||= change.type === "structural";
      const file = this.policy.select(group, change.path, change.type === "structural");
      if (file) {
        this.markDirty(file);
      }
    }
    if (structural) {
      void this.refresh();
    }
  }

  private health(health: WatchHealth): void {
    if (health.state === "unavailable") {
      const code =
        health.failure?.operation === "watch" && health.failure.code === "watch-limit"
          ? "watch-limit"
          : undefined;
      this.unavailable(health.failure?.error, code);
      return;
    }
    if (health.state !== "ready") {
      return;
    }
    const facts = [...this.observations.values()].flatMap((entry) =>
      entry.subscription ? [entry.subscription.health()] : [],
    );
    const polling = health.mode === "poll";
    const count = facts.reduce((total, fact) => total + fact.directories, 0);
    warnIfMemoryWatchPressureHigh(
      this.pressure,
      count,
      "observed directories",
      polling
        ? "Large memory folders or extraPaths increase metadata polling work."
        : "Large memory folders or extraPaths can exhaust file-watch/open-file limits.",
      "Remove unnecessary memory.search.extraPaths entries or narrow their roots. After changes, restart the Gateway. To refresh the index, run in the Gateway's environment: " +
        formatCliCommand("openclaw memory index --force --agent " + this.options.agentId) +
        ".",
      (message) => log.warn(message),
    );
  }

  private unavailable(error: unknown, capacityCode?: string): void {
    if (this.closed || this.recovering || this.retryTimer || this.degraded) {
      return;
    }
    this.degraded ||= Boolean(capacityCode);
    this.options.onUnavailable();
    this.markDirty();
    log.warn(
      capacityCode
        ? "memory watcher capacity exhausted (" +
            capacityCode +
            "); watching disabled, memory will refresh on search"
        : "memory watcher unavailable; memory will refresh on search: " + String(error),
    );
    // close() must reject teardown failures only. Observation failures belong to
    // ready/reconcile and retained health; replaying them from close would
    // incorrectly prohibit fresh acquisition after a recoverable scan error.
    const retirement = this.retire([...this.observations.values()]);
    this.recovering = retirement.finally(() => {
      this.recovering = undefined;
      if (this.closed || this.degraded || this.closeErrors.length) {
        return;
      }
      const delay = RETRY_DELAYS_MS[this.retries++];
      if (delay === undefined) {
        this.retryExhausted = true;
        return;
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.refresh();
      }, delay);
      this.retryTimer.unref();
    });
  }

  private retire(entries: Observation[]): Promise<void> {
    const done = createDeferred<void>();
    this.retiring.add(done.promise);
    void done.promise.then(() => this.retiring.delete(done.promise));
    // Enroll before close can synchronously reenter application shutdown.
    const closes = entries.map((entry) => {
      entry.active = false;
      if (this.observations.get(entry.id) === entry) {
        this.observations.delete(entry.id);
      }
      const close = async () => {
        await entry.subscription?.close();
      };
      return (entry.closing ??= entry.constructed ? close() : entry.construction.then(close));
    });
    void Promise.allSettled(closes)
      .then((results) => {
        for (const result of results) {
          if (result.status !== "rejected") {
            continue;
          }
          this.closeErrors.push(result.reason);
          if (!this.closed) {
            this.options.onUnavailable();
          }
          log.warn(
            "memory watcher close failed; observation will not restart: " + String(result.reason),
          );
        }
      })
      .catch((error: unknown) => this.closeErrors.push(error))
      .finally(() => done.resolve());
    return done.promise;
  }

  private markDirty(file?: MemoryWatchFile): void {
    if (this.closed) {
      return;
    }
    this.revision++;
    this.pendingChange = true;
    if (!file || (!this.broadChange && !recordMemoryWatchEventPath(this.pendingPaths, file))) {
      this.broadChange = true;
      this.pendingPaths.clear();
    }
    this.options.onDirty?.();
    this.scheduleSync();
  }

  private scheduleSync(recheck = false): void {
    if (this.closed || this.settling) {
      return;
    }
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(
      () => {
        this.watchTimer = undefined;
        let retry = false;
        const revision = this.revision;
        this.settling = Promise.resolve()
          .then(async () => {
            if (this.closed) {
              return;
            }
            if (!(await settleMemoryWatchEventPaths(this.pendingPaths, this.lifetime.signal))) {
              retry = true;
              return;
            }
            if (this.closed) {
              return;
            }
            this.pendingChange = this.revision !== revision;
            this.broadChange = false;
            await this.options.onChange();
          })
          .catch((error: unknown) => {
            if (error instanceof MemoryWatchMetadataCloseError) {
              this.closeErrors.push(error.cause);
              this.unavailable(error);
            }
            if (!this.closed) {
              this.options.onUnavailable();
              // Do not spin indefinitely on a persistent metadata/indexing failure.
              this.pendingChange = this.revision !== revision;
              log.warn("memory sync failed (watch): " + String(error));
            }
          })
          .finally(() => {
            this.settling = undefined;
            if (this.pendingChange) {
              this.scheduleSync(retry);
            }
          });
      },
      Math.max(recheck ? 100 : 0, this.options.settings.sync.watchDebounceMs),
    );
    this.watchTimer.unref();
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const done = createDeferred<void>();
    // Publish the join before abort/close can synchronously reenter shutdown.
    this.closing = done.promise;
    this.closed = true;
    this.lifetime.abort();
    clearTimeout(this.watchTimer);
    clearTimeout(this.retryTimer);
    const retirement = this.retire([...this.observations.values()]);
    void runInMemoryBackgroundContext(async () => {
      await Promise.allSettled([
        this.starting,
        this.refreshing,
        this.recovering,
        this.settling,
        retirement,
        ...this.retiring,
      ]);
      this.pendingPaths.clear();
      if (this.closeErrors.length) {
        throw new AggregateError(this.closeErrors, "Memory watcher cleanup failed");
      }
    }).then(done.resolve, done.reject);
    return this.closing;
  }
}
