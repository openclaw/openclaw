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
