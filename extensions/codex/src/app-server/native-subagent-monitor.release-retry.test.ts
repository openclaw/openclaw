import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  childTurnCompletedNotification,
  createClient,
  createCompletionScope,
  createRuntime,
  notifyChildStarted,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { isJsonObject } from "./protocol.js";

afterEach(() => vi.useRealTimers());

async function createTerminalChild(
  params: { childFailures?: number; evictionFails?: boolean } = {},
) {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  const client = createClient();
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/synthetic-agent" });
  const request = client.request.getMockImplementation()!;
  let failEviction = params.evictionFails ?? true;
  let childFailures = params.childFailures ?? 1;
  const unsubscribeChild = vi.fn(async () => {
    if (childFailures > 0) {
      childFailures -= 1;
      throw new Error("thread/unsubscribe timed out");
    }
    return { status: "unsubscribed" };
  });
  client.request.mockImplementation(async (method, args, options) => {
    if (method === "thread/unsubscribe" && isJsonObject(args)) {
      if (args.threadId === "idle-0" && failEviction) {
        failEviction = false;
        throw new Error("thread/unsubscribe timed out");
      }
      if (args.threadId === "child-thread") {
        return unsubscribeChild();
      }
    }
    return request(method, args, options);
  });
  // Fill the production idle pool so child completion reaches capacity eviction.
  for (let i = 0; i < 64; i += 1) {
    expect(await retainCodexAppServerLiveThread(client.client, `idle-${i}`)).toBe(true);
  }
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "done" }));
  const parent = await registerCodexNativeSubagentMonitor({
    client: client.client,
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    runtime: createRuntime(),
  });
  onTestFinished(async () => {
    client.close();
    await parent.unregister();
  });
  parent.bindTurn("parent-turn");
  await notifyChildStarted(client);
  await client.notify(turnStartedNotification("turn-a"));
  await vi.advanceTimersByTimeAsync(0);
  expect(isCodexAppServerLiveThreadClaimed(client.client, "child-thread")).toBe(true);
  expect(unsubscribeChild).not.toHaveBeenCalled();
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-a",
      status: "completed",
      items: [{ id: "result", type: "agentMessage", text: "done" }],
    }),
  );
  await client.notify({
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed", message: "done" } },
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  return { client, parent, unsubscribeChild };
}

it("retries failed terminal release until recovery, then stops", async () => {
  const { client, unsubscribeChild } = await createTerminalChild({ childFailures: 3 });
  expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  for (let attempts = 1; attempts <= 3; attempts += 1) {
    expect(isCodexAppServerLiveThreadClaimed(client.client, "child-thread")).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(unsubscribeChild).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(unsubscribeChild).toHaveBeenCalledTimes(attempts + 1);
  }
  expect(hasCodexAppServerLiveThread(client.client, "child-thread")).toBe(false);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(unsubscribeChild).toHaveBeenCalledTimes(4);
});

it.each([true, false])(
  "does not retry successful terminal cleanup (eviction fails: %s)",
  async (evictionFails) => {
    const { client, unsubscribeChild } = await createTerminalChild({
      childFailures: 0,
      evictionFails,
    });
    expect(isCodexAppServerLiveThreadClaimed(client.client, "child-thread")).toBe(false);
    // Successful retention preserves the warm subscription; fallback release removes it.
    expect(hasCodexAppServerLiveThread(client.client, "child-thread")).toBe(!evictionFails);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(unsubscribeChild).toHaveBeenCalledTimes(evictionFails ? 1 : 0);
  },
);

it.each(["thread/closed", "connection-close"] as const)(
  "cancels failed-release retry on %s",
  async (ending) => {
    const { client, unsubscribeChild } = await createTerminalChild();
    expect(unsubscribeChild).toHaveBeenCalledTimes(1);
    if (ending === "thread/closed") {
      await client.notify({ method: ending, params: { threadId: "child-thread" } });
    } else {
      client.close();
    }
    await vi.advanceTimersByTimeAsync(90_000);
    expect(hasCodexAppServerLiveThread(client.client, "child-thread")).toBe(false);
    expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "does not release an admitted follow-up (protected retry: %s)",
  async (protectedRetry) => {
    const { client, parent, unsubscribeChild } = await createTerminalChild();
    const releaseProtection = protectedRetry
      ? protectCodexAppServerLiveThread(client.client, "child-thread")
      : undefined;
    if (protectedRetry) {
      // Submission custody protects a child before its follow-up is admitted.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(unsubscribeChild).toHaveBeenCalledTimes(1);
    }
    parent.bindTurn("parent-turn-b");
    client.setThreadRead("child-thread", threadRead({ turnId: "turn-b", status: "inProgress" }));
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn-b",
        item: {
          id: "send-b",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({
        turnId: "parent-turn-b",
        callId: "send-b",
        submissionId: "turn-b",
      }),
    );
    await client.notify(turnStartedNotification("turn-b"));
    await vi.advanceTimersByTimeAsync(0);
    releaseProtection?.();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(isCodexAppServerLiveThreadClaimed(client.client, "child-thread")).toBe(true);
    expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  },
);

it("keeps one release in flight and waits before retrying its failure", async () => {
  const { client, unsubscribeChild } = await createTerminalChild();
  const pending = createDeferred<{ status: string }>();
  unsubscribeChild.mockImplementationOnce(() => pending.promise);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(unsubscribeChild).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(unsubscribeChild).toHaveBeenCalledTimes(2);
  pending.reject(new Error("thread/unsubscribe timed out"));
  await vi.advanceTimersByTimeAsync(29_999);
  expect(unsubscribeChild).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(unsubscribeChild).toHaveBeenCalledTimes(3);
  expect(hasCodexAppServerLiveThread(client.client, "child-thread")).toBe(false);
});

it("retries after protection ends without a follow-up claim", async () => {
  const { client, unsubscribeChild } = await createTerminalChild();
  const releaseProtection = protectCodexAppServerLiveThread(client.client, "child-thread");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  expect(isCodexAppServerLiveThreadClaimed(client.client, "child-thread")).toBe(true);
  releaseProtection();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(unsubscribeChild).toHaveBeenCalledTimes(2);
  expect(hasCodexAppServerLiveThread(client.client, "child-thread")).toBe(false);
});
