import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasIdleCodexThread,
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
  observeCompletionAttempts,
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

it("promptly delivers a waiting completion when the last sibling is interrupted", async () => {
  vi.useFakeTimers();
  const attempts = observeCompletionAttempts();
  const { client, runtime, monitor } = await setupParentRetention(
    "/tmp/codex-interrupted-sibling",
    () => {},
    false,
  );
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await notifyChildStarted(client, "parent-thread", "child-c");
  await client.notify(turnStartedNotification("child-b-turn", { threadId: "child-b" }));
  await client.notify(turnStartedNotification("child-c-turn", { threadId: "child-c" }));
  await parent.unregister();
  await client.notify(
    nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
  );
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await client.notify(
    childTurnCompletedNotification({
      threadId: "child-b",
      turnId: "child-b-turn",
      status: "interrupted",
    }),
  );
  await attempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await client.notify(
    childTurnCompletedNotification({
      threadId: "child-c",
      turnId: "child-c-turn",
      status: "interrupted",
    }),
  );
  await attempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
  expect(runtime.deliverAgentHarnessCompletion.mock.calls[0]?.[0].result).toBe("first result");
});

it.each([false, true])(
  "settles an in-flight handoff after the last sibling is interrupted (success: %s)",
  async (success) => {
    vi.useFakeTimers();
    const attempts = observeCompletionAttempts();
    const { client, runtime, monitor } = await setupParentRetention("/tmp/codex-sibling-inflight");
    type DeliveryResult =
      | { delivered: false; path: "none"; error: string }
      | { delivered: true; path: "direct" };
    let releaseDelivery!: (result: DeliveryResult) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const inflight = new Promise<DeliveryResult>((resolve) => {
      releaseDelivery = resolve;
    });
    runtime.deliverAgentHarnessCompletion
      .mockImplementationOnce(() => {
        notifyStarted();
        return inflight;
      })
      .mockResolvedValue({ delivered: true, path: "direct" });
    const parent = await registerParent(monitor);
    await notifyChildStarted(client, "parent-thread", "child-a");
    await notifyChildStarted(client, "parent-thread", "child-b");
    await client.notify(turnStartedNotification("child-b-turn", { threadId: "child-b" }));
    await parent.unregister();
    const first = client.notify(
      nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
    );
    await started;
    await client.notify(
      childTurnCompletedNotification({
        threadId: "child-b",
        turnId: "child-b-turn",
        status: "interrupted",
      }),
    );
    releaseDelivery(
      success
        ? { delivered: true, path: "direct" }
        : { delivered: false, path: "none", error: "transient" },
    );
    await first;
    await attempts.settle();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(success ? 1 : 2);
  },
);

it("wakes a waiting completion after a mismatched sibling is retired", async () => {
  vi.useFakeTimers();
  const attempts = observeCompletionAttempts();
  const { client, runtime, monitor } = await setupParentRetention(
    "/tmp/codex-retired-sibling",
    () => {},
    false,
  );
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await parent.unregister();
  await client.notify(
    nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
  );
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  client.setThreadRead(
    "child-b",
    threadRead({
      childThreadId: "child-b",
      parentThreadId: "foreign-parent",
      status: "inProgress",
    }),
  );
  await monitor.reconcileChildThread("child-b");
  await attempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
});

it("preserves pending completion delivery when the monitor is disposed", async () => {
  vi.useFakeTimers();
  const attempts = observeCompletionAttempts();
  const { client, runtime, monitor } = await setupParentRetention(
    "/tmp/codex-disposed-sibling",
    () => {},
    false,
  );
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await parent.unregister();
  await client.notify(
    nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
  );
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await monitor.dispose();
  await attempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
});

async function setupParentRetention(
  agentDir: string,
  releaseCustody = () => {},
  retainIdleSubscription = true,
) {
  const client = createClient();
  const runtime = createRuntime();
  ensureCodexAppServerClientRuntime(client.client, { agentDir });
  if (retainIdleSubscription) {
    await retainCodexAppServerLiveThread(client.client, "parent-thread");
  }
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    retainParentThread: (threadId) => protectCodexAppServerLiveThread(client.client, threadId),
    hasIdleParentThread: (threadId) => hasIdleCodexThread(client.client, threadId),
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
  const bindingGuard = await store.prepareNativeSubagentGuard(identity, historyOwner);
  expect(bindingGuard).toBeDefined();
  onTestFinished(() => bindingGuard?.release());
  const parent = await monitor.registerParent({
    parentThreadId: binding.threadId,
    agentId: "main",
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    historyOwner,
    assignmentStore: createNativeSubagentAssignmentStore({
      bindingStore: store,
      assertBindingCurrent: bindingGuard!.assertCurrent,
      identity,
      owner: historyOwner,
    }),
  });
  await parent.ready;
  await parent.unregister();
  await expect(releaseForResume()).resolves.toBe(true);
  expect(client.request).toHaveBeenCalledWith(
    "thread/unsubscribe",
    { threadId: "parent-thread" },
    expect.anything(),
  );
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
    () => {},
    false,
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
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  await client.notify(
    nativeCompletionNotification({ agentPath: "child-b", result: "second result" }),
  );
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
  await expect(releaseForResume()).resolves.toBe(false);
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
  ).toEqual(["second result", "first result", "second result", "first result"]);
});

it("retains a failed warm handoff without exhausting retries while a sibling is running", async () => {
  vi.useFakeTimers();
  const { client, runtime, monitor } = await setupParentRetention("/tmp/codex-parent-retry");
  runtime.deliverAgentHarnessCompletion.mockResolvedValue({
    delivered: false,
    path: "none",
    error: "warm continuation unavailable",
  });
  const parent = await registerParent(monitor);
  await notifyChildStarted(client, "parent-thread", "child-a");
  await notifyChildStarted(client, "parent-thread", "child-b");
  await parent.unregister();
  await client.notify(
    nativeCompletionNotification({ agentPath: "child-a", result: "first result" }),
  );
  await vi.advanceTimersByTimeAsync(600_000);
  const observer = await registerParent(monitor);
  expect(observer.listPendingChildren()).toMatchObject([
    { childSessionKey: "codex-thread:child-a", state: "completing" },
    { childSessionKey: "codex-thread:child-b", state: "running" },
  ]);
  runtime.deliverAgentHarnessCompletion.mockResolvedValue({ delivered: true, path: "direct" });
  await observer.unregister();
  await client.notify(
    nativeCompletionNotification({ agentPath: "child-b", result: "second result" }),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  const settled = await registerParent(monitor);
  expect(settled.listPendingChildren()).toEqual([]);
  await settled.unregister();
});
