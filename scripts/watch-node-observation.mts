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
  onLog?: (message: string) => void;
};
export type Watcher = { close(): Promise<void> };
export type WatcherFactory = (paths: string[], options: WatchOptions) => Watcher;
type Observation = {
  group: SourceTargetGroup;
  signature: string;
  baseline: boolean;
  subscription: WatchSubscription;
};

export function createSourceObserver(paths: string[], options: WatchOptions) {
  const lifetime = new AbortController();
  const discovery = createSourceTargetDiscovery(options.cwd, paths, options.ignored);
  const observations = new Map<Root, Observation>();
  const failures = new Set<unknown>();
  const readiness = createDeferredCore();
  void readiness.promise.catch(() => {});
  const mode = resolveFsObservationMode(options.env);
  const pollIntervalMs = resolveFsObservationIntervalMs(options.env);
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let pending = false;
  let announced = false;

  function close(): Promise<void> {
    if (closing) {
      return closing;
    }
    closing = Promise.resolve().then(async () => {
      // fs-safe joins observation; discovery is our own asynchronous work.
      await active;
      const results = await Promise.allSettled(
        [...observations.values()].map(({ subscription }) => subscription.close()),
      );
      observations.clear();
      for (const result of results) {
        if (result.status === "rejected") {
          failures.add(result.reason);
        }
      }
      if (failures.size === 1) {
        throw [...failures][0];
      }
      if (failures.size) {
        throw new AggregateError([...failures], "Source observation cleanup failed");
      }
    });
    lifetime.abort(new DOMException("Source observer closed", "AbortError"));
    readiness.reject(lifetime.signal.reason);
    void closing.catch(() => {});
    return closing;
  }

  function fail(error: unknown) {
    readiness.reject(error);
    if (closing) {
      return;
    }
    try {
      options.onError(error);
    } catch (callbackError) {
      failures.add(callbackError);
    }
    void close();
  }

  async function install(groups: SourceTargetGroup[]) {
    const selected = new Set(groups.map((group) => group.authority));
    for (const [authority, entry] of observations) {
      if (!selected.has(authority)) {
        await entry.subscription.close();
        observations.delete(authority);
      }
    }
    for (const group of groups) {
      lifetime.signal.throwIfAborted();
      const signature = JSON.stringify([group.scopes, group.mappings]);
      const existing = observations.get(group.authority);
      if (existing) {
        if (existing.signature !== signature) {
          existing.group = group;
          existing.signature = signature;
          existing.baseline = true;
          await existing.subscription.setScopes(group.scopes);
        }
        continue;
      }
      const entry: Observation = {
        group,
        signature,
        baseline: true,
        subscription: watch(group.authority, {
          scopes: group.scopes,
          mode,
          pollIntervalMs,
          signal: lifetime.signal,
          exclude: (candidate) => excludeSourceTarget(entry.group, candidate, options.ignored),
          onInvalidate(hint) {
            // Every admission has a baseline, including setScopes. Rediscover
            // links created during admission without restarting for the baseline.
            if (entry.baseline && hint.reason === "reconcile" && !hint.changes) {
              entry.baseline = false;
              request();
              return;
            }
            if (!hint.changes || hint.changes.some((change) => change.type === "structural")) {
              request();
            }
            if (!hint.changes) {
              options.onChange();
              return;
            }
            for (const change of hint.changes) {
              const changed = sourceTargetPaths(entry.group, change.path).find(
                (lexical) => !options.ignored(lexical),
              );
              if (changed !== undefined) {
                options.onChange(changed);
                return;
              }
            }
          },
          onHealth(health) {
            if (health.state === "unavailable") {
              fail(health.failure?.error ?? new Error("Source observation unavailable"));
            }
          },
        }),
      };
      observations.set(group.authority, entry);
      await entry.subscription.ready;
    }
  }

  function request() {
    if (closing) {
      return;
    }
    pending = true;
    if (active) {
      return;
    }
    active = Promise.resolve()
      .then(async () => {
        while (pending) {
          if (closing) {
            break;
          }
          pending = false;
          let groups: SourceTargetGroup[];
          try {
            groups = await discovery.discover(lifetime.signal);
          } catch (error) {
            if (error !== lifetime.signal.reason) {
              failures.add(error);
            }
            throw error;
          }
          lifetime.signal.throwIfAborted();
          await install(groups);
        }
        if (!closing) {
          if (!announced) {
            announced = true;
            const modes = new Set(
              [...observations.values()].map(({ subscription }) => subscription.health().mode),
            );
            options.onLog?.(`Watching sources (${[...modes].join(", ")}).`);
          }
          readiness.resolve();
        }
      })
      .catch(fail)
      .finally(() => {
        active = undefined;
        if (pending && !closing) {
          request();
        }
      });
  }
  request();
  return { ready: readiness.promise, close };
}
