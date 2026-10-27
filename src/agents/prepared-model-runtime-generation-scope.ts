import {
  runOutsideRemoteModelCatalogSnapshot,
  withRemoteModelCatalogSnapshot,
} from "../model-catalog/remote-overlay.js";
import { AsyncContext } from "../shared/async-context.js";
import type {
  PreparedModelRuntimeLease,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeGenerationScope = Readonly<{
  generation: PreparedModelRuntimePluginGeneration;
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined;
}>;

const preparedModelRuntimePluginGenerationScope =
  new AsyncContext<PreparedModelRuntimeGenerationScope>(
    Symbol.for("openclaw.preparedModelRuntimePluginGenerationScope"),
  );

/** Borrow authority closes before the retained generation begins asynchronous disposal. */
export function scopePreparedModelRuntimeLease(lease: PreparedModelRuntimeLease) {
  let open = true;
  let disposal: Promise<void> | undefined;
  return {
    ...lease,
    [Symbol.asyncDispose]() {
      open = false;
      return (disposal ??= lease[Symbol.asyncDispose]());
    },
    run<T>(run: () => T): T {
      if (!open) {
        throw new Error("Captured reply runtime lease is closed");
      }
      return withPreparedModelRuntimePluginGenerationScope(lease.pluginGeneration, run, () =>
        open ? lease.snapshot : undefined,
      );
    },
  };
}

/** Keeps the exact admitted generation available to nested embedded agent runs. */
export function withPreparedModelRuntimePluginGenerationScope<T>(
  generation: PreparedModelRuntimePluginGeneration,
  run: () => T,
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined,
): T {
  const inherited = preparedModelRuntimePluginGenerationScope.getStore();
  const borrow =
    borrowSnapshot ?? (inherited?.generation === generation ? inherited.borrowSnapshot : undefined);
  return withRemoteModelCatalogSnapshot(generation.remoteCatalog, () =>
    preparedModelRuntimePluginGenerationScope.run(
      { generation, ...(borrow ? { borrowSnapshot: borrow } : {}) },
      run,
    ),
  );
}

/** Detached queue drains re-admit on the current generation, never a predecessor's scope. */
export function runOutsidePreparedModelRuntimePluginGenerationScope<T>(run: () => T): T {
  return runOutsideRemoteModelCatalogSnapshot(() =>
    preparedModelRuntimePluginGenerationScope.exit(run),
  );
}

/** Exact admitted generation active for nested prepared model-runtime acquisition. */
export function getPreparedModelRuntimePluginGeneration():
  | PreparedModelRuntimePluginGeneration
  | undefined {
  return preparedModelRuntimePluginGenerationScope.getStore()?.generation;
}

/** Borrows the exact parent snapshot only while its owning turn lease remains open. */
export function getPreparedModelRuntimeBorrowedSnapshot(
  generation: PreparedModelRuntimePluginGeneration,
): PreparedModelRuntimeSnapshot | undefined {
  const current = preparedModelRuntimePluginGenerationScope.getStore();
  return current?.generation === generation ? current.borrowSnapshot?.() : undefined;
}
