import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getAcpSessionManager } from "./manager.js";

const DEFAULT_ACP_RUNTIME_CLOSE_TIMEOUT_MS = 15_000;

export type CloseAcpSessionRuntimeParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  /** Session store entry; ACP cleanup is skipped when it has no `.acp` metadata. */
  entry?: Pick<SessionEntry, "acp">;
  /** Free-form reason recorded by the ACP manager (e.g. "subagent-kill"). */
  reason: string;
  /** Discard persisted ACP backend state. Defaults to true (terminal close). */
  discardPersistentState?: boolean;
  /** Clear the OpenClaw `.acp` session metadata. Defaults to true (terminal close). */
  clearMeta?: boolean;
  /** Per-step timeout so a wedged ACP backend can never block the caller. */
  timeoutMs?: number;
};

export type AcpRuntimeCloseOutcome = {
  /** False when the entry had no ACP metadata and no cleanup was attempted. */
  attempted: boolean;
  runtimeClosed: boolean;
  metaCleared: boolean;
  cancelTimedOut: boolean;
  closeTimedOut: boolean;
  errors: unknown[];
};

type TimeoutResult = { status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown };

async function runWithTimeout(op: () => Promise<void>, timeoutMs: number): Promise<TimeoutResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const opPromise = op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race<TimeoutResult>([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

/**
 * Terminally close the ACP runtime backing a session: cancel any in-flight turn,
 * then close the backend session and (by default) discard persisted state and
 * clear `.acp` metadata. Each step is timeout-guarded and never throws, so kill
 * and other best-effort callers cannot hang or fail because the ACP backend is
 * unresponsive. No-op when the entry has no `.acp` metadata.
 *
 * This is the kill/terminate counterpart to the reset path's reuse-oriented
 * cleanup (which re-arms the session for a fresh turn); here the session is
 * being torn down, so it must not be left in a resumable/running state.
 */
export async function closeAcpSessionRuntime(
  params: CloseAcpSessionRuntimeParams,
): Promise<AcpRuntimeCloseOutcome> {
  const outcome: AcpRuntimeCloseOutcome = {
    attempted: false,
    runtimeClosed: false,
    metaCleared: false,
    cancelTimedOut: false,
    closeTimedOut: false,
    errors: [],
  };
  if (!params.entry?.acp) {
    return outcome;
  }
  outcome.attempted = true;
  const timeoutMs = params.timeoutMs ?? DEFAULT_ACP_RUNTIME_CLOSE_TIMEOUT_MS;
  const manager = getAcpSessionManager();

  const cancel = await runWithTimeout(
    () =>
      manager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      }),
    timeoutMs,
  );
  if (cancel.status === "timeout") {
    outcome.cancelTimedOut = true;
    logVerbose(`acp close (${params.reason}): cancel timed out for ${params.sessionKey}`);
  } else if (cancel.status === "error") {
    outcome.errors.push(cancel.error);
    logVerbose(
      `acp close (${params.reason}): cancel failed for ${params.sessionKey}: ${String(cancel.error)}`,
    );
  }

  const close = await runWithTimeout(async () => {
    const result = await manager.closeSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      reason: params.reason,
      discardPersistentState: params.discardPersistentState ?? true,
      clearMeta: params.clearMeta ?? true,
      requireAcpSession: false,
      allowBackendUnavailable: true,
    });
    outcome.runtimeClosed = result.runtimeClosed;
    outcome.metaCleared = result.metaCleared;
  }, timeoutMs);
  if (close.status === "timeout") {
    outcome.closeTimedOut = true;
    logVerbose(`acp close (${params.reason}): close timed out for ${params.sessionKey}`);
  } else if (close.status === "error") {
    outcome.errors.push(close.error);
    logVerbose(
      `acp close (${params.reason}): close failed for ${params.sessionKey}: ${String(close.error)}`,
    );
  }

  return outcome;
}
