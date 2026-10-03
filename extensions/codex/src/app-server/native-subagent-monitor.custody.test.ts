import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
    "replace",
    "revoked",
    "caller-revoked",
    "reject",
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
      const captureFailed = ending === "reject" || ending === "pending-reject";
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
          await client.notify({
            method: "item/completed",
            params: {
              threadId: "parent-thread",
              turnId: "parent-turn",
              item: directSpawnItem("v2", "parent-thread", "child-thread"),
            },
          });
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
          if (ending === "reject") {
            successor = await registerParent(monitor, "parent-thread", "agent:main:replacement");
          }
          if (successor) {
            successor.bindTurn("replacement-turn");
            await notifyChildStarted(client);
            expect(runtime.createAgentHarnessCompletionEventSink).not.toHaveBeenCalled();
            expect(replacement.live()).toHaveLength(1);
            await client.notify({
              method: "item/completed",
              params: {
                threadId: "parent-thread",
                turnId: "replacement-turn",
                item: directSpawnItem("v2", "parent-thread", "child-thread"),
              },
            });
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
