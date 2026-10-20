import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type ReloadChange = Parameters<NonNullable<MemoryPluginRuntime["prepareReload"]>>[0];
type ReloadHandle = ReturnType<NonNullable<MemoryPluginRuntime["prepareReload"]>>;
export type MemoryReloadState = {
  retireRuntime: boolean;
  adapters: Set<MemoryEmbeddingProviderAdapter>;
};
export type MemoryManagerLifecycle = {
  reload?: MemoryReloadState;
  prepare?: (reload: MemoryReloadState) => ReloadHandle["drain"];
};

const lifecycleStore = createPluginRuntimeStore<MemoryManagerLifecycle>({
  key: "memory-core:manager-lifecycle",
  errorMessage: "Memory manager lifecycle is not initialized",
});

// Process-wide: a replacement instance loads its own module graph but must see
// that its predecessor ran watched indexing. A Gateway restart starts cold again.
const liveIndexing = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryCore.liveIndexing"),
  () => ({ started: false }),
  (state) => {
    state.started = false;
  },
  "close-and-restart",
);

/** Records that a watched index manager ran in this process. */
export function markMemoryIndexingLive(): void {
  liveIndexing.started = true;
}

export function hasMemoryIndexingBeenLive(): boolean {
  return liveIndexing.started;
}

export class MemoryManagerReloadError extends Error {
  constructor() {
    super("Memory provider is reloading; retry after the plugin operation completes.");
  }
}

export function getMemoryManagerLifecycle(): MemoryManagerLifecycle {
  let lifecycle = lifecycleStore.tryGetRuntime();
  if (!lifecycle) {
    lifecycle = {};
    lifecycleStore.setRuntime(lifecycle);
  }
  return lifecycle;
}

/** Pause new acquisition while the plugin owner replaces its adapters. */
export function prepareMemoryManagerReload(
  change: ReloadChange,
  lifecycle = getMemoryManagerLifecycle(),
): ReloadHandle {
  const reload = {
    retireRuntime: change.retireRuntime,
    adapters: new Set(change.retiringEmbeddingProviders),
  };
  lifecycle.reload = reload;
  const drain = lifecycle.prepare?.(reload) ?? (async () => ({ errors: [] }));
  return {
    drain,
    resume() {
      lifecycle.reload = undefined;
    },
  };
}
