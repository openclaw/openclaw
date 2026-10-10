import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  type CodexThreadReadResponse,
  directSpawnItem,
  CodexNativeSubagentMonitor,
  registerCodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  registerParent,
  notifyChildStarted,
  registerDetachedChild,
  nativeCompletionNotification,
  closeAgentNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { JsonObject } from "./protocol.js";

function createFixture(options?: ConstructorParameters<typeof CodexNativeSubagentMonitor>[2]) {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, options);
  return { client, runtime, monitor };
}

describe("CodexNativeSubagentMonitor", () => {
  it("selects the exact bound parent turn and preserves the remaining owner on unregister", async () => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
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

    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-second",
        item: directSpawnItem("v1", "parent-thread", "child-second"),
      },
    });
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).toHaveBeenCalledWith("child-second");

    await second.unregister();
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-first",
        item: directSpawnItem("v1", "parent-thread", "child-first"),
      },
    });
    expect(firstClaim).toHaveBeenCalledWith("child-first");
    await monitor.dispose();
  });

  it("leaves wait snapshots to receipts until the child turn authoritatively completes", async () => {
    const { client, runtime, monitor } = createFixture();
    const parent = await registerParent(monitor, "parent-thread", "agent:main:main");
    parent.bindTurn("parent-turn");

    await notifyChildStarted(client, "parent-thread", "child-thread", "");
    await client.notify(turnStartedNotification("child-turn"));
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "wait-child",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "child final result",
            },
          },
        },
      },
    });

    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await parent.unregister();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await client.notify(
      childTurnCompletedNotification({
        turnId: "child-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "child-final", text: "child final result" }],
      }),
    );
    // The native wait receipt consumes the matching result without a duplicate fallback.
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("publishes parent-owned child activity without projecting it into the parent session", async () => {
    const events: Parameters<Parameters<typeof onAgentEvent>[0]>[0][] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));
    const { client, monitor } = createFixture();
    try {
      const parent = await registerParent(monitor);
      await notifyChildStarted(client);
      await parent.unregister();
      await client.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "child-thread",
          turnId: "child-turn",
          itemId: "assistant-1",
          delta: "Inspecting the registry",
        },
      });
      await client.notify({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "child-thread",
          turnId: "child-turn",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Planning the fix",
        },
      });
      await client.notify({
        method: "item/started",
        params: {
          threadId: "child-thread",
          turnId: "child-turn",
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "pnpm test",
            cwd: "/workspace",
            status: "inProgress",
          },
        },
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            agentId: "main",
            stream: "assistant",
            data: expect.objectContaining({ delta: "Inspecting the registry" }),
          }),
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            agentId: "main",
            stream: "thinking",
            data: expect.objectContaining({ delta: "Planning the fix" }),
          }),
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            agentId: "main",
            stream: "tool",
            data: expect.objectContaining({
              phase: "start",
              name: "bash",
              toolCallId: "command-1",
            }),
          }),
        ]),
      );
      for (const event of events) {
        expect(event.sessionKey).toBeUndefined();
      }
    } finally {
      unsubscribe();
      client.close();
    }
  });

  it("publishes native attention and idle observations without finalizing the task", async () => {
    const events: Parameters<Parameters<typeof onAgentEvent>[0]>[0][] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));
    const { client, runtime, monitor } = createFixture();
    try {
      await registerDetachedChild(client, monitor);
      const nativeStatuses: JsonObject[] = [
        { type: "active", activeFlags: [] },
        { type: "active", activeFlags: ["waitingOnApproval"] },
        { type: "active", activeFlags: ["waitingOnUserInput"] },
        { type: "idle" },
        { type: "notLoaded" },
      ];
      for (const nativeStatus of nativeStatuses) {
        await client.notify({
          method: "thread/status/changed",
          params: { threadId: "child-thread", status: nativeStatus },
        });
      }
      const sourceId = events.find((event) => event.stream === "execution")?.data.sourceId;
      expect(sourceId).toEqual(expect.any(String));
      expect(
        events.filter((event) => event.stream === "execution").map((event) => event.data),
      ).toEqual(
        [
          { state: "running" },
          { state: "waiting", wait: { kind: "approval" } },
          { state: "waiting", wait: { kind: "user_input" } },
          { state: "unknown" },
          { state: "unknown" },
        ].map((observation) => Object.assign(observation, { sourceId })),
      );
      client.close();
      await monitor.dispose();
      expect(events.at(-1)?.data).toEqual({ state: "unknown", sourceId, invalidate: true });

      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      client.close();
    }
  });

  it("observes native mailbox waits and replacement turns without inventing child targets", async () => {
    const events: Parameters<Parameters<typeof onAgentEvent>[0]>[0][] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));
    const { client, monitor } = createFixture();
    try {
      await registerDetachedChild(client, monitor);
      const startTurn = async (turnId: string) => {
        await client.notify({
          method: "turn/started",
          params: { threadId: "child-thread", turn: { id: turnId, status: "inProgress" } },
        });
      };
      const waitItem = async (
        phase: "started" | "completed",
        turnId: string,
        receiverThreadIds: string[] = [],
      ) => {
        await client.notify({
          method: `item/${phase}`,
          params: {
            threadId: "child-thread",
            turnId,
            item: {
              type: "collabAgentToolCall",
              id: `wait-${turnId}`,
              tool: "wait",
              senderThreadId: "child-thread",
              receiverThreadIds,
              status: phase === "started" ? "inProgress" : "completed",
            },
          },
        });
      };
      await startTurn("first-turn");
      await waitItem("started", "first-turn");
      await waitItem("completed", "first-turn");
      await client.notify(
        childTurnCompletedNotification({ status: "interrupted", turnId: "first-turn" }),
      );
      await startTurn("next-turn");
      await waitItem("started", "next-turn");
      const beforeLateEvents = events.length;
      await waitItem("completed", "first-turn");
      await client.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "child-thread", turnId: "first-turn", delta: "stale progress" },
      });
      expect(events).toHaveLength(beforeLateEvents);
      await client.notify(
        childTurnCompletedNotification({ status: "interrupted", turnId: "next-turn" }),
      );
      const afterTurnEnd = events.length;
      await waitItem("completed", "next-turn");
      expect(events).toHaveLength(afterTurnEnd);
      const sourceId = events.find((event) => event.stream === "execution")?.data.sourceId;
      expect(sourceId).toEqual(expect.any(String));
      expect(
        events.filter((event) => event.stream === "execution").map((event) => event.data),
      ).toEqual(
        [
          { state: "running", executionId: "first-turn" },
          { state: "waiting", executionId: "first-turn", wait: { kind: "agent_messages" } },
          { state: "running", executionId: "first-turn" },
          { state: "unknown", executionId: "first-turn" },
          { state: "running", executionId: "next-turn" },
          { state: "waiting", executionId: "next-turn", wait: { kind: "agent_messages" } },
          { state: "unknown", executionId: "next-turn" },
        ].map((observation) => Object.assign(observation, { sourceId })),
      );
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
    } finally {
      unsubscribe();
      client.close();
    }
  });

  it("falls back to a typed no-final completion when history stays unavailable", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      await registerDetachedChild(client, monitor);

      await client.notify(nativeCompletionNotification({ result: null }));
      await vi.advanceTimersByTimeAsync(20);

      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          statusLabel: "completed_without_final_message",
          result: "Subagent completed without a final assistant message.",
        }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a typed no-final fallback across completed history reads", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      client.setThreadRead("child-thread", threadRead({ status: "completed" }));
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      await registerDetachedChild(client, monitor);

      await client.notify(nativeCompletionNotification({ result: null }));
      await vi.advanceTimersByTimeAsync(20);

      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ statusLabel: "completed_without_final_message" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a provisional no-final result when the child starts another turn", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      await registerDetachedChild(client, monitor);

      await client.notify(nativeCompletionNotification({ result: null }));
      client.setThreadRead(
        "child-thread",
        threadRead({ turnId: "new-turn", threadStatus: "active", status: "inProgress" }),
      );
      await client.notify({
        method: "turn/started",
        params: {
          threadId: "child-thread",
          turn: { id: "new-turn", status: "inProgress", items: [], error: null },
        },
      });
      await vi.advanceTimersByTimeAsync(30);

      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

      client.setThreadRead(
        "child-thread",
        threadRead({
          turnId: "new-turn",
          status: "completed",
          result: "new turn result",
          resultPhase: "final_answer",
          trailingCommentary: "post-final progress noise",
        }),
      );
      await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ result: "new turn result" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover persisted completion while the child thread is active", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        threadStatus: "active",
        status: "completed",
        result: "stale persisted result",
      }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    await registerDetachedChild(client, monitor);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);

    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it.each([
    { current: "inProgress", persisted: "failed", result: undefined },
    { current: "failed", persisted: "completed", result: "current child failure" },
  ] as const)(
    "uses the authoritative $current turn after a system error",
    async ({ current, persisted, result }) => {
      vi.useFakeTimers();
      try {
        const { client, runtime, monitor } = createFixture(
          current === "inProgress" ? { recoveryPollDelaysMs: [10] } : undefined,
        );
        client.setThreadRead(
          "child-thread",
          threadRead({
            threadStatus: "systemError",
            status: persisted,
            result: "stale persisted result",
            error: persisted === "failed" ? "stale persisted failure" : undefined,
          }),
        );
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
        await registerDetachedChild(client, monitor);
        await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(Boolean(result));
        if (current === "inProgress") {
          await vi.advanceTimersByTimeAsync(30);
        }
        if (result) {
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ status: "failed", result }),
          );
        } else {
          expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        }
        client.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("delivers a bounded system-error fallback when live turn history stays unavailable", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      client.setThreadRead(
        "child-thread",
        threadRead({
          threadStatus: "systemError",
          status: "failed",
          error: "possibly stale failure",
        }),
      );
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      await registerDetachedChild(client, monitor);

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "systemError" } },
      });
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
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          result: "Subagent runtime reported a system error.",
        }),
      );
      expect(releaseClient).toHaveBeenCalledTimes(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm a fallback from a stale system-error read", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      let resolveStaleRead!: (value: CodexThreadReadResponse) => void;
      const staleRead = new Promise<CodexThreadReadResponse>((resolve) => {
        resolveStaleRead = resolve;
      });
      let readCount = 0;
      client.setThreadReadFactory("child-thread", async () => {
        readCount += 1;
        return readCount === 1
          ? await staleRead
          : threadRead({ threadStatus: "active", status: "inProgress" });
      });
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      await registerDetachedChild(client, monitor);

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "systemError" } },
      });
      await Promise.resolve();
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        expect.objectContaining({ threadId: "child-thread" }),
        expect.anything(),
      );

      await client.notify({
        method: "turn/started",
        params: {
          threadId: "child-thread",
          turn: { id: "resumed-turn", status: "inProgress", items: [], error: null },
        },
      });
      resolveStaleRead(
        threadRead({ threadStatus: "systemError", status: "failed", error: "stale failure" }),
      );
      await vi.advanceTimersByTimeAsync(30);

      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      expect(releaseClient).not.toHaveBeenCalled();
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps Codex agent_path completion notifications to child thread ids", async () => {
    const { client, runtime, monitor } = createFixture();
    const parent = await registerParent(monitor);
    await notifyChildStarted(client, "parent-thread", "child-thread", "1.2", {
      directParentField: false,
    });
    await parent.unregister();

    await client.notify(nativeCompletionNotification({ agentPath: "1.2" }));

    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread" }),
    );
    client.close();
  });

  it("does not let a second parent adopt an existing child thread", async () => {
    const { client, runtime, monitor } = createFixture();
    const parent = await registerParent(monitor, "parent-a", "agent:main:a");
    await registerParent(monitor, "parent-b", "agent:main:b");
    await notifyChildStarted(client, "parent-a", "child-thread");
    await notifyChildStarted(client, "parent-b", "child-thread");

    await client.notify(
      nativeCompletionNotification({
        parentThreadId: "parent-b",
        agentPath: "child-thread",
      }),
    );
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

    await parent.unregister();
    await client.notify(
      nativeCompletionNotification({
        parentThreadId: "parent-a",
        agentPath: "child-thread",
      }),
    );
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("releases completion ownership when no parent delivery scope exists", async () => {
    const firstClient = createClient();
    const firstRuntime = createRuntime();
    const firstMonitor = new CodexNativeSubagentMonitor(firstClient as never, firstRuntime);
    await firstMonitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      agentId: "main",
    });
    await notifyChildStarted(firstClient);
    await firstClient.notify(nativeCompletionNotification());

    expect(firstRuntime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

    const replacementClient = createClient();
    const replacementRuntime = createRuntime();
    const replacementMonitor = new CodexNativeSubagentMonitor(
      replacementClient as never,
      replacementRuntime,
    );
    await registerDetachedChild(replacementClient, replacementMonitor);
    await replacementClient.notify(nativeCompletionNotification());

    expect(replacementRuntime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
    firstClient.close();
    replacementClient.close();
  });

  it("does not bypass terminal delivery backoff when the parent registers again", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      runtime.deliverAgentHarnessCompletion
        .mockResolvedValueOnce({ delivered: false, path: "direct", error: "pending" })
        .mockResolvedValueOnce({ delivered: true, path: "direct" });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());

      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
      const parent = await registerParent(monitor);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
      await parent.unregister();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the client and parent subscription until every detached child is terminal", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseClient = vi.fn();
    const releaseParentThread = vi.fn();
    const retainParentThread = vi.fn(() => releaseParentThread);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      retainClient: () => releaseClient,
      retainParentThread,
      recoveryPollDelaysMs: [],
    });
    const parent = await registerParent(monitor);
    await notifyChildStarted(client, "parent-thread", "child-a");
    await notifyChildStarted(client, "parent-thread", "child-b");
    await parent.unregister();
    expect(retainParentThread).toHaveBeenCalledExactlyOnceWith("parent-thread");

    await client.notify(nativeCompletionNotification({ agentPath: "child-a" }));
    expect(releaseClient).not.toHaveBeenCalled();
    expect(releaseParentThread).not.toHaveBeenCalled();
    await client.notify(nativeCompletionNotification({ agentPath: "child-b" }));
    expect(releaseClient).toHaveBeenCalledTimes(1);
    expect(releaseParentThread).toHaveBeenCalledOnce();
    await monitor.dispose();
    expect(releaseParentThread).toHaveBeenCalledOnce();
    client.close();
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
    ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
    const oldestRelease = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("oldest native subscription could not be released"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(client as never, "thread-oldest", oldestRelease);
    for (let index = 1; index < 64; index += 1) {
      await retainCodexAppServerLiveThread(client as never, `thread-sibling-${index}`);
    }
    const releaseParentThread = vi.fn();
    const parent = await registerCodexNativeSubagentMonitor({
      client: client as never,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      runtime,
      retainParentThread: () => releaseParentThread,
    });
    parent.bindTurn("parent-turn");

    await notifyChildStarted(client);
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true),
    );
    await client.notify(nativeCompletionNotification({ turnId: "parent-turn" }));

    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledExactlyOnceWith(
        "thread/unsubscribe",
        { threadId: "child-thread" },
        { timeoutMs: 5_000 },
      ),
    );
    expect(oldestRelease).toHaveBeenCalledExactlyOnceWith("thread-oldest");
    expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(client as never, "child-thread"),
    ).resolves.toBeUndefined();
    const oldest = await consumeCodexAppServerLiveThread(client as never, "thread-oldest");
    expect(oldest).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    await expect(
      retainCodexAppServerLiveThread(client as never, "thread-oldest", oldest?.release),
    ).resolves.toBe(true);
    await expect(
      consumeCodexAppServerLiveThread(client as never, "thread-sibling-1"),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
    expect(releaseParentThread).toHaveBeenCalledOnce();

    await parent.unregister();
    client.close();
  });

  it("forgets the exact retained completed child after native close without unsubscribing", async () => {
    const client = createClient();
    client.setLoadedThreads([]);
    const runtime = createRuntime();
    ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
    const parent = await registerCodexNativeSubagentMonitor({
      client: client as never,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      runtime,
    });
    parent.bindTurn("parent-turn");

    await notifyChildStarted(client);
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true),
    );
    await client.notify(nativeCompletionNotification({ turnId: "parent-turn" }));
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
    );

    await client.notify(closeAgentNotification({ method: "item/started" }));
    await client.notify(closeAgentNotification({ method: "item/completed" }));
    expect(client.request).toHaveBeenCalledExactlyOnceWith(
      "thread/loaded/list",
      {},
      { timeoutMs: 10_000 },
    );
    await expect(
      consumeCodexAppServerLiveThread(client as never, "child-thread"),
    ).resolves.toBeUndefined();

    await parent.unregister();
    client.close();
  });

  it("fences a stale child close after eviction and same-client replacement ownership", async () => {
    const client = createClient();
    const runtime = createRuntime();
    client.request.mockImplementation(async (method) => {
      if (method === "thread/unsubscribe" || method === "thread/resume") {
        return {} as never;
      }
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
    const parent = await registerCodexNativeSubagentMonitor({
      client: client as never,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      runtime,
    });
    parent.bindTurn("parent-turn");

    await notifyChildStarted(client);
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true),
    );
    await client.notify(nativeCompletionNotification({ turnId: "parent-turn" }));
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
    );
    await client.notify(closeAgentNotification({ method: "item/started" }));
    await expect(releaseCodexAppServerLiveThread(client as never, "child-thread")).resolves.toBe(
      true,
    );
    expect(client.request).toHaveBeenCalledOnce();

    await client.request("thread/resume", { threadId: "child-thread" });
    const replacement = await claimCodexAppServerLiveThread(client as never, "child-thread");
    expect(replacement).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);

    await client.notify(closeAgentNotification({ method: "item/completed" }));
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/unsubscribe",
      "thread/resume",
      "thread/loaded/list",
    ]);
    expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);

    await replacement?.release("child-thread");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/unsubscribe",
      "thread/resume",
      "thread/loaded/list",
      "thread/unsubscribe",
    ]);
    await parent.unregister();
    client.close();
  });
});
