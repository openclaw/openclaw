import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  closeAgentNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";
import { withTimeout } from "./timeout.js";

describe("Codex native parent retirement", () => {
  it.each([false, true])(
    "retires the parent during capture without stale close effects (completed=%s)",
    async (completed) => {
      const client = createClient();
      client.setLoadedThreads([]);
      const runtime = createRuntime();
      const forget = vi.fn();
      const capture = createDeferred<() => void>();
      const captureChildThreadForget = vi.fn(() => capture.promise);
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        captureChildThreadForget,
      });
      const parent = await registerParent(monitor);
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client);

      let confirmation: Promise<void> | undefined;
      let retirement: Promise<void> | undefined;
      let confirmationSettled = false;
      try {
        await client.notify(closeAgentNotification({ method: "item/started" }));
        expect(captureChildThreadForget).toHaveBeenCalledOnce();
        if (completed) {
          confirmation = client
            .notify(closeAgentNotification({ method: "item/completed" }))
            .then(() => {
              confirmationSettled = true;
            });
          await setImmediate();
          expect(confirmationSettled).toBe(false);
        }
        retirement = monitor.retireParent("parent-thread");
        await withTimeout(retirement, 5_000, "parent retirement waited for native close capture");
        expect(runtime.listTaskRecords()).toEqual([
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            status: "cancelled",
            terminalSummary: "Subagent parent session ended.",
          }),
        ]);
        expect(confirmationSettled).toBe(false);
        const finalizationsAfterRetirement = [...runtime.finalizeTaskRunByRunId.mock.calls];
        capture.resolve(forget);
        if (confirmation) {
          await confirmation;
        } else {
          await client.notify(closeAgentNotification({ method: "item/completed" }));
        }
        expect(runtime.finalizeTaskRunByRunId.mock.calls).toEqual(finalizationsAfterRetirement);
        expect(forget).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalled();
      } finally {
        capture.resolve(forget);
        await Promise.allSettled([confirmation, retirement]);
        await parent.unregister();
        await monitor.dispose();
      }
    },
  );
});
