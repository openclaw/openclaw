/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type CallGateway = typeof defaultCallGateway;

const DEFERRED_SESSION_CLEANUP_RETRY_MS = 5_000;
const cleanupRetryTimers = new Map<string, NodeJS.Timeout>();

type DeleteSubagentSessionForCleanupParams = {
  callGateway: CallGateway;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  onError?: (error: unknown) => void;
};

function clearDeferredCleanupRetry(childSessionKey: string): void {
  const existing = cleanupRetryTimers.get(childSessionKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  cleanupRetryTimers.delete(childSessionKey);
}

function scheduleDeferredCleanupRetry(params: DeleteSubagentSessionForCleanupParams): void {
  if (cleanupRetryTimers.has(params.childSessionKey)) {
    return;
  }
  const handle = setTimeout(() => {
    cleanupRetryTimers.delete(params.childSessionKey);
    void deleteSubagentSessionForCleanup(params);
  }, DEFERRED_SESSION_CLEANUP_RETRY_MS);
  handle.unref();
  cleanupRetryTimers.set(params.childSessionKey, handle);
}

export function resetSubagentSessionCleanupForTests(): void {
  for (const handle of cleanupRetryTimers.values()) {
    clearTimeout(handle);
  }
  cleanupRetryTimers.clear();
}

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(
  params: DeleteSubagentSessionForCleanupParams,
): Promise<void> {
  const [{ hasLiveOrRecentlyDispatchedContinuationWork }, { hasRecoverablePendingDelegate }] =
    await Promise.all([
      import("../auto-reply/continuation/work-store.js"),
      import("../auto-reply/continuation/delegate-store.js"),
    ]);
  // A continuation_work TaskFlow or an in-flight continuation delegate owns
  // same-session re-entry. Keep the child session entry until they drain, then
  // retry, so delete-mode child sessions do not leak after cleanup bookkeeping
  // finishes AND a delayed bracket/tool delegate does not lose the child's
  // chain/requester state to deletion before it finishes. The delegate gate must
  // count queued AND `running` (claimed) flows: the dispatcher/hedge claims a
  // delegate to `running` before `spawnSubagentDirect` completes, so a
  // queued-only count would drop to 0 mid-dispatch and let this cleanup delete
  // the child out from under the running delegate (#1144).
  if (
    hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey) ||
    hasRecoverablePendingDelegate(params.childSessionKey)
  ) {
    scheduleDeferredCleanupRetry(params);
    return;
  }
  clearDeferredCleanupRetry(params.childSessionKey);
  try {
    await params.callGateway({
      method: "sessions.delete",
      params: {
        key: params.childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: params.spawnMode === "session",
      },
      timeoutMs: 10_000,
    });
  } catch (error) {
    params.onError?.(error);
  }
}
