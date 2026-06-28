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
  const { hasLiveOrRecentlyDispatchedContinuationWork } =
    await import("../auto-reply/continuation/work-store.js");
  // A continuation_work TaskFlow is the owner of same-session re-entry. Keep
  // the child session entry until the durable work wake drains, then retry so
  // delete-mode child sessions do not leak after cleanup bookkeeping finishes.
  if (hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey)) {
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
