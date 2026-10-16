import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread as claimThread,
  consumeCodexAppServerLiveThread as consumeThread,
  ensureCodexAppServerClientRuntime as ensureRuntime,
  isCodexAppServerLiveThreadClaimed as isClaimed,
  releaseCodexAppServerLiveThread as releaseThread,
  retainCodexAppServerLiveThread as retainThread,
} from "./client-runtime.js";
import {
  directSpawnItem,
  CodexNativeSubagentMonitor as Monitor,
  registerCodexNativeSubagentMonitor as registerMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  registerParent,
  notifyChildStarted as childStarted,
  registerDetachedChild as detachedChild,
  nativeCompletionNotification as completion,
  closeAgentNotification,
  childTurnCompletedNotification as completedTurn,
  turnStartedNotification as startedTurn,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";

function createFixture(options?: ConstructorParameters<typeof Monitor>[2]) {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new Monitor(client.client, runtime, options);
  return {
    client,
    runtime,
    monitor,
    child: (method: string, params: JsonObject) => client.notify(childNotification(method, params)),
    history: (params: Parameters<typeof threadRead>[0]) =>
      client.setThreadRead("child-thread", threadRead(params)),
  };
}

function observeEvents() {
  const events: Parameters<Parameters<typeof onAgentEvent>[0]>[0][] = [];
  onTestFinished(onAgentEvent((event) => events.push(event)));
  return events;
}

function itemNotification(item: JsonObject, turnId = "parent-turn"): CodexServerNotification {
  return { method: "item/completed", params: { threadId: "parent-thread", turnId, item } };
}

function childNotification(method: string, params: JsonObject): CodexServerNotification {
  return { method, params: { threadId: "child-thread", ...params } };
}

function activity(stream: string, data: JsonObject) {
  return expect.objectContaining({
    runId: "codex-thread:child-thread",
    agentId: "main",
    stream,
    data: expect.objectContaining(data),
  });
}

function expectExecution(events: ReturnType<typeof observeEvents>, observations: JsonObject[]) {
  const actual = events.filter((event) => event.stream === "execution").map((event) => event.data);
  const sourceId = actual[0]?.sourceId;
  expect(sourceId).toEqual(expect.any(String));
  expect(actual).toEqual(observations.map((observation) => ({ ...observation, sourceId })));
  return sourceId;
}

function expectCompletion(runtime: ReturnType<typeof createRuntime>, expected: JsonObject) {
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
    expect.objectContaining(expected),
  );
}

async function completeLiveChild(client: ReturnType<typeof createClient>, waitForRelease = true) {
  await childStarted(client);
  const claimed = () => isClaimed(client as never, "child-thread");
  await vi.waitFor(() => expect(claimed()).toBe(true));
  await client.notify(completion({ turnId: "parent-turn" }));
  if (waitForRelease) {
    await vi.waitFor(() => expect(claimed()).toBe(false));
  }
}

async function registerLiveParent(
  client: ReturnType<typeof createClient>,
  runtime = createRuntime(),
  options: Pick<Parameters<typeof registerMonitor>[0], "retainParentThread"> = {},
) {
  ensureRuntime(client as never, { agentDir: "/tmp/agent" });
  const parent = await registerMonitor({
    client: client as never,
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    runtime,
    ...options,
  });
  parent.bindTurn("parent-turn");
  return parent;
}

afterEach(() => vi.useRealTimers());

it("selects the exact bound parent turn and preserves the remaining owner on unregister", async () => {
  const client = createClient();
  const monitor = new Monitor(client as never, createRuntime());
  const firstClaim = vi.fn(() => () => undefined);
  const secondClaim = vi.fn(() => () => undefined);
  const first = await monitor.registerParent({
    parentThreadId: "parent-thread",
    claimDirectChild: firstClaim,
  });
  const second = await monitor.registerParent({
    parentThreadId: "parent-thread",
    claimDirectChild: secondClaim,
  });
  first.bindTurn("turn-first");
  second.bindTurn("turn-second");

  await client.notify(
    itemNotification(directSpawnItem("v1", "parent-thread", "child-second"), "turn-second"),
  );
  expect(firstClaim).not.toHaveBeenCalled();
  expect(secondClaim).toHaveBeenCalledWith("child-second");

  await second.unregister();
  await client.notify(
    itemNotification(directSpawnItem("v1", "parent-thread", "child-first"), "turn-first"),
  );
  expect(firstClaim).toHaveBeenCalledWith("child-first");
  await monitor.dispose();
});

it("leaves wait snapshots to receipts until the child turn authoritatively completes", async () => {
  const { client, runtime, monitor } = createFixture();
  const result = "child final result";
  const parent = await registerParent(monitor, "parent-thread", "agent:main:main");
  parent.bindTurn("parent-turn");

  await childStarted(client, "parent-thread", "child-thread", "");
  await client.notify(startedTurn("child-turn"));
  await client.notify(
    itemNotification({
      type: "collabAgentToolCall",
      id: "wait-child",
      tool: "wait",
      status: "completed",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "completed", message: result } },
    }),
  );

  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await parent.unregister();
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await client.notify(
    completedTurn({
      turnId: "child-turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "child-final", text: result }],
    }),
  );
  // The native wait receipt consumes the matching result without a duplicate fallback.
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await monitor.dispose();
});

it("publishes parent-owned child activity without projecting it into the parent session", async () => {
  const events = observeEvents();
  const { client, monitor, child } = createFixture();
  await detachedChild(client, monitor);
  await child("item/agentMessage/delta", {
    turnId: "child-turn",
    delta: "Inspecting the registry",
  });
  await child("item/reasoning/summaryTextDelta", {
    turnId: "child-turn",
    delta: "Planning the fix",
  });
  await child("item/started", {
    turnId: "child-turn",
    item: {
      type: "commandExecution",
      id: "command-1",
      command: "pnpm test",
      cwd: "/workspace",
      status: "inProgress",
    },
  });

  expect(events).toEqual(
    expect.arrayContaining([
      activity("assistant", { delta: "Inspecting the registry" }),
      activity("thinking", { delta: "Planning the fix" }),
      activity("tool", { phase: "start", name: "bash", toolCallId: "command-1" }),
    ]),
  );
  for (const event of events) {
    expect(event.sessionKey).toBeUndefined();
  }
});

it("publishes native attention and idle observations without finalizing the task", async () => {
  const events = observeEvents();
  const { client, runtime, monitor, child } = createFixture();
  await detachedChild(client, monitor);
  const nativeStatuses: JsonObject[] = [
    { type: "active", activeFlags: [] },
    { type: "active", activeFlags: ["waitingOnApproval"] },
    { type: "active", activeFlags: ["waitingOnUserInput"] },
    { type: "idle" },
    { type: "notLoaded" },
  ];
  for (const nativeStatus of nativeStatuses) {
    await child("thread/status/changed", { status: nativeStatus });
  }
  const sourceId = expectExecution(events, [
    { state: "running" },
    { state: "waiting", wait: { kind: "approval" } },
    { state: "waiting", wait: { kind: "user_input" } },
    { state: "unknown" },
    { state: "unknown" },
  ]);
  client.close();
  await monitor.dispose();
  expect(events.at(-1)?.data).toEqual({ state: "unknown", sourceId, invalidate: true });

  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
});

it("observes native mailbox waits and replacement turns without inventing child targets", async () => {
  const events = observeEvents();
  const { client, monitor, child } = createFixture();
  await detachedChild(client, monitor);
  const startTurn = (turnId: string) => client.notify(startedTurn(turnId));
  const waitItem = async (
    phase: "started" | "completed",
    turnId: string,
    receiverThreadIds: string[] = [],
  ) => {
    await child(`item/${phase}`, {
      turnId,
      item: {
        type: "collabAgentToolCall",
        id: `wait-${turnId}`,
        tool: "wait",
        senderThreadId: "child-thread",
        receiverThreadIds,
        status: phase === "started" ? "inProgress" : "completed",
      },
    });
  };
  await startTurn("first-turn");
  await waitItem("started", "first-turn");
  await waitItem("completed", "first-turn");
  await client.notify(completedTurn({ status: "interrupted", turnId: "first-turn" }));
  await startTurn("next-turn");
  await waitItem("started", "next-turn");
  const beforeLateEvents = events.length;
  await waitItem("completed", "first-turn");
  await child("item/agentMessage/delta", {
    turnId: "first-turn",
    delta: "stale progress",
  });
  expect(events).toHaveLength(beforeLateEvents);
  await client.notify(completedTurn({ status: "interrupted", turnId: "next-turn" }));
  const afterTurnEnd = events.length;
  await waitItem("completed", "next-turn");
  expect(events).toHaveLength(afterTurnEnd);
  const sourceId = expectExecution(events, [
    { state: "running", executionId: "first-turn" },
    { state: "waiting", executionId: "first-turn", wait: { kind: "agent_messages" } },
    { state: "running", executionId: "first-turn" },
    { state: "unknown", executionId: "first-turn" },
    { state: "running", executionId: "next-turn" },
    { state: "waiting", executionId: "next-turn", wait: { kind: "agent_messages" } },
    { state: "unknown", executionId: "next-turn" },
  ]);
  await startTurn("legacy-turn");
  const receivers = Array.from({ length: 35 }, (_, index) => `grandchild-${index}`);
  await waitItem("started", "legacy-turn", receivers);
  expect(events.at(-1)?.data).toEqual({
    state: "waiting",
    sourceId,
    executionId: "legacy-turn",
    wait: {
      kind: "children",
      pendingCount: 35,
      dependencies: receivers.slice(0, 32).map((id) => ({ runId: `codex-thread:${id}` })),
    },
  });
  await waitItem("completed", "legacy-turn", receivers);
  expect(events.at(-1)?.data).toEqual({
    state: "running",
    sourceId,
    executionId: "legacy-turn",
  });
});

it.each([false, true])(
  "keeps a typed no-final fallback with available history: %s",
  async (available) => {
    vi.useFakeTimers();
    const { client, runtime, monitor, history } = createFixture({ recoveryPollDelaysMs: [10] });
    if (available) {
      history({ status: "completed" });
    }
    await detachedChild(client, monitor);

    await client.notify(completion({ result: null }));
    await vi.advanceTimersByTimeAsync(20);

    expectCompletion(runtime, {
      statusLabel: "completed_without_final_message",
      result: "Subagent completed without a final assistant message.",
    });
  },
);

it("discards a provisional no-final result when the child starts another turn", async () => {
  vi.useFakeTimers();
  const { client, runtime, monitor, history } = createFixture({
    recoveryPollDelaysMs: [10],
  });
  await detachedChild(client, monitor);

  await client.notify(completion({ result: null }));
  history({ turnId: "new-turn", threadStatus: "active", status: "inProgress" });
  await client.notify(startedTurn("new-turn", { error: null }));
  await vi.advanceTimersByTimeAsync(30);

  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  history({
    turnId: "new-turn",
    status: "completed",
    result: "new turn result",
    resultPhase: "final_answer",
    trailingCommentary: "post-final progress noise",
  });
  await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
  expectCompletion(runtime, { result: "new turn result" });
});

it("does not recover persisted completion while the child thread is active", async () => {
  const { client, runtime, monitor, history } = createFixture();
  history({
    threadStatus: "active",
    status: "completed",
    result: "stale persisted result",
  });
  await detachedChild(client, monitor);

  await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);

  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
});

it.each([
  { current: "inProgress", persisted: "failed", result: undefined },
  { current: "failed", persisted: "completed", result: "current child failure" },
] as const)(
  "uses the authoritative $current turn after a system error",
  async ({ current, persisted, result }) => {
    vi.useFakeTimers();
    const { client, runtime, monitor, history } = createFixture(
      current === "inProgress" ? { recoveryPollDelaysMs: [10] } : undefined,
    );
    history({
      threadStatus: "systemError",
      status: persisted,
      result: "stale persisted result",
      error: persisted === "failed" ? "stale persisted failure" : undefined,
    });
    client.setThreadTurns("child-thread", {
      data: [
        {
          id: "current-turn",
          status: current,
          items: [],
          ...(result ? { error: { message: result } } : {}),
        },
      ],
    });
    await detachedChild(client, monitor);
    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(Boolean(result));
    if (current === "inProgress") {
      await vi.advanceTimersByTimeAsync(30);
    }
    if (result) {
      expectCompletion(runtime, { status: "failed", result });
    } else {
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    }
  },
);

it("delivers a bounded system-error fallback when live turn history stays unavailable", async () => {
  vi.useFakeTimers();
  const releaseClient = vi.fn();
  const { client, runtime, monitor, history, child } = createFixture({
    recoveryPollDelaysMs: [10],
    retainClient: () => releaseClient,
  });
  history({
    threadStatus: "systemError",
    status: "failed",
    error: "possibly stale failure",
  });
  await detachedChild(client, monitor);

  await child("thread/status/changed", { status: { type: "systemError" } });
  await vi.advanceTimersByTimeAsync(0);

  expect(client.request).toHaveBeenCalledWith(
    "thread/read",
    expect.objectContaining({ threadId: "child-thread" }),
    expect.anything(),
  );
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(20);

  expect(client.request).toHaveBeenCalledWith(
    "thread/turns/list",
    expect.anything(),
    expect.anything(),
  );
  expectCompletion(runtime, {
    status: "failed",
    result: "Subagent runtime reported a system error.",
  });
  expect(releaseClient).toHaveBeenCalledTimes(1);
});

it("maps Codex agent_path completion notifications to child thread ids", async () => {
  const { client, runtime, monitor } = createFixture();
  const parent = await registerParent(monitor);
  await childStarted(client, "parent-thread", "child-thread", "1.2", {
    directParentField: false,
  });
  await parent.unregister();

  await client.notify(completion({ agentPath: "1.2" }));

  expectCompletion(runtime, { childSessionId: "child-thread" });
});

it("does not let a second parent adopt an existing child thread", async () => {
  const { client, runtime, monitor } = createFixture();
  const parent = await registerParent(monitor, "parent-a", "agent:main:a");
  await registerParent(monitor, "parent-b", "agent:main:b");
  await childStarted(client, "parent-a", "child-thread");
  await childStarted(client, "parent-b", "child-thread");

  await client.notify(
    completion({
      parentThreadId: "parent-b",
      agentPath: "child-thread",
    }),
  );
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  await parent.unregister();
  await client.notify(
    completion({
      parentThreadId: "parent-a",
      agentPath: "child-thread",
    }),
  );
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
});

it("releases completion ownership when no parent delivery scope exists", async () => {
  const first = createFixture();
  await first.monitor.registerParent({
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:discord:channel:C123",
    agentId: "main",
  });
  await childStarted(first.client);
  await first.client.notify(completion());

  expect(first.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

  const replacement = createFixture();
  await detachedChild(replacement.client, replacement.monitor);
  await replacement.client.notify(completion());

  expect(replacement.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
});

it("does not bypass terminal delivery backoff when the parent registers again", async () => {
  vi.useFakeTimers();
  const { client, runtime, monitor } = createFixture({ completionDeliveryRetryDelaysMs: [10] });
  runtime.deliverAgentHarnessCompletion
    .mockResolvedValueOnce({ delivered: false, path: "direct", error: "pending" })
    .mockResolvedValueOnce({ delivered: true, path: "direct" });
  await detachedChild(client, monitor);
  await client.notify(completion());

  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
  const parent = await registerParent(monitor);
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(10);
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
  await parent.unregister();
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
});

it("retains the client and parent subscription until every detached child is terminal", async () => {
  const releaseClient = vi.fn();
  const releaseParentThread = vi.fn();
  const retainParentThread = vi.fn(() => releaseParentThread);
  const { client, monitor } = createFixture({
    retainClient: () => releaseClient,
    retainParentThread,
    recoveryPollDelaysMs: [],
  });
  const parent = await registerParent(monitor);
  await childStarted(client, "parent-thread", "child-a");
  await childStarted(client, "parent-thread", "child-b");
  await parent.unregister();
  expect(retainParentThread).toHaveBeenCalledExactlyOnceWith("parent-thread");

  await client.notify(completion({ agentPath: "child-a" }));
  expect(releaseClient).not.toHaveBeenCalled();
  expect(releaseParentThread).not.toHaveBeenCalled();
  await client.notify(completion({ agentPath: "child-b" }));
  expect(releaseClient).toHaveBeenCalledTimes(1);
  expect(releaseParentThread).toHaveBeenCalledOnce();
  await monitor.dispose();
  expect(releaseParentThread).toHaveBeenCalledOnce();
});

it("releases a completed native child when its full idle pool cannot evict its oldest owner", async () => {
  const client = createClient();
  const runtime = createRuntime();
  client.request.mockImplementation(async (method) => {
    if (method === "thread/unsubscribe") {
      return {} as never;
    }
    throw new Error(`unexpected request: ${method}`);
  });
  ensureRuntime(client as never, { agentDir: "/tmp/agent" });
  const oldestRelease = vi
    .fn<(threadId: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("oldest native subscription could not be released"))
    .mockResolvedValueOnce(undefined);
  await retainThread(client as never, "thread-oldest", oldestRelease);
  for (let index = 1; index < 64; index += 1) {
    await retainThread(client as never, `thread-sibling-${index}`);
  }
  const releaseParentThread = vi.fn();
  const parent = await registerLiveParent(client, runtime, {
    retainParentThread: () => releaseParentThread,
  });

  await completeLiveChild(client, false);

  await vi.waitFor(() =>
    expect(client.request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "child-thread" },
      { timeoutMs: 5_000 },
    ),
  );
  expect(oldestRelease).toHaveBeenCalledExactlyOnceWith("thread-oldest", undefined, undefined);
  expect(isClaimed(client as never, "child-thread")).toBe(false);
  await expect(consumeThread(client as never, "child-thread")).resolves.toBeUndefined();
  const oldest = await consumeThread(client as never, "thread-oldest");
  expect(oldest).toEqual(expect.objectContaining({ release: expect.any(Function) }));
  await expect(retainThread(client as never, "thread-oldest", oldest?.release)).resolves.toBe(true);
  await expect(consumeThread(client as never, "thread-sibling-1")).resolves.toEqual(
    expect.objectContaining({ release: expect.any(Function) }),
  );
  expect(releaseParentThread).toHaveBeenCalledOnce();

  await parent.unregister();
});

it("forgets the exact retained completed child after native close without unsubscribing", async () => {
  const client = createClient();
  client.setLoadedThreads([]);
  const parent = await registerLiveParent(client);

  await completeLiveChild(client);

  await client.notify(closeAgentNotification({ method: "item/started" }));
  await client.notify(closeAgentNotification({ method: "item/completed" }));
  expect(client.request).toHaveBeenCalledExactlyOnceWith(
    "thread/loaded/list",
    {},
    { timeoutMs: 10_000 },
  );
  await expect(consumeThread(client as never, "child-thread")).resolves.toBeUndefined();

  await parent.unregister();
});

it("fences a stale child close after eviction and same-client replacement ownership", async () => {
  const client = createClient();
  client.request.mockImplementation(async (method) => {
    if (method === "thread/unsubscribe" || method === "thread/resume") {
      return {} as never;
    }
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const parent = await registerLiveParent(client);

  await completeLiveChild(client);
  await client.notify(closeAgentNotification({ method: "item/started" }));
  await expect(releaseThread(client as never, "child-thread")).resolves.toBe(true);
  expect(client.request).toHaveBeenCalledOnce();

  await client.request("thread/resume", { threadId: "child-thread" });
  const replacement = await claimThread(client as never, "child-thread");
  expect(replacement).toEqual(expect.objectContaining({ release: expect.any(Function) }));
  expect(isClaimed(client as never, "child-thread")).toBe(true);

  await client.notify(closeAgentNotification({ method: "item/completed" }));
  expect(client.request.mock.calls.map(([method]) => method)).toEqual([
    "thread/unsubscribe",
    "thread/resume",
    "thread/loaded/list",
  ]);
  expect(isClaimed(client as never, "child-thread")).toBe(true);

  await replacement?.release("child-thread");
  expect(client.request.mock.calls.map(([method]) => method)).toEqual([
    "thread/unsubscribe",
    "thread/resume",
    "thread/loaded/list",
    "thread/unsubscribe",
  ]);
  await parent.unregister();
});
