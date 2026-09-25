import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRecordedRuntime,
  createRuntime,
  createTaskScope,
  childTurnCompletedNotification,
  directSpawnItem,
  nativeCompletionNotification,
  nativeHistoryOwner,
  notifyChildStarted,
  registerParent,
  successfulSendInputOutput,
  taskRecord,
  threadRead,
  turnStartedNotification,
  type CodexThreadReadResponse,
} from "./native-subagent-monitor.test-support.js";

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
  it.each([
    "ready",
    "dispose",
    "retire",
    "replace",
    "revoked",
    "caller-revoked",
    "reject",
    "overlap-reject",
    "pending-reject",
  ] as const)(
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
        taskRuntimeScope: createTaskScope("agent:main:original"),
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
      const captureFailed =
        ending === "reject" || ending === "overlap-reject" || ending === "pending-reject";
      const rejected =
        ending === "ready"
          ? undefined
          : expect(pending).rejects.toThrow(
              captureFailed ? failure : "registration is no longer current",
            );
      let pendingSuccessor: ReturnType<typeof registerParent> | undefined;
      try {
        await notifyChildStarted(client, "parent-thread", "early-child");
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: directSpawnItem("v2", "parent-thread", "early-child"),
          },
        });
        expect(claimChildThread).not.toHaveBeenCalled();
        expect(claimDirectChild).not.toHaveBeenCalled();
        expect(runtime.createAgentHarnessTaskRuntime).not.toHaveBeenCalled();
        expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
        await expect(registerParent(monitor, "parent-thread", "agent:main:other")).rejects.toThrow(
          "already bound to another session",
        );
        expect(runtime.captureAgentHarnessCompletionCustody).toHaveBeenCalledOnce();
        // Caller mutation during capture cannot change the captured registration.
        registration.requesterSessionKey = "agent:main:mutated";
        registration.taskRuntimeScope = createTaskScope("agent:main:mutated");
        let successor: Awaited<ReturnType<typeof registerParent>> | undefined;
        if (ending === "overlap-reject") {
          successor = await registerParent(monitor, "parent-thread", "agent:main:original");
        } else if (ending === "pending-reject") {
          pendingSuccessor = registerParent(monitor, "parent-thread", "agent:main:original");
        } else if (ending === "caller-revoked") {
          current = false;
        } else if (ending === "dispose") {
          monitor.dispose();
        } else if (ending === "retire" || ending === "replace") {
          monitor.retireParent("parent-thread");
          if (ending === "replace") {
            successor = await registerParent(monitor, "parent-thread", "agent:main:replacement");
          }
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
          expect(runtime.createAgentHarnessTaskRuntime).toHaveBeenCalledWith(
            expect.objectContaining({
              scope: expect.objectContaining({ requesterSessionKey: "agent:main:original" }),
            }),
          );
          owner.bindTurn("parent-turn");
          await client.notify({
            method: "item/completed",
            params: {
              threadId: "parent-thread",
              turnId: "parent-turn",
              item: directSpawnItem("v2", "parent-thread", "child-thread"),
            },
          });
          expect(claimDirectChild).toHaveBeenCalledExactlyOnceWith("child-thread");
          expect(runtime.createRunningTaskRun).toHaveBeenCalledOnce();
          await owner.unregister();
        } else {
          await rejected;
          expect(source.live()).toHaveLength(0);
          if (ending !== "replace" && ending !== "overlap-reject") {
            expect(runtime.createAgentHarnessTaskRuntime).not.toHaveBeenCalled();
          }
          if (pendingSuccessor) {
            nextCapture.resolve(replacement.root);
            successor = await pendingSuccessor;
          }
          if (ending === "reject") {
            successor = await registerParent(monitor, "parent-thread", "agent:main:replacement");
          }
          if (successor) {
            successor.bindTurn("replacement-turn");
            await notifyChildStarted(client);
            expect(runtime.createRunningTaskRun).toHaveBeenCalledOnce();
            expect(replacement.live()).toHaveLength(1);
            await successor.unregister();
          }
        }
      } finally {
        monitor.dispose();
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

  it("rechecks the cached runtime before registration and releases rejected custody", async () => {
    const runtime = createRuntime();
    const first = createCustody();
    const rejected = createCustody();
    runtime.captureAgentHarnessCompletionCustody
      .mockResolvedValueOnce(first.root)
      .mockResolvedValueOnce(rejected.root);
    const monitor = new CodexNativeSubagentMonitor(createClient() as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    try {
      const parent = await registerParent(monitor);
      const failure = new Error("captured task runtime retired");
      runtime.assertTaskAssignmentSupported.mockImplementationOnce(() => {
        throw failure;
      });
      await expect(registerParent(monitor)).rejects.toThrow(failure);
      expect(runtime.createAgentHarnessTaskRuntime).toHaveBeenCalledOnce();
      expect(runtime.assertTaskAssignmentSupported).toHaveBeenCalledTimes(2);
      expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(first.live()).toHaveLength(1);
      expect(rejected.live()).toHaveLength(0);
      await parent.unregister();
      expect(first.live()).toHaveLength(0);
    } finally {
      monitor.dispose();
    }
  });

  it.each(["delivered", "retry", "closed", "exhausted"] as const)(
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
      if (ending !== "delivered") {
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: false,
          path: "none",
        });
      }
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [1],
        completionDeliveryMaxRetries: 1,
      });
      const owner = await registerParent(monitor);
      const other = await registerParent(monitor);
      other.bindTurn("other-turn");
      // Native spawn evidence can arrive before the admitting turn/start response.
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", "child-thread"),
        },
      });
      owner.bindTurn("parent-turn");
      await owner.unregister();
      expect(first.live()).toHaveLength(1);
      await other.unregister();
      expect(second.live()).toHaveLength(0);
      await client.notify(nativeCompletionNotification({ agentPath: "/root/child-thread" }));
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      expect(first.holds).toContain(
        runtime.deliverAgentHarnessTaskCompletion.mock.calls[0]![0].completionCustody,
      );
      expect(first.executions.size).toBe(0);
      if (ending === "closed") {
        monitor.dispose();
        expect(first.live()).toHaveLength(1);
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: true,
          path: "direct",
        });
        await vi.advanceTimersByTimeAsync(1);
      } else if (ending === "retry") {
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: true,
          path: "direct",
        });
        await vi.advanceTimersByTimeAsync(1);
      } else if (ending === "exhausted") {
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
          expect.objectContaining({ deliveryStatus: "failed" }),
        );
      }
      expect(first.live()).toHaveLength(0);
      monitor.dispose();
    },
  );

  it("retains fresh recovery custody while history outlives its parent registration", async () => {
    const client = createClient();
    const history = nativeHistoryOwner();
    const task = taskRecord({
      childThreadId: "child-thread",
      status: "succeeded",
      deliveryStatus: "pending",
      historyOwner: history,
    });
    const runtime = createRecordedRuntime(new Map([[task.runId!, task]]));
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
    const historyRead = createDeferred<CodexThreadReadResponse>();
    const delivered = createDeferred<void>();
    client.setThreadReadFactory("child-thread", () => historyRead.promise);
    runtime.deliverAgentHarnessTaskCompletion.mockImplementation(async ({ completionCustody }) => {
      expect(completionCustody?.signal.aborted).toBe(false);
      expect(source.holds).toContain(completionCustody);
      delivered.resolve();
      return { delivered: true, path: "direct" };
    });
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const parent = await registerParent(
      monitor,
      "parent-thread",
      task.requesterSessionKey,
      history,
    );
    await parent.unregister();
    expect(source.live()).toHaveLength(1);
    historyRead.resolve(threadRead({ result: "recovered result" }));
    await delivered.promise;
    await source.released;
    monitor.dispose();
    expect(source.live()).toHaveLength(0);
  });

  it("releases interrupted execution and disposes all children after stale event custody", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
    const emit = vi.fn();
    runtime.createAgentHarnessTaskEventSink.mockReturnValue(emit);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const parent = await registerParent(monitor);
    parent.bindTurn("parent-turn");
    for (const child of ["child-thread", "other-child"]) {
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", child),
        },
      });
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
    expect(() => monitor.dispose()).not.toThrow();
    expect(source.live()).toHaveLength(0);
    expect(source.executions.size).toBe(0);
  });

  it("lets a replacement owner recover while retired history remains blocked", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const history = nativeHistoryOwner();
    const task = taskRecord({
      childThreadId: "child-thread",
      status: "succeeded",
      deliveryStatus: "pending",
      historyOwner: history,
    });
    const runtime = createRecordedRuntime(new Map([[task.runId!, task]]));
    const retired = createCustody();
    const replacement = createCustody();
    runtime.captureAgentHarnessCompletionCustody
      .mockResolvedValueOnce(retired.root)
      .mockResolvedValueOnce(replacement.root);
    const oldRead = createDeferred<CodexThreadReadResponse>();
    const nextRead = createDeferred<CodexThreadReadResponse>();
    const oldReadStarted = createDeferred<void>();
    const nextReadStarted = createDeferred<void>();
    let reads = 0;
    client.setThreadReadFactory("child-thread", () => {
      if (reads++ === 0) {
        oldReadStarted.resolve();
        return oldRead.promise;
      }
      nextReadStarted.resolve();
      return nextRead.promise;
    });
    const delivered = createDeferred<void>();
    runtime.deliverAgentHarnessTaskCompletion.mockImplementation(async ({ completionCustody }) => {
      expect(replacement.holds).toContain(completionCustody);
      expect(completionCustody?.signal.aborted).toBe(false);
      delivered.resolve();
      return { delivered: true, path: "direct" };
    });
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    try {
      const parent = await registerParent(
        monitor,
        "parent-thread",
        task.requesterSessionKey,
        history,
      );
      await oldReadStarted.promise;
      await parent.unregister();
      monitor.retireParent("parent-thread");
      expect(retired.live()).toHaveLength(0);
      const next = await registerParent(
        monitor,
        "parent-thread",
        task.requesterSessionKey,
        history,
      );
      await nextReadStarted.promise;
      await next.unregister();
      expect(replacement.live()).toHaveLength(1);
      nextRead.resolve(threadRead({ result: "replacement result" }));
      await delivered.promise;
      await replacement.released;
      const deliveredTask = {
        taskId: task.taskId,
        runId: task.runId,
        status: "succeeded",
        deliveryStatus: "delivered",
      };
      expect(runtime.listTaskRecords()).toEqual([expect.objectContaining(deliveredTask)]);
      oldRead.resolve(threadRead({ result: "retired result" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      expect(runtime.listTaskRecords()).toEqual([expect.objectContaining(deliveredTask)]);
      expect(replacement.live()).toHaveLength(0);
    } finally {
      monitor.dispose();
      oldRead.resolve(threadRead());
      nextRead.resolve(threadRead());
    }
  });

  it.each(["dispose", "retire"] as const)(
    "releases in-flight recovery custody immediately on %s",
    async (ending) => {
      const client = createClient();
      const history = nativeHistoryOwner();
      const task = taskRecord({ childThreadId: "child-thread", historyOwner: history });
      const runtime = createRecordedRuntime(new Map([[task.runId!, task]]));
      const source = createCustody();
      runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
      const historyRead = createDeferred<CodexThreadReadResponse>();
      client.setThreadReadFactory("child-thread", () => historyRead.promise);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      const parent = await registerParent(
        monitor,
        "parent-thread",
        task.requesterSessionKey,
        history,
      );
      await parent.unregister();
      expect(source.live()).toHaveLength(1);
      expect(source.executions.size).toBe(1);
      if (ending === "dispose") {
        monitor.dispose();
      } else {
        monitor.retireParent("parent-thread");
      }
      expect(source.live()).toHaveLength(0);
      expect(source.executions.size).toBe(0);
      historyRead.resolve(threadRead({ result: "stale result" }));
      monitor.dispose();
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    },
  );

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
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: directSpawnItem("v2", "parent-thread", "child-thread"),
      },
    });
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
    monitor.dispose();
    expect(source.live()).toHaveLength(0);
  });

  it("releases custody after inspecting a replaced physical requester's history", async () => {
    const client = createClient();
    const source = createCustody();
    const task = taskRecord({
      childThreadId: "foreign-child",
      status: "succeeded",
      deliveryStatus: "pending",
      historyOwner: { ...nativeHistoryOwner(), sessionId: "old-session" },
    });
    const runtime = createRecordedRuntime(new Map([[task.runId!, task]]));
    runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(source.root);
    const readStarted = createDeferred<void>();
    const historyRead = createDeferred<CodexThreadReadResponse>();
    client.setThreadReadFactory("foreign-child", () => {
      readStarted.resolve();
      return historyRead.promise;
    });
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    try {
      const parent = await registerParent(
        monitor,
        "parent-thread",
        task.requesterSessionKey,
        nativeHistoryOwner(),
      );
      await readStarted.promise;
      await parent.unregister();
      expect(source.live()).toHaveLength(1);
      historyRead.resolve(threadRead({ childThreadId: "foreign-child", result: "old result" }));
      await source.released;
      expect(source.live()).toHaveLength(0);
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    } finally {
      monitor.dispose();
      historyRead.resolve(threadRead({ childThreadId: "foreign-child" }));
    }
  });
});
