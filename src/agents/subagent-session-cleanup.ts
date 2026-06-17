/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { resolveSessionCleanupCandidateAge } from "../config/sessions/maintenance-age.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type CallGateway = typeof defaultCallGateway;

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(params: {
  callGateway: CallGateway;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  nowMs?: number;
  onError?: (error: unknown) => void;
}): Promise<boolean> {
  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[params.childSessionKey];
  if (entry) {
    const age = resolveSessionCleanupCandidateAge({
      entry,
      nowMs: params.nowMs,
    });
    if (!age.eligible) {
      return false;
    }
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
    return true;
  } catch (error) {
    params.onError?.(error);
    return false;
  }
}
