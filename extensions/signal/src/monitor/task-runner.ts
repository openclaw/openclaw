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
  return {
    runTask(task: () => Promise<void>): Promise<void> {
      const trackedTask = Promise.resolve().then(task);
      inFlight.add(trackedTask);
      void trackedTask.catch((err: unknown) =>
        runtime.error?.(`signal monitor task failed: ${String(err)}`),
      );
      void trackedTask.finally(() => inFlight.delete(trackedTask)).catch(() => undefined);
      return trackedTask;
    },
    async waitForIdle(extras: Iterable<Promise<unknown>> = []): Promise<void> {
      // Must not block gateway stop on a hung attachment fetch or inbound turn.
      // Idle window, not wall-clock: keep waiting while tasks or extras settle.
      const pendingExtras = new Set(
        [...extras].map((extra) =>
          Promise.resolve(extra).then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
      for (const extra of pendingExtras) {
        void extra.finally(() => {
          pendingExtras.delete(extra);
        });
      }
      while (inFlight.size > 0 || pendingExtras.size > 0) {
        const snapshot = Array.from(inFlight);
        const extraSnapshot = Array.from(pendingExtras);
        const timeout = createIdleTimeoutPromise(SIGNAL_MONITOR_IDLE_TIMEOUT_MS);
        const outcome = await Promise.race<"timeout" | "settled">([
          timeout.promise,
          ...snapshot.map((task) =>
            task.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
          ),
          ...extraSnapshot.map((extra) => extra.then(() => "settled" as const)),
        ]);
        timeout.clear();
        if (outcome === "timeout") {
          const remaining = inFlight.size;
          const ingressPending = pendingExtras.size > 0;
          runtime.error?.(
            ingressPending
              ? `signal waitForIdle made no progress within ${SIGNAL_MONITOR_IDLE_TIMEOUT_MS}ms; continuing teardown with ${remaining} task(s) still in flight and ingress stop pending`
              : `signal waitForIdle made no progress within ${SIGNAL_MONITOR_IDLE_TIMEOUT_MS}ms; continuing teardown with ${remaining} task(s) still in flight`,
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
  waitForIdle: (extras?: Iterable<Promise<unknown>>) => Promise<void>;
}): Promise<void> {
  // Bound receive/reply drain with a progress-aware idle window. Do not put
  // observed daemon exit inside that window: a stuck signal-cli must keep the
  // monitor from reporting completion. Drain before stopping the transport so
  // accepted sends can finish unless the operator already aborted.
  const ingressStop = params.stopIngress?.() ?? Promise.resolve();
  await params.waitForIdle([ingressStop]);
  await params.stopDaemon();
}
