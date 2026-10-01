import { AsyncLocalStorage } from "node:async_hooks";
import { capturePluginBackgroundContext } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

// The plugin entry loads this before Gateway turns are admitted, while managers
// load lazily. Background resources must not retain the turn that opens a
// manager or publishes a transcript update.
const runDetached = AsyncLocalStorage.snapshot();

export function createMemoryBackgroundContext(): <T>(run: () => T) => T {
  const runInPlugin = capturePluginBackgroundContext();
  // The snapshot clears turn-local stores; the instance supplies fresh plugin admission.
  return <T>(run: () => T): T => runDetached(() => runInPlugin(run));
}

export function runInMemoryCleanupContext<T>(run: () => T): T {
  // Cleanup must detach the caller without requesting new admission from a retiring owner.
  return runDetached(run);
}
