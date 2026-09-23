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
import { releaseRuntimePluginWork, retainRuntimePluginWork } from "./runtime-plugin-work.js";
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

/** Batch scopes retain selected sources through later catalog work; idle publication owns custody only. */
export class PreparedModelRuntimeBuildResources {
  private readonly registries = new Set<PluginRegistry>();
  private readonly releases = new AsyncDisposableStack();

  constructor(
    private readonly retainPhysicalRegistry: (
      registry: PluginRegistry,
    ) => (() => void | Promise<void>) | undefined,
  ) {}

  private assertOpen(): void {
    if (this.releases.disposed) {
      throw new Error("Prepared registry construction resources have been released");
    }
  }

  retainRegistry(registry: PluginRegistry): void {
    this.assertOpen();
    if (this.registries.has(registry)) {
      return;
    }
    const release = this.retainPhysicalRegistry(registry);
    let releaseWork = () => {};
    let completion: Promise<void> | undefined;
    const releaseClaim = () => (completion ??= releaseRuntimePluginWork(release, releaseWork));
    // External registry owners keep physical custody, but construction still owns finite work.
    this.releases.defer(releaseClaim);
    try {
      releaseWork = retainRuntimePluginWork([registry]);
    } catch (error) {
      // Acquisition cleanup may wait for this claim; start it now and let the stack join it.
      void releaseClaim().catch(() => {});
      throw error;
    }
    this.registries.add(registry);
  }

  retainGeneration(generation: PreparedModelRuntimePluginGeneration | undefined): void {
    for (const registry of [generation?.pluginRegistry, generation?.inboundPluginRegistry]) {
      if (registry) {
        this.retainRegistry(registry);
      }
    }
  }

  async load(
    params: Parameters<typeof acquireAgentRuntimePluginRegistry>[0],
    onPrimaryRegistry: (registry: PluginRegistry) => void,
  ): Promise<PluginRegistry> {
    this.assertOpen();
    const assertLifetime = capturePreparedModelRuntimeLifetime();
    const acquired = await acquireAgentRuntimePluginRegistry(params);
    if ("resources" in acquired) {
      const resources = new PreparedRegistryResources(acquired);
      try {
        assertLifetime();
        this.retainRegistry(acquired.registry);
        // The build claim now owns finite work before producer custody crosses another await.
        acquired.releaseWork();
      } catch (error) {
        await releaseRuntimePluginWork(() => resources.close(), acquired.releaseWork);
        throw error;
      }
    } else {
      this.retainRegistry(acquired.registry);
    }
    onPrimaryRegistry(
      state.registries.get(acquired.registry)?.primaryRegistry ?? acquired.primaryRegistry,
    );
    return acquired.registry;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.registries.clear();
    return this.releases.disposeAsync();
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
