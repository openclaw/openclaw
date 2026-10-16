import {
  watch,
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
  ObservationSampleCloseError,
  type WatchHealth,
  type WatchInvalidation,
  type WatchSubscription,
  type WatchScope,
} from "openclaw/plugin-sdk/file-access-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import type { MemoryCoreRuntimeHost } from "./runtime-host.js";
import { MemoryWatchPolicy, type MemoryObservation } from "./watch-policy.js";
import {
  MEMORY_WATCH_MAX_PATHS,
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchFile,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

const log = createSubsystemLogger("memory");
const RETRY_DELAYS_MS = [500, 2_000, 5_000];
const DEFAULT_POLL_INTERVAL_MS = 30_000;
// Native events drive updates; infrequent reconciliation recovers missed events.
const RECONCILE_INTERVAL_MS = 5 * 60_000;
type MemoryFileWatcherOptions = {
  runInBackgroundContext: NonNullable<MemoryCoreRuntimeHost["runInBackgroundContext"]>;
  workspaceDir: string;
  agentId: string;
  settings: MemoryWorkspaceWatchRequest["settings"];
  onChange: () => void | Promise<void>;
  onUnavailable: () => void;
  onDirty?: () => void;
};
type ObservationMember = {
  group: MemoryObservation;
  scopes: WatchScope[];
  policy: MemoryWatchPolicy;
  invalidate: (hint: WatchInvalidation) => void;
  health: (health: WatchHealth) => void;
  isolate: () => void;
  unavailable: (error: unknown, capacityCode?: string) => void;
};
type SharedObservation = {
  key: string;
  members: Set<ObservationMember>;
  subscription: WatchSubscription;
  mode: "auto" | "poll";
  pollIntervalMs: number;
  shareable: boolean;
  refreshRequested: boolean;
  refreshing?: Promise<void>;
};
type Observation = { id: string; member: ObservationMember; shared: SharedObservation };
const sharedObservations = new Map<string, Set<SharedObservation>>();

function failShared(shared: SharedObservation, error: unknown, capacityCode?: string): void {
  shared.shareable = false;
  const isolate = shared.members.size > 1;
  if (isolate) {
    // Retry separately: one unreadable scope or an oversized union must not disable peers.
    // Mark every member before unavailable callbacks synchronously retire memberships.
    for (const member of shared.members) {
      member.isolate();
    }
  }
  for (const member of shared.members) {
    member.unavailable(error, isolate ? undefined : capacityCode);
  }
}

function sharedScopes(members: Iterable<ObservationMember>): WatchScope[] {
  const scopes = new Map<string, WatchScope>();
  for (const member of members) {
    for (const scope of member.scopes) {
      scopes.set(JSON.stringify(scope), scope);
    }
  }
  return [...scopes.values()];
}

function refreshShared(shared: SharedObservation): Promise<void> {
  shared.refreshRequested = true;
  return (shared.refreshing ??= shared.subscription.ready
    .then(async () => {
      while (shared.refreshRequested && shared.members.size) {
        shared.refreshRequested = false;
        // Serialize updates and read live membership after each awaited scan.
        // setScopes also baselines changed exclusion policies and notifies new members.
        await shared.subscription.setScopes(sharedScopes(shared.members));
      }
    })
    .catch((error: unknown) => {
      failShared(shared, error);
    })
    .finally(() => {
      shared.refreshing = undefined;
    })
    .then(() =>
      shared.refreshRequested && shared.members.size ? refreshShared(shared) : undefined,
    ));
}

function acquireObservation(
  member: ObservationMember,
  mode: "auto" | "poll",
  pollIntervalMs: number,
  shareable: boolean,
): SharedObservation {
  const key = JSON.stringify([
    member.group.root.rootDir,
    member.group.identity,
    mode,
    pollIntervalMs,
  ]);
  const candidates = sharedObservations.get(key) ?? new Set<SharedObservation>();
  for (const shared of candidates) {
    if (shareable && shared.shareable && sharedScopes([...shared.members, member]).length <= 128) {
      shared.members.add(member);
      void refreshShared(shared);
      return shared;
    }
  }
  const members = new Set([member]);
  const shared: SharedObservation = {
    key,
    members,
    mode,
    pollIntervalMs,
    shareable,
    refreshRequested: false,
    subscription: watch(member.group.root, {
      scopes: member.scopes,
      mode,
      intervalMs: RECONCILE_INTERVAL_MS,
      pollIntervalMs,
      maxDirectories: 1_000_000,
      maxEntries: 1_000_000,
      maxPendingPaths: MEMORY_WATCH_MAX_PATHS,
      // The last member owns close; an individual agent must not abort its peers.
      exclude: (file) => {
        for (const active of members) {
          if (!active.policy.exclude(active.group, file)) {
            return false;
          }
        }
        return true;
      },
      onInvalidate: (hint) => {
        for (const active of members) {
          active.invalidate(hint);
        }
      },
      onHealth: (health) => {
        if (health.state === "unavailable") {
          const code =
            health.failure?.operation === "watch" && health.failure.code === "watch-limit"
              ? "watch-limit"
              : undefined;
          failShared(shared, health.failure?.error, code);
          return;
        }
        for (const active of members) {
          active.health(health);
        }
      },
    }),
  };
  candidates.add(shared);
  sharedObservations.set(key, candidates);
  return shared;
}

function releaseObservation({ member, shared }: Observation): Promise<void> {
  shared.members.delete(member);
  if (shared.members.size) {
    void refreshShared(shared);
    return Promise.resolve();
  }
  const candidates = sharedObservations.get(shared.key);
  candidates?.delete(shared);
  if (!candidates?.size) {
    sharedObservations.delete(shared.key);
  }
  return shared.subscription.close();
}

export class MemoryFileWatcher {
  private readonly policy: MemoryWatchPolicy;
  private readonly lifetime = new AbortController();
  private readonly observations = new Map<string, Observation>();
  private readonly rootIds = new WeakMap<MemoryObservation["root"], number>();
  private readonly isolatedRoots = new WeakSet<MemoryObservation["root"]>();
  private nextRootId = 0;
  private readonly pendingPaths: MemoryWatchSettleQueue = new Map();
  private pressureWarningShown = false;
  private pollingWarningShown = false;
  private readonly closeErrors: unknown[] = [];
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
  private revision = 0;

  constructor(private readonly options: MemoryFileWatcherOptions) {
    this.policy = new MemoryWatchPolicy(options.workspaceDir, options.settings);
  }

  get capacityDegraded(): boolean {
    return this.degraded;
  }

  health() {
    return [...this.observations.values()].map(
      ({ shared: { subscription, mode, pollIntervalMs } }) => {
        const health = subscription.health();
        return {
          state: health.state,
          mode: health.mode,
          directories: health.directories,
          failure: health.failure
            ? {
                operation: health.failure.operation,
                code: health.failure.code,
                error: String(health.failure.error),
              }
            : undefined,
          pollingFallback: mode === "auto" && health.mode === "poll",
          pollIntervalMs,
        };
      },
    );
  }

  start(): Promise<void> {
    return (this.starting ??= this.options.runInBackgroundContext(() => this.refresh()));
  }

  private get canObserve(): boolean {
    return !(
      this.closed ||
      this.degraded ||
      this.closeErrors.length ||
      this.recovering ||
      this.retryTimer ||
      this.retryExhausted
    );
  }

  private refresh(): Promise<void> {
    if (!this.canObserve) {
      return Promise.resolve();
    }
    this.refreshRequested = true;
    return (this.refreshing ??= Promise.resolve()
      .then(async () => {
        while (this.refreshRequested && this.canObserve) {
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
                  ...group,
                  selections: group.selections.slice(offset, offset + 128),
                },
              });
            }
            return chunks;
          });
          if (!this.canObserve) {
            return;
          }
          const next = new Set(groups.map((group) => group.id));
          const removed = [...this.observations.values()].filter((entry) => !next.has(entry.id));
          await this.retire(removed);
          if (!this.canObserve) {
            return;
          }
          const ready: Promise<void>[] = [];
          for (const { id, group } of groups) {
            if (!this.canObserve) {
              return;
            }
            const scopes = this.policy.scopes(group);
            const entry = this.observations.get(id);
            if (entry) {
              if (JSON.stringify(entry.member.scopes) === JSON.stringify(scopes)) {
                entry.member.group = group;
                continue;
              }
              // Re-admit changed scopes so the shared 128-scope budget stays bounded.
              await this.retire([entry]);
              if (!this.canObserve) {
                return;
              }
            }
            const mode = resolveFsObservationMode();
            const pollIntervalMs = resolveFsObservationIntervalMs(
              process.env,
              DEFAULT_POLL_INTERVAL_MS,
            );
            const member: ObservationMember = {
              group,
              scopes,
              policy: this.policy,
              invalidate: (hint) => {
                this.deliver(() => this.dirty(member.group, hint));
              },
              health: (health) => {
                this.deliver(() => this.onHealth(health, mode, pollIntervalMs));
              },
              isolate: () => {
                if (!this.isolatedRoots.has(group.root)) {
                  this.isolatedRoots.add(group.root);
                  this.retries = 0;
                }
              },
              unavailable: (error, code) => {
                this.deliver(() => this.unavailable(error, code));
              },
            };
            const shared = acquireObservation(
              member,
              mode,
              pollIntervalMs,
              !this.isolatedRoots.has(group.root),
            );
            this.observations.set(id, { id, member, shared });
            ready.push(shared.refreshing ?? shared.subscription.ready);
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

  private deliver(run: () => void): void {
    let admitted = false;
    try {
      this.options.runInBackgroundContext(() => {
        admitted = true;
        run();
      });
    } catch (error) {
      if (admitted) {
        throw error;
      }
      // Native notifications can arrive after admission closes but before cleanup joins them.
      this.retryExhausted = true;
      this.unavailable(error);
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
      this.pendingChange = false;
    }
  }

  private dirty(group: MemoryObservation, hint: WatchInvalidation): void {
    if (!hint.changes) {
      this.markDirty();
      void this.refresh();
      return;
    }
    let structural = false;
    for (const change of hint.changes) {
      const file = this.policy.select(group, change.path, change.type === "structural");
      if (file) {
        structural ||= change.type === "structural";
        // Only selected file facts refresh recovery, not peer or whole-scope events.
        if (hint.reason === "event" || hint.reason === "reconcile") {
          this.retries = 0;
        }
        this.markDirty(file);
      }
    }
    if (structural) {
      void this.refresh();
    }
  }

  private onHealth(health: WatchHealth, mode: "auto" | "poll", pollIntervalMs: number): void {
    if (health.state !== "ready") {
      return;
    }
    if (mode === "auto" && health.mode === "poll" && !this.pollingWarningShown) {
      this.pollingWarningShown = true;
      const reason = health.failure
        ? `${health.failure.code ?? health.failure.operation}: ${String(health.failure.error)}`
        : "native watch events are unavailable; fs-safe did not report a reason";
      log.warn(
        `memory watcher using fallback polling every ${pollIntervalMs} ms: ${reason}. ` +
          "Native watching will not be retried until the watcher restarts.",
      );
    }
    const count = [...this.observations.values()].reduce(
      (total, entry) => total + entry.shared.subscription.health().directories,
      0,
    );
    if (this.pressureWarningShown || count <= 2_000) {
      return;
    }
    this.pressureWarningShown = true;
    const detail =
      health.mode === "poll"
        ? "Large memory folders or extraPaths increase metadata polling work."
        : "Large memory folders or extraPaths can exhaust file-watch/open-file limits.";
    log.warn(
      `Memory file watching is tracking ${count} observed directories. ${detail} ` +
        "Remove unnecessary memory.search.extraPaths entries or narrow their roots. After changes, restart the Gateway. To refresh the index, run in the Gateway's environment: " +
        formatCliCommand("openclaw memory index --force --agent " + this.options.agentId) +
        ".",
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
    const retirement = this.retire([...this.observations.values()]);
    this.recovering = retirement.finally(() => {
      this.recovering = undefined;
      if (this.closed || this.degraded || this.closeErrors.length || this.retryExhausted) {
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

  private async retire(entries: Observation[]): Promise<void> {
    for (const entry of entries) {
      this.observations.delete(entry.id);
    }
    const results = await Promise.allSettled(entries.map(releaseObservation));
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
  }

  private markDirty(file?: MemoryWatchFile): void {
    if (this.closed) {
      return;
    }
    this.revision++;
    this.pendingChange = true;
    if (file) {
      recordMemoryWatchEventPath(this.pendingPaths, file);
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
            await this.options.runInBackgroundContext(() => this.options.onChange());
          })
          .catch((error: unknown) => {
            if (error instanceof ObservationSampleCloseError) {
              this.closeErrors.push(error.cause);
              this.unavailable(error);
            }
            if (!this.closed) {
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
    this.closing = this.options.runInBackgroundContext(async () => {
      this.closed = true;
      this.lifetime.abort();
      clearTimeout(this.watchTimer);
      clearTimeout(this.retryTimer);
      const retirement = this.retire([...this.observations.values()]);
      await Promise.allSettled([
        this.starting,
        this.refreshing,
        this.recovering,
        this.settling,
        retirement,
      ]);
      this.pendingPaths.clear();
      if (this.closeErrors.length) {
        throw new AggregateError(this.closeErrors, "Memory watcher cleanup failed");
      }
    });
    return this.closing;
  }
}
