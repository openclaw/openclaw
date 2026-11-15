import { FsSafeError } from "@openclaw/fs-safe/errors";
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
  hashSourceFile,
  sourceTargetPaths,
  type SourceFile,
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
  let rediscover = false;
  const dirtyFiles = new Set<string>();
  let files: Map<string, SourceFile> | undefined;
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
          await existing.subscription.setScopes(group.scopes);
        }
        continue;
      }
      const entry: Observation = {
        group,
        signature,
        subscription: watch(group.authority, {
          scopes: group.scopes,
          mode,
          pollIntervalMs,
          signal: lifetime.signal,
          exclude: (candidate) => excludeSourceTarget(entry.group, candidate, options.ignored),
          onInvalidate(hint) {
            // Overflow and admission baselines request a read, never a restart.
            if (!hint.changes) {
              request();
              return;
            }
            for (const change of hint.changes) {
              const names = sourceTargetPaths(entry.group, change.path).filter(
                (lexical) => !options.ignored(lexical),
              );
              if (
                names.length &&
                (change.type === "structural" ||
                  names.some((name) => files?.get(name)?.authority !== entry.group.authority))
              ) {
                request();
                return;
              }
              if (names.length) {
                request(names);
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

  function request(changedNames?: Iterable<string>) {
    if (closing) {
      return;
    }
    if (!changedNames) {
      rediscover = true;
      dirtyFiles.clear();
    } else if (!rediscover) {
      for (const name of changedNames) {
        dirtyFiles.add(name);
      }
    }
    if (active) {
      return;
    }
    active = Promise.resolve()
      .then(async () => {
        while (rediscover || dirtyFiles.size) {
          if (closing) {
            break;
          }
          const full = rediscover;
          rediscover = false;
          const names = [...dirtyFiles];
          dirtyFiles.clear();
          let groups: SourceTargetGroup[] | undefined;
          let current: Map<string, SourceFile>;
          try {
            if (full) {
              groups = await discovery.discover(lifetime.signal);
              current = new Map(groups.flatMap((group) => [...group.files]));
            } else {
              current = new Map(files);
              for (const name of names) {
                const file = current.get(name);
                if (!file) {
                  request();
                  break;
                }
                try {
                  const hash = await hashSourceFile(file.authority, file.relative, lifetime.signal);
                  current.set(name, { ...file, hash });
                } catch (error) {
                  if (
                    !(error instanceof FsSafeError) ||
                    !["not-found", "not-file", "path-mismatch", "symlink"].includes(error.code)
                  ) {
                    throw error;
                  }
                  request();
                  break;
                }
              }
              // A structural hint can retire a selected alias while its old file is being read.
              if (rediscover) {
                continue;
              }
            }
          } catch (error) {
            if (error !== lifetime.signal.reason) {
              failures.add(error);
            }
            throw error;
          }
          lifetime.signal.throwIfAborted();
          const previous = files;
          const changed =
            previous &&
            [...new Set([...previous.keys(), ...current.keys()])].find(
              (name) => previous.get(name)?.hash !== current.get(name)?.hash,
            );
          files = current;
          if (groups) {
            await install(groups);
          }
          lifetime.signal.throwIfAborted();
          if (changed !== undefined) {
            options.onChange(changed);
          }
          if (!announced) {
            // Admission does not wait for later invalidations to stop arriving.
            announced = true;
            const modes = new Set(
              [...observations.values()].map(({ subscription }) => subscription.health().mode),
            );
            options.onLog?.(`Watching sources (${[...modes].join(", ")}).`);
            readiness.resolve();
          }
        }
      })
      .catch(fail)
      .finally(() => {
        active = undefined;
        if ((rediscover || dirtyFiles.size) && !closing) {
          request(dirtyFiles);
        }
      });
  }
  request();
  return { ready: readiness.promise, close };
}
