import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginMetadataSnapshotCache,
  getPluginCacheRetirementSignal,
  retainPluginCache,
  waitForPluginCacheRetirement,
} from "../plugins/plugin-cache.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginRegistryResourceOwner,
  markPluginRegistryActive,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  hasRetainedPluginRuntimeCloseError,
  PluginRuntimeCloseRetainedError,
} from "../plugins/runtime-close-error.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerPreparedPluginRetirement } from "./prepared-model-runtime.lifecycle.js";
import {
  closeEphemeralPreparedModelRuntimeResources,
  retainPreparedModelRuntimeSnapshotResources,
} from "./prepared-model-runtime.resources.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
type Lifetime = ReturnType<typeof createLifetime>;
// Source and compiled consumers can share the same generation and registry objects.
// Share only cleanup ownership; model/auth snapshots keep their existing module identity.
const { generations, registries, active, retirements, publications } = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedPluginLifetimes"),
  () => ({
    generations: new WeakMap<PreparedModelRuntimePluginGeneration, Lifetime>(),
    registries: new WeakMap<PluginRegistry, Lifetime>(),
    active: new Set<Lifetime>(),
    retirements: new Set<Promise<void>>(),
    publications: new WeakMap<
      object,
      { generation: PreparedModelRuntimePluginGeneration; release: () => Promise<void> }
    >(),
  }),
);

function createLifetime(dispose: () => Promise<unknown>) {
  const references = new Set<object>();
  let closing: Deferred | undefined;
  let disposing = false;
  const lifetime = {
    get referenced() {
      return references.size > 0;
    },
    retain() {
      if (closing) {
        throw new Error("Prepared plugin generation has retired");
      }
      const reference = {};
      references.add(reference);
      let releaseCompletion: Promise<void> | undefined;
      return () => {
        if (references.delete(reference) && references.size === 0) {
          releaseCompletion = lifetime.close();
        }
        return releaseCompletion;
      };
    },
    close(): Promise<void> {
      if (!closing) {
        const completion = (closing = createDeferredCore());
        retirements.add(completion.promise);
        void completion.promise.then(
          () => {
            active.delete(lifetime);
            retirements.delete(completion.promise);
          },
          (error: unknown) => {
            // Keep the rejected completion for observation, not as ordinary resource custody.
            if (!hasRetainedPluginRuntimeCloseError(error)) {
              active.delete(lifetime);
            }
          },
        );
      }
      if (references.size === 0 && !disposing) {
        disposing = true;
        const completion = closing;
        // Close admission immediately; physical disposal waits for the final borrower.
        try {
          void dispose().then(() => completion.resolve(), completion.reject);
        } catch (error) {
          completion.reject(error);
        }
      }
      return closing.promise;
    },
  };
  active.add(lifetime);
  return lifetime;
}

function retainRegistry(registryView: PluginRegistry): (() => void | Promise<void>) | undefined {
  const prepared = retainPreparedModelRuntimeSnapshotResources({ pluginRegistry: registryView });
  if (prepared) {
    return prepared.release;
  }
  const inspection = getPluginRegistryInspectionResources(registryView);
  if (inspection) {
    return inspection.retain().release;
  }
  const registry = getPluginRegistryResourceOwner(registryView);
  let lifetime = registries.get(registry);
  if (!lifetime) {
    // Gateway-root and other externally activated registries remain borrowed.
    if (capturePluginRegistryLifecycleEpoch(registry)) {
      return undefined;
    }
    if (isPluginRegistryRetired(registry)) {
      throw new Error("Prepared plugin registry has retired");
    }
    markPluginRegistryActive(registry);
    lifetime = createLifetime(async () => {
      try {
        return await disposePluginRegistryInstances(registry);
      } catch (error) {
        // Ordinary cleanup faults are result rows; rejection leaves a host prerequisite unfinished.
        throw new PluginRuntimeCloseRetainedError(error);
      }
    });
    registries.set(registry, lifetime);
  }
  return lifetime.retain();
}

/** Construction registers the same final owner before an awaited inspection can finish. */
export function registerPreparedPluginLifetime(): void {
  registerPreparedPluginRetirement(closePreparedPluginGenerations);
}

export function ownPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): Lifetime {
  const existing = generations.get(generation);
  if (existing) {
    return existing;
  }
  registerPreparedPluginLifetime();
  const releaseMetadata = retainPluginCache(
    getPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot),
  );
  const releases: Array<() => void | Promise<void>> = [];
  const acquisitionFailures: unknown[] = [];
  const lifetime = createLifetime(async () => {
    const results = await Promise.allSettled(releases.map(async (release) => await release()));
    releaseMetadata();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(
        [...acquisitionFailures, ...failures],
        "Prepared plugin generation cleanup failed",
      );
    }
  });
  try {
    for (const registry of new Set([generation.pluginRegistry, generation.inboundPluginRegistry])) {
      const release = registry && retainRegistry(registry);
      if (release) {
        releases.push(release);
      }
    }
  } catch (error) {
    // The same terminal owner joins partial acquisition, including both failure causes.
    acquisitionFailures.push(error);
    void lifetime.close().catch(() => {});
    throw error;
  }
  generations.set(generation, lifetime);
  return lifetime;
}

export function retainPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): () => Promise<void> {
  const release = ownPreparedPluginGeneration(generation).retain();
  return async () => {
    await release();
  };
}

/** Publishing replaces one reference, while admitted leases retain their exact generation. */
export function publishPreparedPluginGeneration(
  owner: PreparedModelRuntimeOwner,
  generation: PreparedModelRuntimePluginGeneration,
): void {
  const previous = publications.get(owner);
  const instances = new Set(
    [generation.pluginRegistry, generation.inboundPluginRegistry].flatMap((registry) =>
      registry
        ? [...collectRegistryInvocationInstances(registry)].filter(
            (instance) => !instance.owner || instance.owner.record.status === "loaded",
          )
        : [],
    ),
  );
  const cacheSignal = getPluginCacheRetirementSignal(
    getPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot),
  );
  const isCurrent = () =>
    !cacheSignal.aborted && [...instances].every((instance) => instance.acceptingCalls);
  if (!isCurrent()) {
    throw new Error("Prepared plugin generation retired before publication");
  }
  const release = retainPreparedPluginGeneration(generation);
  const version = owner.generation;
  let signal: AbortSignal | undefined;
  const unsubscribe = () => signal?.removeEventListener("abort", observe);
  const observe = () => {
    unsubscribe();
    if (!isCurrent()) {
      // A cached publication cannot keep a closing Gateway's donor alive. Admitted
      // leases retain the same generation independently until their work finishes.
      if (owner.generation === version) {
        owner.generation++;
        owner.needsRefresh = true;
        owner.refreshError = new Error("Prepared model runtime plugin generation retired");
        owner.pluginGeneration = undefined;
      }
      releasePreparedPluginPublication(owner);
      return;
    }
    // Publication can transfer an unchanged instance before aborting its old registry
    // epoch. Follow its new owner so a later real retirement remains observable.
    signal = AbortSignal.any([
      cacheSignal,
      ...[...instances].flatMap((instance) => {
        const registry = instance.owner?.registry;
        const current =
          registry &&
          capturePluginRegistryLifecycleSignal(
            registry,
            capturePluginRegistryLifecycleEpoch(registry),
            { scopedRuntime: true },
          );
        return current ? [current] : [];
      }),
    ]);
    signal.addEventListener("abort", observe, { once: true });
  };
  publications.set(owner, {
    generation,
    release: () => {
      unsubscribe();
      return release();
    },
  });
  observe();
  void previous?.release()?.catch(() => {});
}

export function releasePreparedPluginPublication(owner: object): void {
  const previous = publications.get(owner);
  publications.delete(owner);
  void previous?.release()?.catch(() => {});
}

/** Failed unpublished builds release only their own generations, never a sibling's cache. */
export async function discardPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): Promise<void> {
  const lifetime = generations.get(generation);
  if (lifetime && !lifetime.referenced) {
    await lifetime.close();
  }
}

/** Process shutdown owns every outstanding generation and any earlier cleanup failure. */
async function closePreparedPluginGenerations(): Promise<void> {
  const resourcesClosed = Promise.allSettled([closeEphemeralPreparedModelRuntimeResources()]);
  const pending = new Set([...active].map((lifetime) => lifetime.close()));
  for (const completion of retirements) {
    pending.add(completion);
  }
  // Consume this observation before yielding; later retirements keep their own observer.
  for (const completion of pending) {
    retirements.delete(completion);
  }
  const results = await Promise.allSettled(pending);
  results.push(...(await resourcesClosed));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  let retained = failures.some(hasRetainedPluginRuntimeCloseError);
  try {
    await waitForPluginCacheRetirement(true);
  } catch (reason) {
    retained = true;
    failures.push(reason);
  }
  if (retained) {
    throw new AggregateError(failures, "Prepared plugin generations failed to close");
  }
  if (failures.length) {
    log.warn(
      formatErrorMessage(
        new AggregateError(failures, "Prepared plugin cleanup completed with failures"),
      ),
    );
  }
}
