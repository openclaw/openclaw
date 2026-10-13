import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";

/** Mark finite host custody without granting execution or joining instance disposal. */
export function retainRuntimePluginWork(registries: Iterable<PluginRegistry>): () => void {
  const releases: Array<() => void> = [];
  const release = () => releases.splice(0).forEach((close) => close());
  try {
    const instances = new Set<PluginInstanceHandle>();
    // A partial acquisition never owns physical resources; unwind before reporting refusal.
    for (const registry of registries) {
      for (const instance of collectRegistryInvocationInstances(registry)) {
        if (!instances.has(instance)) {
          releases.push(instance.retainWork());
          instances.add(instance);
        }
      }
    }
    return release;
  } catch (error) {
    release();
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
