import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "../infra/net/fetch-guard.js";
import { PinnedDispatcherPool } from "../infra/net/pinned-dispatcher-pool.js";
import { setProviderTransportDispatcherPoolActive } from "./provider-runtime-lifecycle.js";

let activePool: PinnedDispatcherPool | undefined;

/** Reuse provider connections without exposing their lifecycle-owned pool to callers. */
export function fetchWithProviderHttpGuard(
  options: Omit<GuardedFetchOptions, "dispatcherPool">,
): Promise<GuardedFetchResult> {
  return fetchWithSsrFGuard({
    ...options,
    dispatcherPool: getProviderTransportDispatcherPool(),
  });
}

/** Returns the current process-lifecycle provider dispatcher pool generation. */
function getProviderTransportDispatcherPool(): PinnedDispatcherPool {
  if (!activePool) {
    activePool = new PinnedDispatcherPool();
    setProviderTransportDispatcherPoolActive(true);
  }
  return activePool;
}

/** Closes the current generation while allowing an in-process Gateway restart to create another. */
export async function closeProviderTransportDispatcherPool(): Promise<void> {
  const pool = activePool;
  if (pool) {
    await pool.closeAll();
    if (activePool === pool) {
      activePool = undefined;
      setProviderTransportDispatcherPoolActive(false);
    }
  }
}
