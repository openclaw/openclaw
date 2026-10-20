import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  nativeCompletionNotification,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("permits parent cold resume once every child is terminal, while preserving undelivered results", async () => {
  vi.useFakeTimers();
  const client = createClient();
  const runtime = createRuntime();
  runtime.deliverAgentHarnessCompletion.mockResolvedValue({
    delivered: false,
    path: "direct",
    error: "requester temporarily unavailable",
  });
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/codex-parent-retention" });
  await retainCodexAppServerLiveThread(client.client, "parent-thread");
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    retainParentThread: (threadId) => protectCodexAppServerLiveThread(client.client, threadId),
    recoveryPollDelaysMs: [],
  });
  onTestFinished(async () => {
    await monitor.retireParent("parent-thread");
    await monitor.dispose();
    client.close();
  });
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await parent.unregister();
  const releaseForResume = () =>
    releaseCodexBoundLiveThread({
      client: client.client,
      threadId: "parent-thread",
      lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
    });

  await client.notify(
    nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
  );
  // A still-running sibling requires the native parent subscription to remain alive.
  await expect(releaseForResume()).rejects.toThrow("claimed by active work; stop it first");
  expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);

  await client.notify(
    nativeCompletionNotification({ agentPath: "child-b", result: "second result" }),
  );
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
  await expect(releaseForResume()).resolves.toBe(true);
  expect(client.request).toHaveBeenCalledWith(
    "thread/unsubscribe",
    { threadId: "parent-thread" },
    expect.anything(),
  );
  const continued = await registerParent(monitor);
  expect(continued.listPendingChildren().map(({ state }) => state)).toEqual([
    "completing",
    "completing",
  ]);

  runtime.deliverAgentHarnessCompletion.mockResolvedValue({ delivered: true, path: "direct" });
  await continued.unregister();
  await vi.advanceTimersByTimeAsync(5_000);
  const settled = await registerParent(monitor);
  expect(settled.listPendingChildren()).toEqual([]);
  await settled.unregister();
  expect(
    runtime.deliverAgentHarnessCompletion.mock.calls.map(([request]) => request.result),
  ).toEqual(["first result", "second result", "first result", "second result"]);
});
