import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  registerDetachedChild,
  nativeCompletionNotification,
} from "./native-subagent-monitor.test-support.js";

describe("native completion custody and host recovery", () => {
  it("releases blocked completion ownership without polling", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const successorClient = createClient();
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryBlocked: true,
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
      const successorRuntime = createRuntime();
      const successor = new CodexNativeSubagentMonitor(successorClient as never, successorRuntime);
      await registerDetachedChild(successorClient, successor);
      await successorClient.notify(nativeCompletionNotification());
      expect(successorRuntime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      successorClient.close();
      vi.useRealTimers();
    }
  });

  it("does not exhaust delivery retries while the host recovery owns completion", async () => {
    vi.useFakeTimers();
    const client = createClient();
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryPending: true,
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());
      await vi.advanceTimersByTimeAsync(50);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(6);
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(50);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(7);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });
});
