/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type CallGateway = typeof defaultCallGateway;

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(params: {
  callGateway: CallGateway;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const { hasLiveOrRecentlyDispatchedContinuationWork } =
    await import("../auto-reply/continuation/work-store.js");
  // A continuation_work TaskFlow is the owner of same-session re-entry. Keep
  // the child session entry until the durable work wake has had a chance to
  // route back into that exact session; otherwise continue_delegate children
  // that call continue_work become ghost wakes.
  if (hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey)) {
    return;
  }
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
