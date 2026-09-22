import type { PluginRegistry } from "../plugins/registry-types.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
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
  () => ({
    views: new Set<PreparedRegistryResources>(),
    registries: new WeakMap<PluginRegistry, PreparedRegistryResources>(),
  }),
);

/** The original view stays authoritative until ordinary retirement or explicit process close. */
class PreparedRegistryResources {
  private readonly completion = createDeferredCore();
  private readonly releases = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private claims = 0;
  private closed = false;
  private finishing = false;

  constructor(
    private readonly acquired: Extract<AcquiredAgentRuntimePluginRegistry, { resources: unknown }>,
  ) {
    state.views.add(this);
    state.registries.set(acquired.registry, this);
    void this.completion.promise.then(
      () => state.views.delete(this),
      () => {},
    );
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
    let release: Promise<void> | undefined;
    return {
      release: () => {
        if (!release) {
          const completion = createDeferredCore();
          release = completion.promise;
          const pending = this.trackRelease(claim.release);
          this.claims--;
          // The final generation lease joins original-view and donor cleanup as well.
          void (this.claims === 0 ? this.close() : pending).then(
            completion.resolve,
            completion.reject,
          );
        }
        return release;
      },
    };
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      // This revokes the original view now; physical claims still protect admitted work.
      void this.trackRelease(this.acquired.releaseRegistry);
    }
    if (this.claims === 0 && !this.finishing) {
      this.finishing = true;
      void (async () => {
        while (this.releases.size > 0) {
          await Promise.all(this.releases);
        }
        if (this.failures.length > 0) {
          this.completion.reject(
            new AggregateError(this.failures, "Prepared plugin resources failed to close"),
          );
        } else {
          this.completion.resolve();
        }
      })();
    }
    return this.completion.promise;
  }

  private trackRelease(release: () => Promise<void>): Promise<void> {
    const operation = createDeferredCore();
    const pending = operation.promise
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => this.releases.delete(pending));
    this.releases.add(pending);
    try {
      operation.resolve(release());
    } catch (error) {
      operation.reject(error);
    }
    return pending;
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
    for (const registry of [generation?.pluginRegistry, generation?.inboundPluginRegistry]) {
      this.retain(registry && state.registries.get(registry));
    }
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

  async [Symbol.asyncDispose](): Promise<void> {
    const claims = [...this.claims.values()];
    this.claims.clear();
    const results = await Promise.allSettled(claims.map((claim) => claim.release()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Prepared registry construction cleanup failed");
    }
  }
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
export async function closeEphemeralPreparedModelRuntimeResources(): Promise<void> {
  const results = await Promise.allSettled(
    [...state.views].map(async (view) => {
      try {
        await view.close();
      } catch (error) {
        // Completed faults are observed once; required prerequisites still own their resources.
        if (hasRetainedPluginRuntimeCloseError(error) || state.views.delete(view)) {
          throw error;
        }
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Prepared plugin resources failed to close");
  }
}
