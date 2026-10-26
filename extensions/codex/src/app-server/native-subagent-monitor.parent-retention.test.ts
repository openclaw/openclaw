import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createNativeSubagentAssignmentStore } from "./native-subagent-assignment-store.js";
import { createNativeSubagentCompletionCustodyFixture } from "./native-subagent-custody.test-support.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createCompletionScope,
  createRuntime,
  nativeCompletionNotification,
  notifyChildStarted,
  registerParent,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setupParentRetention(agentDir: string, releaseCustody = () => {}) {
  const client = createClient();
  const runtime = createRuntime();
  ensureCodexAppServerClientRuntime(client.client, { agentDir });
  await retainCodexAppServerLiveThread(client.client, "parent-thread");
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    retainParentThread: (threadId) => protectCodexAppServerLiveThread(client.client, threadId),
  });
  onTestFinished(async () => {
    await monitor.retireParent("parent-thread");
    await monitor.dispose();
    releaseCustody();
    client.close();
  });
  const releaseForResume = () =>
    releaseCodexBoundLiveThread({
      client: client.client,
      threadId: "parent-thread",
      lifecycleTiming: createCodexThreadLifecycleTimingTracker(false),
    });
  return { client, runtime, monitor, releaseForResume };
}

it("keeps an interrupted assignment resumable without pinning its restored parent", async () => {
  const identity = { kind: "session" as const, agentId: "main", sessionId: "parent-session" };
  const binding = {
    threadId: "parent-thread",
    cwd: "/workspace",
    appServerRuntimeFingerprint: "runtime",
  };
  const store = createCodexTestBindingStore();
  await store.mutate(identity, { kind: "set", binding });
  const historyOwner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    binding,
  });
  if (!historyOwner) {
    throw new Error("Expected a native history owner.");
  }
  const assignment = {
    runId: "codex-thread:child-thread",
    childThreadId: "child-thread",
    nativeTurnId: "interrupted-turn",
    nativeParentThreadId: binding.threadId,
    owner: historyOwner,
  };
  await store.mutate(
    identity,
    { kind: "record-native-subagent-assignment", owner: historyOwner, assignment },
    () => undefined,
  );
  const custody = createNativeSubagentCompletionCustodyFixture();
  const { client, runtime, monitor, releaseForResume } = await setupParentRetention(
    "/workspace/agent",
    () => custody.root.release(),
  );
  client.setThreadRead(
    "child-thread",
    threadRead({ turnId: "interrupted-turn", status: "interrupted", threadStatus: "notLoaded" }),
  );
  runtime.captureAgentHarnessCompletionCustody.mockImplementation(async () =>
    custody.root.retain(),
  );
  const parent = await monitor.registerParent({
    parentThreadId: binding.threadId,
    agentId: "main",
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    historyOwner,
    assignmentStore: createNativeSubagentAssignmentStore({
      bindingStore: store,
      readBinding: () => binding,
      identity,
      owner: historyOwner,
    }),
  });
  await parent.ready;
  await parent.unregister();
  await expect(releaseForResume()).resolves.toBe(true);
  expect(await store.readNativeSubagentAssignments?.(identity, historyOwner)).toEqual([assignment]);
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  await retainCodexAppServerLiveThread(client.client, binding.threadId);
  const continued = await registerParent(monitor, binding.threadId, "agent:main:main");
  await client.notify(turnStartedNotification("continued-turn"));
  await expect(releaseForResume()).rejects.toThrow("claimed by active work; stop it first");
  await client.notify(
    childTurnCompletedNotification({ turnId: "continued-turn", status: "interrupted" }),
  );
  await expect(releaseForResume()).resolves.toBe(true);
  expect(await store.readNativeSubagentAssignments?.(identity, historyOwner)).toHaveLength(1);
  await continued.unregister();
});

it("permits parent cold resume once every child is terminal, while preserving undelivered results", async () => {
  vi.useFakeTimers();
  const { client, runtime, monitor, releaseForResume } = await setupParentRetention(
    "/tmp/codex-parent-retention",
  );
  runtime.deliverAgentHarnessCompletion.mockResolvedValue({
    delivered: false,
    path: "direct",
    error: "requester temporarily unavailable",
  });
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await parent.unregister();

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
