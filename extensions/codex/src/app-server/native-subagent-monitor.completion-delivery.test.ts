import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  collabItem,
  itemNotification,
  agentMessage,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  registerParent,
  notifyChildStarted,
  nativeCompletionNotification,
  nativeHistoryOwner,
  deliveredNativeCompletion,
  childTurnCompletedNotification,
  threadRead,
  directSpawnItem,
  observeCompletionAttempts,
  parentRegistration as parentParams,
} from "./native-subagent-monitor.test-support.js";
import { createClientHarness } from "./test-support.js";

async function runtimeFixture(client = createClient(), runtime = createRuntime()) {
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
  const owner = await codexNativeSubagentMonitorRuntime.register({
    client: client.client,
    ...parentParams(),
    runtime,
  });
  onTestFinished(async () => {
    await owner.unregister();
    client.close();
  });
  return { client, runtime, owner };
}

async function monitorFixture(
  options?: ConstructorParameters<typeof CodexNativeSubagentMonitor>[2],
  registration: Partial<
    Parameters<InstanceType<typeof CodexNativeSubagentMonitor>["registerParent"]>[0]
  > = {},
  client = createClient(),
) {
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, options);
  const owner = await monitor.registerParent({ ...parentParams(), ...registration });
  onTestFinished(async () => {
    await owner.unregister();
    await monitor.dispose();
  });
  return { client, runtime, monitor, owner };
}

function storeFixture() {
  return {
    assertCurrent() {},
    async assertCurrentAsync() {},
    read: async () => [],
    record: vi.fn(async () => true),
    consume: vi.fn(async () => true),
  };
}

async function startChild(
  client: ReturnType<typeof createClient>,
  owner: Awaited<ReturnType<typeof registerParent>>,
  agentPath = "child-thread",
) {
  owner.bindTurn("parent-turn");
  await notifyChildStarted(client, "parent-thread", "child-thread", agentPath);
}

function completedChild(turnId = "child-turn", text = "The build passed.", id = "child-final") {
  return childTurnCompletedNotification({
    status: "completed",
    turnId,
    items: [{ type: "agentMessage", id, phase: "final_answer", text }],
  });
}

function waitReceipt(id: string, status: string, message: string | null) {
  return collabItem("wait", ["child-thread"], {
    id,
    agentsStates: { "child-thread": { status, message } },
  });
}

describe("native completion delivery ownership", () => {
  it("does not repeat a shutdown result returned by native wait", async () => {
    const { client, runtime, monitor, owner: parent } = await monitorFixture();
    await startChild(client, parent);
    await client.item(waitReceipt("wait-call", "shutdown", null));
    await client.completeNative({ statusLabel: "shutdown", turnId: "parent-turn" });
    await parent.unregister();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it.each([
    { receipt: "agent-message", order: "native-first" },
    { receipt: "contextual", order: "terminal-first" },
  ])("does not redeliver $receipt completion arriving $order", async ({ receipt, order }) => {
    const { client, runtime, owner } = await runtimeFixture();
    await startChild(client, owner, "/root/worker");
    if (order === "terminal-first") {
      await client.notify(completedChild());
    }
    await client.notify(
      receipt === "contextual"
        ? nativeCompletionNotification({ result: "The build passed.", turnId: "parent-turn" })
        : deliveredNativeCompletion(),
    );
    if (order === "native-first") {
      await client.notify(completedChild());
    }
    await owner.unregister();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  });

  it("defers delivery until unbound parent release and revokes admission on retirement", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const delivery = createDeferred<{ delivered: boolean; path: "direct" }>();
    runtime.deliverAgentHarnessCompletion.mockReturnValue(delivery.promise);
    const { owner } = await runtimeFixture(client, runtime);
    let retirement: Promise<void> | undefined;
    try {
      await notifyChildStarted(client);
      await client.notify(completedChild());
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      await owner.unregister();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "The build passed." }),
      );
      const canAdmit =
        runtime.deliverAgentHarnessCompletion.mock.calls[0]?.[0].isSourceSessionAdmissionAllowed;
      expect(canAdmit?.()).toBe(true);
      retirement = codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
      expect(canAdmit?.()).toBe(false);
    } finally {
      delivery.resolve({ delivered: true, path: "direct" });
      await delivery.promise;
      await retirement;
    }
  });

  it("defers completion when turn/started races ahead of the turn/start response", async () => {
    const { client, runtime, owner } = await monitorFixture();
    await client.startTurn("parent-turn", { threadId: "parent-thread" });
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    await client.notify(completedChild());
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    await client.notify(deliveredNativeCompletion());
    owner.bindTurn("parent-turn");
    await owner.unregister();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  });

  it("retains a rotated parent's child subscription until its receipt write settles", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const writeStarted = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    const assignmentStore = storeFixture();
    assignmentStore.consume.mockImplementation(async () => {
      writeStarted.resolve();
      await releaseWrite.promise;
      return true;
    });
    const claimChildThread = vi.fn(async () => {});
    const releaseChildThread = vi.fn(async (threadId: string) => {
      await client.client.request("thread/unsubscribe", { threadId });
    });
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      claimChildThread,
      releaseChildThread,
    });
    const parent = await monitor.registerParent({
      ...parentParams(),
      historyOwner: nativeHistoryOwner(),
      assignmentStore,
    });
    const observer = await registerParent(
      monitor,
      "rotated-parent",
      undefined,
      nativeHistoryOwner("rotated-parent"),
    );
    let receipt: Promise<void> | undefined;
    let retirement: Promise<void> | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      parent.bindTurn("parent-turn");
      observer.bindTurn("observer-turn");
      await notifyChildStarted(client);
      await client.startTurn("child-turn");
      await client.notify(completedChild());
      expect(claimChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
      receipt = client.item(waitReceipt("rotated-wait-receipt", "completed", "The build passed."));
      await writeStarted.promise;
      let retired = false;
      retirement = monitor.retireParent("rotated-parent").then(() => {
        retired = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(retired).toBe(false);
      expect(client.request).not.toHaveBeenCalledWith("thread/unsubscribe", expect.anything());
      releaseWrite.resolve();
      await Promise.all([receipt, retirement]);
      expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/unsubscribe", {
        threadId: "child-thread",
      });
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([receipt, retirement]);
      await parent.unregister();
      await observer.unregister();
      await monitor.dispose();
      client.close();
      vi.useRealTimers();
    }
  });

  it.each(["other-turn", "quoted-fragment"])(
    "does not acknowledge a completion from %s",
    async (source) => {
      const { client, runtime, owner } = await runtimeFixture();
      await startChild(client, owner, "/root/worker");
      const receipt = deliveredNativeCompletion();
      if (source === "other-turn") {
        receipt.params.turnId = "older-turn";
      } else {
        const part = receipt.params.item.content[0]!;
        part.text = `Example: ${part.text}`;
      }
      await client.notify(completedChild());
      await client.notify(receipt);
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      await owner.unregister();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
    },
  );

  it("applies a native receipt immediately when active recovery learns its agent path", async () => {
    const { client, runtime, monitor, owner } = await monitorFixture();
    await startChild(client, owner);
    await client.notify(completedChild());
    await client.startTurn("next-turn", { error: null });
    await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
    await client.sendInputOutput({ callId: "followup", submissionId: "next-turn" });
    await client.notify(deliveredNativeCompletion());
    const history = threadRead({
      agentPath: "/root/worker",
      previousResult: "The build passed.",
      turnId: "next-turn",
      status: "inProgress",
      threadStatus: "active",
    });
    history.thread.turns![0]!.id = "child-turn";
    client.setThreadRead("child-thread", history);
    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);
    await owner.unregister();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  });

  it("does not carry an unmatched receipt into a later parent run", async () => {
    const { client, runtime, monitor, owner: first } = await monitorFixture();
    first.bindTurn("parent-turn");
    await notifyChildStarted(client, "parent-thread", "waiting-child");
    await client.notify(deliveredNativeCompletion());
    await first.unregister();
    const second = await registerParent(monitor);
    second.bindTurn("next-turn");
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    await client.notify(completedChild());
    await second.unregister();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
    client.close();
  });

  it("delivers a deferred completion if the parent client closes", async () => {
    const { client, runtime, owner } = await monitorFixture();
    const delivered = createDeferred<void>();
    runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
      delivered.resolve();
      return { delivered: true, path: "direct" };
    });
    await startChild(client, owner);
    await client.notify(completedChild());
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    client.close();
    await delivered.promise;
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
    await owner.unregister();
  });
});

describe("native follow-up receipt custody", () => {
  it("retains an accepted submission until its native completion is delivered", async () => {
    const recorded = createDeferred<void>();
    const consumed = createDeferred<void>();
    const store = storeFixture();
    store.record.mockImplementation(async () => {
      recorded.resolve();
      return true;
    });
    store.consume.mockImplementation(async () => {
      consumed.resolve();
      return true;
    });
    const { client, runtime, owner } = await monitorFixture(undefined, {
      submissionStore: store,
      agentId: undefined,
    });
    await startChild(client, owner, "/root/worker");
    await client.startTurn("child-turn", { error: null });
    await client.notify(completedChild("child-turn", "The build passed.", "first-result"));
    await client.notify(deliveredNativeCompletion());
    await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
    await client.sendInputOutput({ callId: "followup", submissionId: "next-turn" });
    await recorded.promise;
    await client.startTurn("next-turn", { error: null });
    expect(store.consume).not.toHaveBeenCalled();
    await client.notify(completedChild("next-turn", "Follow-up complete.", "next-result"));
    expect(store.consume).not.toHaveBeenCalled();
    await owner.unregister();
    await consumed.promise;
    expect(store.consume).toHaveBeenCalledOnce();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "Follow-up complete." }),
    );
  });
});

describe("Codex native close admission", () => {
  it("retires the original native-child custody from a same-build module copy", async () => {
    const client = createClient();
    const releaseParentThread = vi.fn();
    const retainParentThread = vi.fn(() => releaseParentThread);
    ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
    const parent = await codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "parent-thread",
      runtime: createRuntime(),
      retainParentThread,
    });
    try {
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client);
      expect(retainParentThread).toHaveBeenCalledExactlyOnceWith("parent-thread");
      vi.resetModules();
      const { codexNativeSubagentMonitorRuntime: nextCopy } =
        await import("./native-subagent-monitor.js");
      expect(nextCopy).not.toBe(codexNativeSubagentMonitorRuntime);
      await nextCopy.retireParent(client.client, "parent-thread");
      expect(releaseParentThread).toHaveBeenCalledOnce();
      await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
      expect(releaseParentThread).toHaveBeenCalledOnce();
    } finally {
      await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
      await parent.unregister();
      client.close();
    }
  });

  it("preserves accepted completion across native close", async () => {
    const client = createClient();
    client.setLoadedThreads([]);
    const forget = vi.fn();
    const completions = observeCompletionAttempts();
    const {
      runtime,
      monitor,
      owner: parent,
    } = await monitorFixture({ captureChildThreadForget: async () => forget }, {}, client);
    try {
      await startChild(client, parent);
      await client.item(directSpawnItem("v1", "parent-thread", "child-thread"));
      await client.startTurn("child-turn");
      await client.closeAgent({ method: "item/started" });
      await client.completeTurn({
        status: "completed",
        items: [agentMessage("final", "Accepted result", "final_answer")],
      });
      await completions.settle();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      // Native close reports the child's previous status, not the close outcome.
      await client.closeAgent({ method: "item/completed", previousStatus: "running" });
      expect(forget).toHaveBeenCalledOnce();
      await parent.unregister();
      await completions.settle();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ childSessionId: "child-thread", result: "Accepted result" }),
      );
    } finally {
      await parent.unregister();
      await monitor.dispose();
      await completions.settle();
      completions.restore();
    }
  });

  it("preserves exact input grants across warm replacement and clears leftovers after unsubscribe", async () => {
    const client = createClient();
    const target = threadRead({ turnId: "child-a", result: "A finished" });
    target.thread.modelProvider = "test-provider";
    client.setThreadRead("child-thread", target);
    const qualification = {
      assertCurrent: () => {},
      hasProvider: (provider: string) => provider === "test-provider",
    };
    ensureCodexAppServerClientRuntime(client.client, { agentDir: "/workspace/agent" });
    let settleOwnership: (threadId: string) => Promise<unknown> = async () => {
      throw new Error("Missing existing receiver ownership queue");
    };
    class ObservedMonitor extends CodexNativeSubagentMonitor {
      constructor(...params: ConstructorParameters<typeof CodexNativeSubagentMonitor>) {
        super(...params);
        if (params[2]?.captureChildThreadForget) {
          settleOwnership = params[2].captureChildThreadForget;
        }
      }
    }
    const factory = createCodexNativeSubagentMonitorRuntime(ObservedMonitor);
    const a = { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() };
    const b = { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() };
    const first = await factory.register({
      client: client.client,
      parentThreadId: "parent-thread",
      runtime: createRuntime(),
      modelSource: a,
      configurationQualification: qualification,
    });
    first.bindTurn("parent-a");
    await notifyChildStarted(client);
    await client.item(directSpawnItem("v1", "parent-thread", "child-thread"), "parent-a");
    await client.startTurn("child-a");
    await client.finishTurn("child-a", agentMessage("a-final", "A finished"));
    await settleOwnership("child-thread");
    const second = await factory.register({
      client: client.client,
      parentThreadId: "parent-thread",
      modelSource: b,
      configurationQualification: qualification,
    });
    second.bindTurn("parent-b");
    try {
      for (const submissionId of ["child-b", "child-c", "opaque-steer"]) {
        await factory.prepareModelInput({
          client: client.client,
          threadId: "parent-thread",
          turnId: "parent-b",
          itemId: submissionId,
          target: "child-thread",
          readQualification: () => qualification,
          assertCurrent: () => {},
        });
        await client.sendInputOutput({
          turnId: "parent-b",
          callId: submissionId,
          submissionId,
        });
      }
      await first.unregister();
      await second.unregister();
      await client.startTurn("child-b");
      await settleOwnership("child-thread");
      const next = await factory.captureModelSource({
        client: client.client,
        threadId: "child-thread",
        turnId: "child-c",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-b",
        rootTurnId: "parent-b",
      });
      assert(next, "Warm replacement discarded another accepted exact model grant");
      expect(next.source).toBe(b);
      next.release();
      await client.finishTurn("child-b", agentMessage("b-final", "B finished"));
      await client.startTurn("child-c");
      await client.finishTurn("child-c", agentMessage("c-final", "C finished"));
      await settleOwnership("child-thread");
      expect(b.release).not.toHaveBeenCalled();
      await releaseCodexAppServerLiveThread(client.client, "child-thread");
      await settleOwnership("child-thread");
      expect(b.release).toHaveBeenCalledOnce();
    } finally {
      await first.unregister();
      await second.unregister();
      client.close();
    }
  });

  it("does not publish a claim invalidated before the factory await resumes", async () => {
    await withStateDirEnv("codex-close-claim-publication-", async ({ stateDir }) => {
      const sessionKey = "agent:main:close-claim-publication";
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "close-claim-publication",
        agentId: "main",
        sessionKey,
        config: {},
      });
      const scope = host.agentHarnessCompletionScope;
      assert(scope, "host did not mint a completion scope");
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: stateDir });
      const invalidateDuringClaim = vi.fn(() => {
        harness.send({ method: "thread/closed", params: { threadId: "child-thread" } });
      });
      const prior = await claimCodexAppServerLiveThread(
        harness.client,
        "child-thread",
        invalidateDuringClaim,
      );
      assert(prior, "prior native ownership missing");
      await retainCodexAppServerLiveThread(harness.client, "child-thread", prior.release);
      let captureForget: ((threadId: string) => Promise<(() => void) | undefined>) | undefined;
      class ObservedMonitor extends CodexNativeSubagentMonitor {
        constructor(...params: ConstructorParameters<typeof CodexNativeSubagentMonitor>) {
          super(...params);
          captureForget = params[2]?.captureChildThreadForget;
        }
      }
      const factory = createCodexNativeSubagentMonitorRuntime(ObservedMonitor);
      const parent = await factory.register({
        client: harness.client,
        parentThreadId: "parent-thread",
        requesterSessionKey: sessionKey,
        completionScope: scope,
        agentId: "main",
      });
      parent.bindTurn("parent-turn");
      try {
        harness.send(
          itemNotification({
            ...directSpawnItem("v1", "parent-thread", "child-thread"),
            id: "spawn-child",
          }),
        );
        assert(captureForget, "factory did not supply its captured-forget operation");
        await expect(captureForget("child-thread")).resolves.toBeUndefined();
        expect(invalidateDuringClaim).toHaveBeenCalledOnce();
        expect(isCodexAppServerLiveThreadClaimed(harness.client, "child-thread")).toBe(false);
        expect(harness.writes).toEqual([]);
      } finally {
        await factory.retireParent(harness.client, "parent-thread");
        await harness.client.closeAndWait();
        await parent.unregister();
        host.closeHost();
        host.closeAdmission();
      }
    });
  });

  it("settles a close completed before its extant parent owner binds the native turn", async () => {
    const client = createClient();
    client.setLoadedThreads([]);
    const forget = vi.fn();
    const releaseParentThread = vi.fn();
    const captureChildThreadForget = vi.fn(async () => forget);
    const { runtime, owner: parent } = await monitorFixture(
      { captureChildThreadForget, retainParentThread: () => releaseParentThread },
      {},
      client,
    );
    await notifyChildStarted(client);

    await client.closeAgent({ method: "item/started" });
    await client.closeAgent({ method: "item/completed" });
    expect(forget).not.toHaveBeenCalled();
    parent.bindTurn("parent-turn");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledOnce());

    expect(releaseParentThread).toHaveBeenCalledOnce();
    await client.completeNative();
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  });
});
