import {
  runOutsideRemoteModelCatalogSnapshot,
  withRemoteModelCatalogSnapshot,
} from "../model-catalog/remote-overlay.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
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

type BorrowedRuntimeSnapshot = { snapshot: PreparedModelRuntimeSnapshot | undefined };

function readBorrowedRuntimeSnapshot(this: BorrowedRuntimeSnapshot) {
  return this.snapshot;
}

/** Native async resources retain the clearable borrow, never its caller's lexical context. */
export function createPreparedModelRuntimeSnapshotBorrow(snapshot: PreparedModelRuntimeSnapshot) {
  const borrowed: BorrowedRuntimeSnapshot = { snapshot };
  return {
    read: readBorrowedRuntimeSnapshot.bind(borrowed),
    close: () => {
      borrowed.snapshot = undefined;
    },
  };
}

/** Borrow authority closes before the retained generation begins asynchronous disposal. */
export function scopePreparedModelRuntimeLease(lease: PreparedModelRuntimeLease) {
  const borrow = createPreparedModelRuntimeSnapshotBorrow(lease.snapshot);
  let disposal: Promise<void> | undefined;
  return {
    ...lease,
    [Symbol.asyncDispose]() {
      borrow.close();
      return (disposal ??= lease[Symbol.asyncDispose]());
    },
    run<T>(run: () => T): T {
      if (borrow.read() === undefined) {
        throw new Error("Captured reply runtime lease is closed");
      }
      return lease.run(() =>
        withPreparedModelRuntimePluginGenerationScope(lease.pluginGeneration, run, borrow.read),
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
    preparedModelRuntimePluginGenerationScope.exit(() =>
      pluginInvocationContext.exit(() => pluginInstanceInvocation.exit(run)),
    ),
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
