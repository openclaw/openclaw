import type { PluginRegistry } from "../plugins/registry-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { capturePreparedModelRuntimeLifetime } from "./prepared-model-runtime.lifecycle.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeResourceClaim,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import {
  acquireAgentRuntimePluginRegistry,
  type AcquiredAgentRuntimePluginRegistry,
} from "./runtime-plugins.js";

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.ephemeralPreparedRegistryResources"),
  () => {
    const failures: unknown[] = [];
    return {
      views: new Set<PreparedRegistryResources>(),
      registries: new WeakMap<PluginRegistry, PreparedRegistryResources>(),
      generations: new WeakMap<PreparedModelRuntimePluginGeneration, PreparedRegistryResources>(),
      failures,
    };
  },
);

/** The original view stays authoritative until ordinary retirement or explicit process close. */
class PreparedRegistryResources {
  private readonly completion = createDeferredCore();
  private readonly releases = new Set<Promise<void>>();
  private claims = 0;
  private closed = false;
  private finishing = false;

  constructor(
    private readonly acquired: Extract<AcquiredAgentRuntimePluginRegistry, { resources: unknown }>,
  ) {
    state.views.add(this);
    state.registries.set(acquired.registry, this);
    void this.completion.promise.then(() => state.views.delete(this));
  }

  get primaryRegistry(): PluginRegistry {
    return this.acquired.primaryRegistry;
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error("Prepared plugin registry resources have been released");
    }
  }

  retain(): PreparedModelRuntimeResourceClaim {
    this.assertOpen();
    const claim = this.acquired.resources.retain();
    this.claims++;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.trackRelease(claim.release);
        this.claims--;
        if (this.claims === 0) {
          void this.close();
        }
      },
    };
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      // This revokes the original view now; physical claims still protect admitted work.
      this.trackRelease(this.acquired.releaseRegistry);
    }
    if (this.claims === 0 && !this.finishing) {
      this.finishing = true;
      // Copied donor callbacks keep their existing physical claim until actual work ends.
      this.trackRelease(this.acquired.releaseBorrowedSources);
      void (async () => {
        while (this.releases.size > 0) {
          await Promise.all(this.releases);
        }
        this.completion.resolve();
      })();
    }
    return this.completion.promise;
  }

  private trackRelease(release: () => Promise<void>): void {
    const operation = createDeferredCore();
    const pending = operation.promise
      .catch((error: unknown) => {
        state.failures.push(error);
      })
      .finally(() => this.releases.delete(pending));
    this.releases.add(pending);
    try {
      operation.resolve(release());
    } catch (error) {
      operation.reject(error);
    }
  }
}

/** Construction holds every exact registry until publication has taken its own claim. */
export class PreparedModelRuntimeBuildResources {
  private readonly claims = new Map<PreparedRegistryResources, PreparedModelRuntimeResourceClaim>();

  private retain(resources: PreparedRegistryResources | undefined): void {
    if (resources && !this.claims.has(resources)) {
      this.claims.set(resources, resources.retain());
    }
  }

  retainGeneration(generation: PreparedModelRuntimePluginGeneration | undefined): void {
    this.retain(generation && state.generations.get(generation));
  }

  async load(
    params: Parameters<typeof acquireAgentRuntimePluginRegistry>[0],
    onPrimaryRegistry: (registry: PluginRegistry) => void,
  ): Promise<PluginRegistry> {
    const assertLifetime = capturePreparedModelRuntimeLifetime();
    const acquired = await acquireAgentRuntimePluginRegistry(params);
    if ("resources" in acquired) {
      const resources = new PreparedRegistryResources(acquired);
      try {
        assertLifetime();
        this.retain(resources);
      } catch (error) {
        await resources.close();
        throw error;
      }
    } else {
      this.retain(state.registries.get(acquired.registry));
    }
    onPrimaryRegistry(
      state.registries.get(acquired.registry)?.primaryRegistry ?? acquired.primaryRegistry,
    );
    return acquired.registry;
  }

  bindGeneration(generation: PreparedModelRuntimePluginGeneration): void {
    const resources = generation.pluginRegistry && state.registries.get(generation.pluginRegistry);
    if (resources) {
      state.generations.set(generation, resources);
    }
  }

  release(): void {
    for (const claim of this.claims.values()) {
      claim.release();
    }
    this.claims.clear();
  }
}

export function retainPreparedModelRuntimeGenerationResources(
  generation: PreparedModelRuntimePluginGeneration | undefined,
): PreparedModelRuntimeResourceClaim | undefined {
  return generation && state.generations.get(generation)?.retain();
}

/** Borrow the immutable view's prepared owner, including its adopted donor registrations. */
export function retainPreparedModelRuntimeSnapshotResources(
  snapshot: Pick<PreparedModelRuntimeSnapshot, "pluginRegistry">,
): (PreparedModelRuntimeResourceClaim & { assertOpen: () => void }) | undefined {
  const resources = snapshot.pluginRegistry && state.registries.get(snapshot.pluginRegistry);
  if (!resources) {
    return undefined;
  }
  const claim = resources.retain();
  return { release: claim.release, assertOpen: () => resources.assertOpen() };
}

/** Fence owned views before joining builds or the callers that still hold physical claims. */
export function closeEphemeralPreparedModelRuntimeResources(): Promise<void> {
  return Promise.all([...state.views].map((view) => view.close())).then(() => {
    if (state.failures.length > 0) {
      throw new AggregateError(
        state.failures.splice(0),
        "Prepared plugin resources failed to close",
      );
    }
  });
}
