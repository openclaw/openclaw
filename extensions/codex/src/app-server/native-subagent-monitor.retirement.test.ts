import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  closeAgentNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";

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
      const claimChildThread = vi.fn(async () => {});
      const releaseChildThread = vi.fn(async () => {});
      onTestFinished(() => capture.resolve(forget));
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        captureChildThreadForget,
        claimChildThread,
        releaseChildThread,
      });
      const parent = await registerParent(monitor);
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client);
      expect(claimChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");

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
          expect(confirmationSettled).toBe(false);
        }
        retirement = monitor.retireParent("parent-thread");
        await retirement;
        expect(releaseChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        expect(confirmationSettled).toBe(false);
        capture.resolve(forget);
        if (confirmation) {
          await confirmation;
        } else {
          await client.notify(closeAgentNotification({ method: "item/completed" }));
        }
        expect(claimChildThread).toHaveBeenCalledOnce();
        expect(releaseChildThread).toHaveBeenCalledOnce();
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
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
