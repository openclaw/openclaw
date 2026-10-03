// Whatsapp plugin module implements last-route teardown drain.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";

const BACKGROUND_TASKS_TEARDOWN_TIMEOUT_MS = 15_000;

type BackgroundTasksWaitResult = "drained" | "timed_out";

const connectionControllerLog = getChildLogger({ module: "whatsapp-connection" });

async function waitForBackgroundTasksWithTimeout(
  backgroundTasks: Set<Promise<unknown>>,
  timeoutMs = BACKGROUND_TASKS_TEARDOWN_TIMEOUT_MS,
): Promise<BackgroundTasksWaitResult> {
  if (backgroundTasks.size === 0) {
    return "drained";
  }

  const boundedTimeoutMs = resolveTimerTimeoutMs(
    timeoutMs,
    BACKGROUND_TASKS_TEARDOWN_TIMEOUT_MS,
    0,
  );
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    Promise.allSettled(backgroundTasks).then(() => "drained" as const),
    new Promise<BackgroundTasksWaitResult>((resolve) => {
      flushTimeout = setTimeout(() => resolve("timed_out"), boundedTimeoutMs);
    }),
  ]).finally(() => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
  });
}

export async function drainBackgroundTasksForTeardown(
  backgroundTasks: Set<Promise<unknown>>,
): Promise<void> {
  if (backgroundTasks.size === 0) {
    return;
  }
  const waitResult = await waitForBackgroundTasksWithTimeout(
    backgroundTasks,
    BACKGROUND_TASKS_TEARDOWN_TIMEOUT_MS,
  );
  if (waitResult !== "drained") {
    connectionControllerLog.warn(
      {
        remaining: backgroundTasks.size,
        timeoutMs: BACKGROUND_TASKS_TEARDOWN_TIMEOUT_MS,
        reason: waitResult,
      },
      "WhatsApp last-route writes did not finish before connection teardown; continuing close",
    );
  }
  backgroundTasks.clear();
}
