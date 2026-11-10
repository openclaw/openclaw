// Signal plugin module implements monitor task runner behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

const SIGNAL_MONITOR_IDLE_TIMEOUT_MS = 30_000;

function createIdleTimeoutPromise(timeoutMs: number): {
  promise: Promise<"timeout">;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    timeoutId.unref?.();
  });
  return {
    promise,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

export function createSignalMonitorTaskRunner(runtime: RuntimeEnv) {
  const inFlight = new Set<Promise<void>>();
  let deliveryRetired = false;
  return {
    isDeliveryRetired(): boolean {
      return deliveryRetired;
    },
    runTask(task: () => Promise<void>): Promise<void> {
      const trackedTask = Promise.resolve().then(task);
      inFlight.add(trackedTask);
      void trackedTask.catch((err: unknown) =>
        runtime.error?.(`signal monitor task failed: ${String(err)}`),
      );
      void trackedTask.finally(() => inFlight.delete(trackedTask)).catch(() => undefined);
      return trackedTask;
    },
    async waitForIdle(): Promise<void> {
      // Must not block gateway stop on a hung attachment fetch or inbound turn.
      // Idle window, not wall-clock: keep waiting while tasks settle.
      while (inFlight.size > 0) {
        const snapshot = Array.from(inFlight);
        const timeout = createIdleTimeoutPromise(SIGNAL_MONITOR_IDLE_TIMEOUT_MS);
        const outcome = await Promise.race<"timeout" | "settled">([
          timeout.promise,
          ...snapshot.map((task) =>
            task.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
          ),
        ]);
        timeout.clear();
        if (outcome === "timeout") {
          // The replacement monitor can recover this claim. Do not let the
          // abandoned callback send after teardown gives up the drain.
          deliveryRetired = true;
          runtime.error?.(
            `signal waitForIdle made no progress within ${SIGNAL_MONITOR_IDLE_TIMEOUT_MS}ms; continuing teardown with ${inFlight.size} task(s) still in flight`,
          );
          return;
        }
      }
    },
  };
}

export async function waitForSignalMonitorTeardown(params: {
  runtime: RuntimeEnv;
  stopIngress?: () => Promise<void>;
  stopDaemon: () => Promise<void>;
  waitForIdle: () => Promise<void>;
}): Promise<void> {
  // Bound receive/reply drain with a progress-aware idle window. Do not put
  // observed daemon exit inside that window: a stuck signal-cli must keep the
  // monitor from reporting completion.
  //
  // Always join ingress-owner retirement after the task drain (or its idle
  // timeout). stop() awaits settlement-safe disposal; abandoning it leaves
  // claims owned by this instance and blocks same-process replacement recovery.
  // Propagate ingress-stop failures so settlement failures remain visible.
  await params.waitForIdle();
  if (params.stopIngress) {
    await params.stopIngress();
  }
  await params.stopDaemon();
}
