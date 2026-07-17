import { logWarn } from "../logger.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";

type SandboxExecFinalizer = (params: {
  status: "completed" | "failed";
  exitCode: number | null;
  timedOut: boolean;
}) => Promise<void>;

export function resolveExecTimeoutMs(timeoutSec: number | null | undefined): number | undefined {
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return undefined;
  }
  return resolveSafeTimeoutDelayMs(timeoutSec * 1000);
}

/** Fences delayed exec preparation and releases any backend resource it created. */
export async function assertExecMaySpawn(
  signal: AbortSignal | undefined,
  finalizeSandboxExec?: SandboxExecFinalizer,
): Promise<void> {
  if (!signal?.aborted) {
    return;
  }
  await finalizeSandboxExec?.({ status: "failed", exitCode: null, timedOut: false }).catch(
    (error: unknown) => {
      logWarn(`exec: sandbox finalize after abort-before-spawn failed (${String(error)}).`);
    },
  );
  signal.throwIfAborted();
}
