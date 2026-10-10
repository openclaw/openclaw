import { setImmediate } from "node:timers/promises";
import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  closeAgentNotification,
  registerDetachedChild,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  notifyChildStarted,
  childTurnCompletedNotification,
  directSpawnItem,
  nativeCompletionNotification,
  registerParent,
  successfulSendInputOutput,
  turnStartedNotification,
  registerCodexNativeSubagentMonitor,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type {
  CodexNativeSubagentSubmissionStore,
  CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import type { CodexServerNotification } from "./protocol.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

function spawnNotification(
  childThreadId = "child-thread",
  turnId = "parent-turn",
): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId,
      item: directSpawnItem("v2", "parent-thread", childThreadId),
    },
  };
}

function createCustody() {
  const holds: AgentHarnessCompletionCustody[] = [];
  const executions = new Set<AgentHarnessCompletionCustody>();
  const released = createDeferred<void>();
  const retain = (settled = false): AgentHarnessCompletionCustody => {
    const lifetime = new AbortController();
    const hold: AgentHarnessCompletionCustody = {
      signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted,
      retain() {
        lifetime.signal.throwIfAborted();
        return retain(!executions.has(hold));
      },
      settleExecution: () => {
        executions.delete(hold);
      },
      release() {
        executions.delete(hold);
        lifetime.abort();
        if (holds.every((entry) => entry.signal.aborted)) {
          released.resolve();
        }
      },
    };
    holds.push(hold);
    if (!settled) {
      executions.add(hold);
    }
    return hold;
  };
  return {
    root: retain(),
    holds,
    executions,
    released: released.promise,
    live: () => holds.filter((hold) => !hold.signal.aborted),
  };
}

afterEach(() => vi.useRealTimers());

describe("native assignment completion custody", () => {
  it.each(["ready", "dispose", "replace", "revoked", "caller-revoked", "pending-reject"] as const)(
    "keeps pending capture outside native admission and settles on %s",
    async (ending) => {
      const client = createClient();
      const runtime = createRuntime();
      const source = createCustody();
      const replacement = createCustody();
      const capture = createDeferred<AgentHarnessCompletionCustody | undefined>();
      const nextCapture = createDeferred<AgentHarnessCompletionCustody | undefined>();
      runtime.captureAgentHarnessCompletionCustody
        .mockImplementationOnce(() => capture.promise)
        .mockImplementationOnce(async () =>
          ending === "pending-reject" ? nextCapture.promise : replacement.root,
        );
      const claimChildThread = vi.fn(async () => undefined);
      const claimDirectChild = vi.fn(() => vi.fn());
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        claimChildThread,
      });
      let current = true;
      const modelSource = { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() };
      const registration = {
        modelSource,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:original",
        completionScope: createCompletionScope("agent:main:original"),
        agentId: "main",
        claimDirectChild,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Caller registration is no longer current");
          }
        },
      };
      const pending = monitor.registerParent(registration);
      const failure = new Error("capture failed");
      const captureFailed = ending === "pending-reject";
      const rejected =
        ending === "ready"
          ? undefined
          : expect(pending).rejects.toThrow(
              captureFailed ? failure : "registration is no longer current",
            );
      let pendingSuccessor: ReturnType<typeof registerParent> | undefined;
      try {
        await notifyChildStarted(client, "parent-thread", "early-child");
        await client.notify(spawnNotification("early-child", "parent-turn"));
        expect(claimChildThread).not.toHaveBeenCalled();
        expect(claimDirectChild).not.toHaveBeenCalled();
        expect(runtime.createAgentHarnessCompletionEventSink).not.toHaveBeenCalled();
        await expect(registerParent(monitor, "parent-thread", "agent:main:other")).rejects.toThrow(
          "already bound to another session",
        );
        expect(runtime.captureAgentHarnessCompletionCustody).toHaveBeenCalledOnce();
        // Caller mutation during capture cannot change the captured registration.
        registration.requesterSessionKey = "agent:main:mutated";
        registration.completionScope = createCompletionScope("agent:main:mutated");
        let successor: Awaited<ReturnType<typeof registerParent>> | undefined;
        if (ending === "pending-reject") {
          pendingSuccessor = registerParent(monitor, "parent-thread", "agent:main:original");
        } else if (ending === "caller-revoked") {
          current = false;
        } else if (ending === "dispose") {
          await monitor.dispose();
        } else if (ending === "replace") {
          await monitor.retireParent("parent-thread");
          successor = await registerParent(monitor, "parent-thread", "agent:main:replacement");
        }
        if (captureFailed) {
          source.root.release();
          capture.reject(failure);
        } else {
          if (ending === "revoked") {
            source.root.release();
          }
          capture.resolve(source.root);
        }
        if (ending === "ready") {
          const owner = await pending;
          owner.bindTurn("parent-turn");
          await client.notify(spawnNotification("child-thread", "parent-turn"));
          expect(claimDirectChild).toHaveBeenCalledExactlyOnceWith("child-thread");
          expect(runtime.createAgentHarnessCompletionEventSink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              scope: expect.objectContaining({ requesterSessionKey: "agent:main:original" }),
            }),
          );
          await owner.unregister();
        } else {
          await rejected;
          expect(source.live()).toHaveLength(0);
          expect(runtime.createAgentHarnessCompletionEventSink).not.toHaveBeenCalled();
          if (pendingSuccessor) {
            nextCapture.resolve(replacement.root);
            successor = await pendingSuccessor;
          }
          if (successor) {
            successor.bindTurn("replacement-turn");
            await notifyChildStarted(client);
            expect(runtime.createAgentHarnessCompletionEventSink).not.toHaveBeenCalled();
            expect(replacement.live()).toHaveLength(1);
            await client.notify(spawnNotification("child-thread", "replacement-turn"));
            expect(runtime.createAgentHarnessCompletionEventSink).toHaveBeenCalledOnce();
            expect(replacement.live()).toHaveLength(2);
            await successor.unregister();
            expect(replacement.live()).toHaveLength(1);
          }
        }
      } finally {
        await monitor.dispose();
        capture.resolve(source.root);
        nextCapture.resolve(replacement.root);
        await pending.catch(() => {});
        await pendingSuccessor?.then(
          (owner) => owner.unregister(),
          () => {},
        );
        source.root.release();
        replacement.root.release();
      }
      expect(source.live()).toHaveLength(0);
      expect(replacement.live()).toHaveLength(0);
      expect(modelSource.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["closed", "exhausted"] as const)(
    "retains the exact overlapping owner through parent yield and releases on %s",
    async (ending) => {
      vi.useFakeTimers();
      const client = createClient();
      const runtime = createRuntime();
      const first = createCustody();
      const second = createCustody();
      runtime.captureAgentHarnessCompletionCustody
        .mockResolvedValueOnce(first.root)
        .mockResolvedValueOnce(second.root);
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({ delivered: false, path: "none" });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [1],
        completionDeliveryMaxRetries: 1,
      });
      try {
        const owner = await registerParent(monitor);
        const other = await registerParent(monitor);
        other.bindTurn("other-turn");
        // Native spawn evidence can arrive before the admitting turn/start response.
        await client.notify(spawnNotification("child-thread", "parent-turn"));
        owner.bindTurn("parent-turn");
        await owner.unregister();
        expect(first.live()).toHaveLength(1);
        await other.unregister();
        expect(second.live()).toHaveLength(0);
        await client.notify(nativeCompletionNotification({ agentPath: "/root/child-thread" }));
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        expect(first.holds).toContain(
          runtime.deliverAgentHarnessCompletion.mock.calls[0]![0].completionCustody,
        );
        expect(first.executions.size).toBe(0);
        if (ending === "closed") {
          await monitor.dispose();
          expect(first.live()).toHaveLength(1);
          runtime.deliverAgentHarnessCompletion.mockResolvedValue({
            delivered: true,
            path: "direct",
          });
          await vi.advanceTimersByTimeAsync(1);
        } else {
          await vi.advanceTimersByTimeAsync(1);
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
        }
        expect(first.live()).toHaveLength(0);
      } finally {
        await monitor.retireParent("parent-thread");
        await monitor.dispose();
        first.root.release();
        second.root.release();
      }
    },
  );

  it("releases interrupted execution and disposes all children after stale event custody", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
    const emit = vi.fn();
    runtime.createAgentHarnessCompletionEventSink.mockReturnValue(emit);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const parent = await registerParent(monitor);
    parent.bindTurn("parent-turn");
    for (const child of ["child-thread", "other-child"]) {
      await client.notify(spawnNotification(child, "parent-turn"));
      await client.notify(turnStartedNotification("child-turn", { threadId: child }));
    }
    await parent.unregister();
    expect(source.live()).toHaveLength(2);
    await client.notify(childTurnCompletedNotification({ status: "interrupted" }));
    expect(source.live()).toHaveLength(1);
    expect(source.executions.size).toBe(1);
    emit.mockImplementation(() => {
      throw new Error("requester lifecycle replaced");
    });
    await expect(monitor.dispose()).resolves.toBeUndefined();
    expect(source.live()).toHaveLength(0);
    expect(source.executions.size).toBe(0);
  });

  it("releases an accepted submission whose predecessor never acquired a turn anchor", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
      hasObservationBacking: () => true,
    });
    const parent = await registerParent(monitor);
    parent.bindTurn("parent-turn");
    await client.notify(spawnNotification("child-thread", "parent-turn"));
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          id: "send-child",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({ callId: "send-child", submissionId: "followup-turn" }),
    );
    await parent.unregister();
    expect(source.live()).toHaveLength(2);
    await monitor.dispose();
    expect(source.live()).toHaveLength(0);
  });
});

describe("native completion custody and host recovery", () => {
  it("releases blocked completion ownership without polling", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const successorClient = createClient();
    let monitor: InstanceType<typeof CodexNativeSubagentMonitor> | undefined;
    let successor: InstanceType<typeof CodexNativeSubagentMonitor> | undefined;
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryBlocked: true,
      });
      monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
      const successorRuntime = createRuntime();
      successor = new CodexNativeSubagentMonitor(successorClient as never, successorRuntime);
      await registerDetachedChild(successorClient, successor);
      await successorClient.notify(nativeCompletionNotification());
      expect(successorRuntime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
    } finally {
      await monitor?.dispose();
      await successor?.dispose();
      client.close();
      successorClient.close();
      vi.useRealTimers();
    }
  });

  it("does not exhaust delivery retries while the host recovery owns completion", async () => {
    vi.useFakeTimers();
    const client = createClient();
    let monitor: InstanceType<typeof CodexNativeSubagentMonitor> | undefined;
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryPending: true,
      });
      monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
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
      await monitor?.dispose();
      client.close();
      vi.useRealTimers();
    }
  });
});

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

async function createSubmissionFixture() {
  const identity = { kind: "session" as const, agentId: "main", sessionId: "parent-session" };
  const binding = {
    threadId: "parent-thread",
    cwd: "/workspace",
    appServerRuntimeFingerprint: "runtime",
  };
  const bindingStore = createCodexTestBindingStore();
  await bindingStore.mutate(identity, { kind: "set", binding });
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    binding,
  });
  if (!owner) {
    throw new Error("The binding must provide a history owner.");
  }
  const client = createClient();
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "result A" }));
  ensureCodexAppServerClientRuntime(client as never, { agentDir: "/workspace/agent" });
  const unsubscribe = vi.fn(async (_threadId: string) => undefined);
  for (const id of [binding.threadId, "child-thread"]) {
    await retainCodexAppServerLiveThread(client as never, id, unsubscribe);
  }
  const runtime = createRuntime();
  const holds = { client: 0, parent: 0, child: 0 };
  const consume = vi.fn<CodexNativeSubagentSubmissionStore["consume"]>((receipt, guard) =>
    bindingStore.mutate(
      identity,
      { kind: "consume-native-subagent-submission", owner, receipt },
      guard,
    ),
  );
  const submissionStore: CodexNativeSubagentSubmissionStore = {
    assertCurrent: () => {
      const current = bindingStore.read(identity);
      if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
        throw new Error("Submission binding changed.");
      }
    },
    read: () => bindingStore.readNativeSubagentSubmissions(identity, owner),
    record: (receipt, guard) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt },
        guard,
      ),
    consume,
  };
  const parent = await registerCodexNativeSubagentMonitor({
    client: client as never,
    parentThreadId: binding.threadId,
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    historyOwner: owner,
    submissionStore,
    runtime,
    retainClient: () => {
      holds.client += 1;
      return () => {
        holds.client -= 1;
      };
    },
    retainParentThread: (id) => {
      const key = id === binding.threadId ? "parent" : "child";
      const release = protectCodexAppServerLiveThread(client as never, id);
      holds[key] += 1;
      return () => {
        holds[key] -= 1;
        release();
      };
    },
  });
  onTestFinished(async () => {
    client.close();
    await parent.unregister();
  });
  parent.bindTurn("parent-turn-a");
  await notifyChildStarted(client);
  await client.notify(turnStartedNotification("turn-a"));
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-a",
      status: "completed",
      items: [{ id: "a", type: "agentMessage", text: "result A" }],
    }),
  );
  await client.notify({
    method: "item/completed",
    params: {
      threadId: binding.threadId,
      turnId: "parent-turn-a",
      item: {
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        senderThreadId: binding.threadId,
        receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed", message: "result A" } },
      },
    },
  });
  await vi.waitFor(() =>
    expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
  );
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  runtime.deliverAgentHarnessCompletion.mockClear();

  const submit = async (submissionId: string) => {
    parent.bindTurn("parent-turn-b");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: binding.threadId,
        turnId: "parent-turn-b",
        item: {
          id: "send-b",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: binding.threadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({
        parentThreadId: binding.threadId,
        turnId: "parent-turn-b",
        callId: "send-b",
        submissionId,
      }),
    );
    await parent.unregister();
    expect(await submissionStore.read()).toHaveLength(1);
    expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  };
  return {
    client,
    parent,
    runtime,
    holds,
    consume,
    submissionStore,
    unsubscribe,
    submit,
  };
}

it("stops observing opaque receipts when existing warm subscriptions expire", async () => {
  const fixture = await createSubmissionFixture();
  const { client, runtime, holds, consume, submissionStore, unsubscribe } = fixture;
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  await fixture.submit("815dc55d-2d19-4bfe-9fd3-038ce4d6aada");
  const receipt = structuredClone(await submissionStore.read());
  const reads = () =>
    client.request.mock.calls.filter(([method]) => method === "thread/read").length;
  // The existing client-runtime owner expires unprotected subscriptions after 30 minutes.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(hasCodexAppServerLiveThread(client as never, "parent-thread")).toBe(false);
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(false);
  expect(unsubscribe.mock.calls.map(([id]) => id).toSorted()).toEqual([
    "child-thread",
    "parent-thread",
  ]);
  const readsAtExpiry = reads();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  expect(await submissionStore.read()).toEqual(receipt);
  expect(consume).not.toHaveBeenCalled();
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await client.notify(turnStartedNotification(receipt[0]!.submissionId));
  expect(await submissionStore.read()).toEqual(receipt);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});

it("admits a delayed exact start under warm backing and retains its completion ownership", async () => {
  const fixture = await createSubmissionFixture();
  const { client, runtime, holds, submissionStore } = fixture;
  await releaseCodexAppServerLiveThread(client as never, "parent-thread");
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(true);
  await fixture.submit("turn-b");
  await client.notify(turnStartedNotification("turn-b"));
  const runId = "codex-thread:child-thread:turn:turn-b";
  expect(await submissionStore.read()).toHaveLength(1);
  expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);
  expect(holds.client).toBe(1);
  expect(holds.parent).toBe(1);
  await expect(releaseCodexAppServerLiveThread(client as never, "child-thread")).resolves.toBe(
    false,
  );
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-b",
      status: "completed",
      items: [{ id: "b", type: "agentMessage", text: "result B" }],
    }),
  );
  await vi.waitFor(async () => expect(await submissionStore.read()).toEqual([]));
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ childSessionKey: runId, result: "result B" }),
  );
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});

const initialRunId = "codex-thread:child-thread";
const followupRunId = "codex-thread:child-thread:turn:turn-b";
type Client = ReturnType<typeof createClient>;

async function startTurn(client: Client, id: string) {
  await client.notify(turnStartedNotification(id, { error: null }));
}

async function completeTurn(client: Client, id: string, text: string) {
  await client.notify(
    childTurnCompletedNotification({
      turnId: id,
      status: "completed",
      items: [{ type: "agentMessage", id: `message-${id}`, phase: "final_answer", text }],
    }),
  );
}

async function collabCall(client: Client, tool: "wait" | "sendInput", id: string) {
  for (const phase of ["started", "completed"] as const) {
    await client.notify({
      method: `item/${phase}`,
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id,
          tool,
          status: phase === "started" ? "inProgress" : "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates:
            phase === "started"
              ? {}
              : {
                  "child-thread":
                    tool === "wait"
                      ? { status: "completed", message: "A result" }
                      : { status: "running" },
                },
        },
      },
    });
  }
}

async function deliverInitialResult(client: Client) {
  await client.notify({
    method: "rawResponseItem/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<subagent_notification>\n{"agent_path":"child-thread","status":{"completed":"A result"}}\n</subagent_notification>',
          },
        ],
      },
    },
  });
  await collabCall(client, "wait", "wait-a");
}

async function submitFollowup(client: Client, submissionId = "turn-b") {
  await collabCall(client, "sendInput", "send-b");
  await client.notify(successfulSendInputOutput({ callId: "send-b", submissionId }));
}

async function createFixture(submissionStore?: CodexNativeSubagentSubmissionStore) {
  const client = createClient();
  const runtime = createRuntime();
  let connected = true;
  const heldClients = new Set<symbol>();
  const heldThreads = new Set<symbol>();
  const retain = (holds: Set<symbol>) => {
    const token = Symbol("native-subagent-retention");
    holds.add(token);
    return () => {
      holds.delete(token);
    };
  };
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    recoveryPollDelaysMs: [10],
    retainClient: () => retain(heldClients),
    retainParentThread: () => retain(heldThreads),
    hasObservationBacking: (parentThreadId, childThreadId) =>
      connected && parentThreadId === "parent-thread" && childThreadId === "child-thread",
  });
  let resolveHistory!: (value: ReturnType<typeof threadRead>) => void;
  const historyGate = new Promise<ReturnType<typeof threadRead>>((resolve) => {
    resolveHistory = resolve;
  });
  client.setThreadReadFactory("child-thread", () => historyGate);
  let history = threadRead({ turnId: "turn-b", result: "B result" });
  history.thread.turns!.unshift(
    ...threadRead({ turnId: "turn-a", result: "A result" }).thread.turns!,
  );
  const releaseHistory = (nextHistory = history) => {
    history = nextHistory;
    client.setThreadRead("child-thread", history);
    resolveHistory(history);
  };
  const owner = await monitor.registerParent({
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:discord:channel:C123",
    completionScope: createCompletionScope(),
    agentId: "main",
    submissionStore,
  });
  owner.bindTurn("parent-turn");
  return {
    client,
    runtime,
    monitor,
    owner,
    heldClients,
    heldThreads,
    releaseHistory,
    dropObservationBacking: () => {
      connected = false;
    },
    close: async () => {
      releaseHistory();
      await owner.unregister();
      connected = false;
      await monitor.dispose();
    },
  };
}

describe("Codex native transient predecessor anchor", () => {
  it.each(["parent-output-before-a-end", "parent-unregister-before-anchor"] as const)(
    "preserves the accepted follow-up when %s",
    async (order) => {
      const receipts = new Map<string, CodexNativeSubagentSubmission>();
      const ownerStatesAtRecord: boolean[] = [];
      let parentRegistered = true;
      const submissionStore = {
        assertCurrent: () => {},
        read: async () => [...receipts.values()],
        record: vi.fn<CodexNativeSubagentSubmissionStore["record"]>(async (receipt, guard) => {
          guard();
          ownerStatesAtRecord.push(parentRegistered);
          receipts.set(receipt.callId, structuredClone(receipt));
          return true;
        }),
        consume: vi.fn<CodexNativeSubagentSubmissionStore["consume"]>(async (receipt, guard) => {
          guard();
          return receipts.delete(receipt.callId);
        }),
      } satisfies CodexNativeSubagentSubmissionStore;
      const fixture = await createFixture(
        order === "parent-unregister-before-anchor" ? submissionStore : undefined,
      );
      const { client, runtime, monitor, owner } = fixture;
      try {
        await notifyChildStarted(client);
        const startObservedBeforeOutput = order === "parent-output-before-a-end";
        if (startObservedBeforeOutput) {
          await startTurn(client, "turn-a");
        }
        if (order !== "parent-output-before-a-end") {
          await deliverInitialResult(client);
        }
        await submitFollowup(client);
        if (order === "parent-unregister-before-anchor") {
          await owner.unregister();
          parentRegistered = false;
        }
        if (!startObservedBeforeOutput) {
          await startTurn(client, "turn-a");
        }
        await completeTurn(client, "turn-a", "A result");
        if (order === "parent-output-before-a-end") {
          await deliverInitialResult(client);
        }
        if (order === "parent-unregister-before-anchor") {
          expect(submissionStore.record).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              callId: "send-b",
              predecessorNativeTurnId: "turn-a",
              submissionId: "turn-b",
            }),
            expect.any(Function),
          );
          expect(ownerStatesAtRecord).toEqual([false]);
        }
        await startTurn(client, "turn-b");
        await completeTurn(client, "turn-b", "B result");
        fixture.releaseHistory();
        await monitor.reconcileChildThread("child-thread");
        await owner.unregister();
        await setImmediate();

        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ childSessionKey: followupRunId, result: "B result" }),
        );
        if (order === "parent-unregister-before-anchor") {
          expect(submissionStore.consume).toHaveBeenCalledOnce();
          expect(receipts.size).toBe(0);
        }
      } finally {
        await fixture.close();
      }
    },
  );

  it("persists an admitted held receipt after detached observation loses its backing", async () => {
    const receipts = new Map<string, CodexNativeSubagentSubmission>();
    const recordEntered = createDeferred<void>();
    const releaseRecord = createDeferred<void>();
    let recordCompletion: Promise<boolean> | undefined;
    const submissionStore = {
      assertCurrent: () => {},
      read: async () => [...receipts.values()],
      record: vi.fn<CodexNativeSubagentSubmissionStore["record"]>((receipt, guard) => {
        recordCompletion = (async () => {
          recordEntered.resolve();
          await releaseRecord.promise;
          guard();
          receipts.set(receipt.callId, structuredClone(receipt));
          return true;
        })();
        return recordCompletion;
      }),
      consume: vi.fn<CodexNativeSubagentSubmissionStore["consume"]>(async () => false),
    } satisfies CodexNativeSubagentSubmissionStore;
    const fixture = await createFixture(submissionStore);
    const { client, monitor, owner } = fixture;
    try {
      await notifyChildStarted(client);
      await deliverInitialResult(client);
      await submitFollowup(client);
      await owner.unregister();
      await startTurn(client, "turn-a");
      await completeTurn(client, "turn-a", "A result");
      await recordEntered.promise;
      fixture.dropObservationBacking();
      fixture.releaseHistory();
      await monitor.reconcileChildThread("child-thread");
      await setImmediate();
      expect(receipts.size).toBe(0);
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);

      releaseRecord.resolve();
      await expect(recordCompletion).resolves.toBe(true);
      await setImmediate();
      expect([...receipts.values()]).toEqual([
        {
          parentTurnId: "parent-turn",
          callId: "send-b",
          childThreadId: "child-thread",
          submissionId: "turn-b",
          predecessorRunId: initialRunId,
          predecessorNativeTurnId: "turn-a",
        },
      ]);
      expect(submissionStore.consume).not.toHaveBeenCalled();
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);
    } finally {
      releaseRecord.resolve();
      await recordCompletion?.catch(() => undefined);
      await fixture.close();
    }
  });

  it("keeps an opaque steer from admitting completion or retaining observation after A catches up", async () => {
    const fixture = await createFixture();
    const { client, owner, runtime } = fixture;
    try {
      await notifyChildStarted(client);
      await submitFollowup(client, "opaque-steer-submission");
      await startTurn(client, "turn-a");
      await completeTurn(client, "turn-a", "A result");
      await deliverInitialResult(client);
      fixture.releaseHistory(threadRead({ turnId: "turn-a", result: "A result" }));
      await owner.unregister();
      await setImmediate();

      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
