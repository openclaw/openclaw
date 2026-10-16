import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { NativeSubagentMonitorClient } from "./native-subagent-monitor-types.js";

/** Bound pending registration and turn discovery by Stop's shared native deadline. */
export async function waitForNativeCancellationWork<T>(
  client: NativeSubagentMonitorClient,
  work: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new Error("Codex descendant cancellation did not settle before its deadline");
  }
  const interrupted = createDeferred<never>();
  const timer = setTimeout(
    () =>
      interrupted.reject(
        new Error("Codex descendant cancellation did not settle before its deadline"),
      ),
    remaining,
  );
  const releaseClose = client.addCloseHandler(() =>
    interrupted.reject(new Error("Codex client closed during descendant cancellation")),
  );
  try {
    return await Promise.race([work, interrupted.promise]);
  } finally {
    clearTimeout(timer);
    releaseClose();
  }
}
