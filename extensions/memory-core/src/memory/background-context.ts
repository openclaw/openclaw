import { AsyncLocalStorage } from "node:async_hooks";
import { runOutsidePluginRuntimeGenerationScope } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

// The plugin entry loads this before Gateway turns are admitted, while managers
// load lazily. Background resources must not retain the turn that opens a
// manager or publishes a transcript update.
const runInTurnFreeContext = AsyncLocalStorage.snapshot();

/**
 * Runs memory background work (watcher, interval, startup catch-up, transcript
 * updates) outside the turn that opened the manager and outside the plugin
 * generation that loaded this module.
 *
 * The snapshot above also captures that generation's registry selection, and a
 * bundled module outlives it: `openclaw plugins reload <embedding provider>`
 * or an in-process Gateway restart retires the generation while managers keep
 * running, so background syncs would keep resolving the retired provider
 * instance (`PluginInstanceUnavailableError`) until the process restarts.
 * Dropping the captured generation lets each callback resolve plugins from the
 * live registry, as foreground search already does.
 */
export function runInMemoryBackgroundContext<R, TArgs extends unknown[]>(
  fn: (...args: TArgs) => R,
  ...args: TArgs
): R {
  return runInTurnFreeContext(() => runOutsidePluginRuntimeGenerationScope(() => fn(...args)));
}
