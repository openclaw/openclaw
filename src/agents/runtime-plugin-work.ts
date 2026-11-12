import { getPluginValueInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";

/** A turn owns only exact capabilities resolved or invoked during its lifetime. */
export function createRuntimePluginWork() {
  const instances = new Set<PluginInstanceHandle>();
  const releases: Array<() => void> = [];
  let closed = false;
  return {
    instances,
    retain(instance: PluginInstanceHandle) {
      if (closed) {
        throw new Error("Plugin execution custody has been released");
      }
      if (!instances.has(instance)) {
        releases.push(instance.retainWork());
        instances.add(instance);
      }
    },
    release() {
      closed = true;
      releases.splice(0).forEach((release) => release());
      instances.clear();
    },
  };
}

/** Retain callbacks selected now that can first execute during fallback or finalization. */
export function retainDeferredRuntimePluginCapabilities(
  registries: Iterable<PluginRegistry>,
  work: ReturnType<typeof createRuntimePluginWork>,
): void {
  for (const registry of registries) {
    for (const value of [
      ...registry.providers.map(({ provider }) => provider),
      ...registry.typedHooks.map(({ handler }) => handler),
      ...registry.legacyInternalHooks.map(({ handler }) => handler),
    ]) {
      const instance = getPluginValueInstance(value);
      if (instance) {
        work.retain(instance);
      }
    }
  }
}

/** Finite registry construction only; execution uses createRuntimePluginWork. */
export function retainRuntimePluginWork(registries: Iterable<PluginRegistry>): () => void {
  const work = createRuntimePluginWork();
  try {
    for (const registry of registries) {
      for (const instance of collectRegistryInvocationInstances(registry)) {
        work.retain(instance);
      }
    }
    return work.release;
  } catch (error) {
    work.release();
    throw error;
  }
}

/** Keep replacement blocked through physical cleanup, including retained cleanup failures. */
export async function releaseRuntimePluginWork(
  release: (() => void | Promise<void>) | undefined,
  releaseWork: () => void,
): Promise<void> {
  try {
    await release?.();
  } catch (error) {
    if (!hasRetainedPluginRuntimeCloseError(error)) {
      releaseWork();
    }
    throw error;
  }
  releaseWork();
}
