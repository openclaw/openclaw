import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import type {
  PluginRetainedReference,
  PluginRetentionReason,
  PluginWorkRelease,
} from "../plugins/plugin-instance.types.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { watchPluginReplacement } from "../plugins/plugin-replacement-watchers.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";

/**
 * Mark finite host custody without granting execution or joining instance disposal.
 * `onReplacementRequested` hears which held plugin a reload reserved; calling its
 * `yieldHold` releases this holder's work count on that plugin while it keeps the
 * rest of its custody.
 */
export function retainRuntimePluginWork(
  registries: Iterable<PluginRegistry>,
  reason: PluginRetentionReason = "unknown",
  onReplacementRequested?: (pluginId: string, yieldHold: () => void) => void,
): PluginWorkRelease {
  const releases: PluginWorkRelease[] = [];
  const release: PluginWorkRelease = Object.assign(
    () => releases.splice(0).forEach((close) => close()),
    {
      setCleanupState: (state: PluginRetainedReference["cleanupState"]) =>
        releases.forEach((close) => close.setCleanupState?.(state)),
    },
  );
  try {
    const instances = new Set<PluginInstanceHandle>();
    // A partial acquisition never owns physical resources; unwind before reporting refusal.
    for (const registry of registries) {
      for (const instance of collectRegistryInvocationInstances(registry)) {
        if (!instances.has(instance)) {
          const close = instance.retainWork(reason);
          releases.push(close);
          if (onReplacementRequested) {
            const unwatch = watchPluginReplacement(instance, () =>
              onReplacementRequested(instance.pluginId, close),
            );
            releases.push(() => {
              unwatch();
            });
          }
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
  releaseWork: PluginWorkRelease,
): Promise<void> {
  releaseWork.setCleanupState?.("pending");
  try {
    await release?.();
  } catch (error) {
    if (!hasRetainedPluginRuntimeCloseError(error)) {
      releaseWork();
    } else {
      releaseWork.setCleanupState?.("failed");
    }
    throw error;
  }
  releaseWork();
}
