import type { Root } from "@openclaw/fs-safe/root";
import { watch, type WatchSubscription } from "@openclaw/fs-safe/watch";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "../src/infra/fs-observation-mode.ts";
import { createDeferredCore } from "../src/shared/deferred.ts";
import {
  createSourceTargetDiscovery,
  excludeSourceTarget,
  SOURCE_OBSERVATION_LIMITS,
  sourceTargetPaths,
  type SourceTargetGroup,
} from "./watch-node-source-targets.mts";

export type WatchPathStats = { isDirectory(): boolean };
export type WatchOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ignored: (watchPath: string, stats?: WatchPathStats) => boolean;
  onChange: (path?: string) => void;
  onError: (error: unknown) => void;
};
export type Watcher = { close(): Promise<void> };
export type WatcherFactory = (paths: string[], options: WatchOptions) => Watcher;
type Physical = {
  group: SourceTargetGroup;
  signature: string;
  ready: boolean;
  subscription?: WatchSubscription;
  retirement?: Promise<void>;
};

/** Developer links are caller-trusted sources, not event-granted authority. */
export function createSourceObserver(paths: string[], options: WatchOptions) {
  const lifetime = new AbortController();
  const discovery = createSourceTargetDiscovery(options.cwd, [...paths], options.ignored);
  const current = new Map<Root, Physical>();
  const physical = new Set<Physical>();
  const failures = new Set<unknown>();
  const readiness = createDeferredCore();
  // Closing before ready is valid. The original promise still rejects to readers.
  void readiness.promise.catch(() => {});
  let terminal = false;
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let invalidated = true;
  const mode = resolveFsObservationMode(options.env);
  const intervalMs = mode === "poll" ? resolveFsObservationIntervalMs(options.env) : undefined;

  const retire = (entry: Physical): Promise<void> => {
    if (entry.retirement) {
      return entry.retirement;
    }
    if (!entry.subscription) {
      return Promise.resolve();
    } // Startup still owns assignment.
    const deferred = createDeferredCore();
    entry.retirement = deferred.promise;
    // Publish ownership before invoking any backend callback, including a
    // synchronous reentrant close. Preserve candidate close's original error.
    try {
      entry.subscription.close().then(deferred.resolve, deferred.reject);
    } catch (error) {
      deferred.reject(error);
    }
    void deferred.promise.then(
      () => physical.delete(entry),
      (error: unknown) => {
        failures.add(error);
        physical.delete(entry);
      },
    );
    return deferred.promise;
  };

  const close = (): Promise<void> => {
    if (closing) {
      return closing;
    }
    const deferred = createDeferredCore();
    closing = deferred.promise;
    terminal = true;
    const aborted = new DOMException("Source observer closed", "AbortError");
    readiness.reject(aborted);
    // The shared promise exists before abort listeners or backend close can
    // reenter. Join discovery/startup as well as every physical subscription.
    lifetime.abort(aborted);
    for (const entry of physical) {
      void retire(entry);
    }
    void (async () => {
      await active;
      const results = await Promise.allSettled([...physical].map(retire));
      for (const result of results) {
        if (result.status === "rejected") {
          failures.add(result.reason);
        }
      }
      current.clear();
      // Only reported retirement/owned callback failures reject close.
      // Observation loss is delivered separately through ready and onError.
      if (failures.size === 1) {
        throw [...failures][0];
      }
      if (failures.size) {
        throw new AggregateError([...failures], "Source observation and retirement failed");
      }
    })().then(deferred.resolve, deferred.reject);
    // Ownership is retained even when a synchronous callback cannot await close.
    void closing.catch(() => {});
    return closing;
  };

  const fail = (error: unknown, ownedWorkFailed = false) => {
    if (ownedWorkFailed) {
      // Application discovery can fail while disposing guarded iterators. Its
      // failure is owned here, unlike a separately reported backend outage.
      failures.add(error);
    }
    readiness.reject(error);
    if (!terminal) {
      try {
        options.onError(error);
      } catch (callbackError) {
        failures.add(callbackError);
      }
      void close();
    }
  };

  const request = () => {
    if (terminal) {
      return;
    }
    invalidated = true;
    pump();
  };

  const install = async (groups: SourceTargetGroup[]) => {
    const selected = new Set(groups.map((group) => group.authority));
    const retiring: Promise<void>[] = [];
    for (const [authority, entry] of current) {
      if (!selected.has(authority)) {
        current.delete(authority);
        retiring.push(retire(entry));
      }
    }
    // Join removed subscriptions before admitting replacements for their Roots.
    const retired = await Promise.allSettled(retiring);
    for (const result of retired) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    if (terminal) {
      return;
    }
    const admissions: Promise<void>[] = [];
    for (const group of groups) {
      if (terminal) {
        break;
      }
      const signature = JSON.stringify([group.scopes, group.mappings]);
      const existing = current.get(group.authority);
      if (existing) {
        if (existing.signature !== signature) {
          existing.group = group;
          existing.signature = signature;
          if (existing.subscription) {
            admissions.push(existing.subscription.setScopes(group.scopes));
          }
        }
        continue;
      }
      const entry: Physical = { group, signature, ready: false };
      current.set(group.authority, entry);
      physical.add(entry);
      entry.subscription = watch(group.authority, {
        scopes: group.scopes,
        mode,
        intervalMs,
        maxDirectories: SOURCE_OBSERVATION_LIMITS.directories,
        maxEntries: SOURCE_OBSERVATION_LIMITS.entries,
        exclude: (candidate) => excludeSourceTarget(entry.group, candidate, options.ignored),
        onInvalidate: (hint) => {
          if (terminal || current.get(group.authority) !== entry) {
            return;
          }
          // Admission can include links created since discovery. Refresh their
          // mappings without treating the initial snapshot as a source edit.
          if (!entry.ready && hint.reason === "reconcile" && !hint.changes) {
            request();
            return;
          }
          if (!hint.changes) {
            request();
            options.onChange();
            return;
          }
          if (hint.changes.some((change) => change.type === "structural")) {
            request();
          }
          for (const change of hint.changes) {
            for (const lexical of sourceTargetPaths(entry.group, change.path)) {
              if (terminal) {
                return;
              }
              if (!options.ignored(lexical)) {
                options.onChange(lexical);
              }
            }
          }
        },
        onHealth: (health) => {
          if (!terminal && health.state === "unavailable") {
            fail(health.failure?.error ?? new Error("Source observation unavailable"));
          }
        },
      });
      admissions.push(
        entry.subscription.ready.then(() => {
          entry.ready = true;
        }),
      );
      if (terminal) {
        void retire(entry);
      }
    }
    const admitted = await Promise.allSettled(admissions);
    for (const result of admitted) {
      if (result.status === "rejected") {
        // A close-induced readiness rejection is cancellation, not a close
        // failure. Actual observation/retirement errors stay in failures.
        if (!terminal) {
          throw result.reason;
        }
      }
    }
  };

  function pump() {
    if (active || terminal) {
      return;
    }
    // Enroll before filesystem work or callbacks can close the owner.
    active = Promise.resolve()
      .then(async () => {
        while (invalidated) {
          if (terminal) {
            break;
          }
          invalidated = false;
          const groups = await discovery.discover(lifetime.signal);
          if (!terminal) {
            await install(groups);
          }
        }
        if (!terminal) {
          readiness.resolve();
        }
      })
      .catch((error: unknown) => {
        if (error === lifetime.signal.reason) {
          return;
        }
        if (terminal) {
          // Cancellation must still join and report a distinct in-flight
          // discovery/cleanup failure, not silently turn it into success.
          failures.add(error);
        } else {
          fail(error, true);
        }
      })
      .finally(() => {
        active = undefined;
        if (invalidated && !terminal) {
          pump();
        }
      });
  }
  pump();
  return { ready: readiness.promise, close };
}
