import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type ReloadChange = Parameters<NonNullable<MemoryPluginRuntime["prepareReload"]>>[0];
type ReloadHandle = ReturnType<NonNullable<MemoryPluginRuntime["prepareReload"]>>;
export type MemoryReloadState = {
  retireRuntime: boolean;
  adapters: Set<MemoryEmbeddingProviderAdapter>;
  generation: number;
};
export type MemoryManagerLifecycle = {
  reload?: MemoryReloadState;
  prepare?: (reload: MemoryReloadState) => ReloadHandle["drain"];
};

const lifecycleStore = createPluginRuntimeStore<MemoryManagerLifecycle>({
  key: "memory-core:manager-lifecycle",
  errorMessage: "Memory manager lifecycle is not initialized",
});

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

/** Fence acquisition even before the lazy manager module has loaded. */
export function prepareMemoryManagerReload(
  change: ReloadChange,
  lifecycle = getMemoryManagerLifecycle(),
): ReloadHandle {
  const reload = lifecycle.reload ?? {
    retireRuntime: false,
    adapters: new Set<MemoryEmbeddingProviderAdapter>(),
    generation: 0,
  };
  reload.retireRuntime ||= change.retireRuntime;
  for (const adapter of change.retiringEmbeddingProviders) {
    reload.adapters.add(adapter);
  }
  const generation = ++reload.generation;
  lifecycle.reload = reload;
  const drain = lifecycle.prepare?.(reload) ?? (async () => ({ errors: [] }));
  return {
    drain,
    resume() {
      if (lifecycle.reload === reload && generation === reload.generation) {
        lifecycle.reload = undefined;
      }
    },
  };
}
