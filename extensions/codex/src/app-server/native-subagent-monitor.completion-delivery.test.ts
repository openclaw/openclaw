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
import {
  buildEmptyToolTelemetry,
  CodexAppServerEventProjector,
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import { createCodexNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  registerParent,
  notifyChildStarted,
  successfulSendInputOutput,
  nativeCompletionNotification,
  nativeHistoryOwner,
  deliveredNativeCompletion,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  closeAgentNotification,
  directSpawnItem,
  observeCompletionAttempts,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentAssignmentStore } from "./native-subagent-pending-assignments.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
): CodexServerNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

async function registerRuntimeOwner(
  client: ReturnType<typeof createClient>,
  runtime: ReturnType<typeof createRuntime>,
) {
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
  return codexNativeSubagentMonitorRuntime.register({
    client: client.client,
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:discord:channel:C123",
    completionScope: createCompletionScope(),
    agentId: "main",
    runtime,
  });
}

function completedChild(turnId = "child-turn", text = "The build passed.", id = "child-final") {
  return childTurnCompletedNotification({
    status: "completed",
    turnId,
    items: [{ type: "agentMessage", id, phase: "final_answer", text }],
  });
}

describe("CodexNativeSubagentMonitor", () => {
  describe("native completion delivery ownership", () => {
    registerCodexEventProjectorTestLifecycle();

    it("does not repeat a shutdown result returned by native wait", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime);
      const parent = await registerParent(monitor);
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(
        itemNotification({
          type: "collabAgentToolCall",
          id: "wait-call",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "shutdown", message: null } },
        }),
      );
      await client.notify(
        nativeCompletionNotification({ statusLabel: "shutdown", turnId: "parent-turn" }),
      );
      await parent.unregister();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      await monitor.dispose();
    });

    it.each([
      {
        receipt: "agent-message",
        order: "native-first",
      },
      {
        receipt: "contextual",
        order: "terminal-first",
      },
    ])(
      "preserves the parent answer when $receipt delivery and child completion arrive $order",
      async ({ receipt, order }) => {
        const final = "The build passed. The change is ready.";
        const client = createClient();
        const runtime = createRuntime();
        const owner = await registerRuntimeOwner(client, runtime);
        owner.bindTurn("parent-turn");
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        const projector = new CodexAppServerEventProjector(
          await createParams(),
          "parent-thread",
          "parent-turn",
        );
        let lastAnswer = "";
        const answer = async (text: string, id: string) => {
          lastAnswer = text;
          await projector.handleNotification({
            method: "item/completed",
            params: {
              threadId: "parent-thread",
              turnId: "parent-turn",
              item: { type: "agentMessage", id, phase: "final_answer", text },
            },
          });
        };
        runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
          await answer("NO_REPLY", "duplicate-answer");
          return { delivered: true, path: "steered" };
        });
        try {
          if (order === "terminal-first") {
            await client.notify(completedChild());
          }
          await client.notify(
            receipt === "contextual"
              ? nativeCompletionNotification({ result: "The build passed.", turnId: "parent-turn" })
              : deliveredNativeCompletion(),
          );
          await answer(final, "parent-answer");
          if (order === "native-first") {
            await client.notify(completedChild());
          }
          await projector.handleNotification({
            method: "turn/completed",
            params: {
              threadId: "parent-thread",
              turn: {
                id: "parent-turn",
                status: "completed",
                items: [{ type: "agentMessage", id: "last-answer", text: lastAnswer }],
                error: null,
              },
            },
          });
          await owner.unregister();
          expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([final]);
          expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        } finally {
          await owner.unregister();
          client.close();
        }
      },
    );

    it("defers delivery until unbound parent release and revokes admission on retirement", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const delivery = createDeferred<{ delivered: boolean; path: "direct" }>();
      runtime.deliverAgentHarnessCompletion.mockReturnValue(delivery.promise);
      client.request.mockImplementation(async (method) => {
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const owner = await registerRuntimeOwner(client, runtime);
      let retirement: Promise<void> | undefined;
      try {
        await notifyChildStarted(client);
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        await owner.unregister();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
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
        await owner.unregister();
        client.close();
      }
    });

    it("defers completion when turn/started races ahead of the turn/start response", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = await registerParent(monitor);
      try {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        await client.notify(deliveredNativeCompletion());
        owner.bindTurn("parent-turn");
        await owner.unregister();
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        await owner.unregister();
        client.close();
      }
    });

    it("retains a rotated parent's child subscription until its receipt write settles", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const writeStarted = createDeferred<void>();
      const releaseWrite = createDeferred<void>();
      const assignmentStore: CodexNativeSubagentAssignmentStore = {
        assertCurrent() {},
        async assertCurrentAsync() {},
        read: async () => [],
        record: async () => true,
        consume: async () => {
          writeStarted.resolve();
          await releaseWrite.promise;
          return true;
        },
      };
      const claimChildThread = vi.fn(async () => {});
      const releaseChildThread = vi.fn(async (threadId: string) => {
        await client.client.request("thread/unsubscribe", { threadId });
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        claimChildThread,
        releaseChildThread,
      });
      const parent = await monitor.registerParent({
        parentThreadId: "parent-thread",
        agentId: "main",
        requesterSessionKey: "agent:main:discord:channel:C123",
        completionScope: createCompletionScope(),
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
        await client.notify(turnStartedNotification("child-turn"));
        await client.notify(completedChild());
        expect(claimChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
        receipt = client.notify(
          itemNotification({
            id: "rotated-wait-receipt",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["child-thread"],
            agentsStates: {
              "child-thread": { status: "completed", message: "The build passed." },
            },
          }),
        );
        await writeStarted.promise;
        let retired = false;
        retirement = monitor.retireParent("rotated-parent").then(() => {
          retired = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(retired).toBe(false);
        expect(releaseChildThread).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalledWith("thread/unsubscribe", expect.anything());
        releaseWrite.resolve();
        await Promise.all([receipt, retirement]);
        expect(releaseChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
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
        const client = createClient();
        const runtime = createRuntime();
        const owner = await registerRuntimeOwner(client, runtime);
        owner.bindTurn("parent-turn");
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        const receipt = deliveredNativeCompletion();
        if (source === "other-turn") {
          receipt.params.turnId = "older-turn";
        } else {
          const part = receipt.params.item.content[0]!;
          part.text = `Example: ${part.text}`;
        }
        try {
          await client.notify(completedChild());
          await client.notify(receipt);
          expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
          await owner.unregister();
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        } finally {
          await owner.unregister();
          client.close();
        }
      },
    );

    it("applies a native receipt immediately when active recovery learns its agent path", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      onTestFinished(() => monitor.dispose());
      const owner = await registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      await client.notify(turnStartedNotification("next-turn", { error: null }));
      await client.notify(
        itemNotification({
          type: "collabAgentToolCall",
          id: "followup",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        }),
      );
      await client.notify(
        successfulSendInputOutput({ callId: "followup", submissionId: "next-turn" }),
      );
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
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const first = await registerParent(monitor);
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
      const client = createClient();
      const runtime = createRuntime();
      const delivered = createDeferred<void>();
      runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
        delivered.resolve();
        return { delivered: true, path: "direct" };
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = await registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      client.close();
      await delivered.promise;
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      await owner.unregister();
    });
  });
});

describe("native follow-up receipt custody", () => {
  it("retains an accepted submission until its native completion is delivered", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const recorded = createDeferred<void>();
    const consumed = createDeferred<void>();
    const store = {
      assertCurrent() {},
      async assertCurrentAsync() {},
      read: async () => [],
      record: vi.fn(async () => {
        recorded.resolve();
        return true;
      }),
      consume: vi.fn(async () => {
        consumed.resolve();
        return true;
      }),
    };
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      recoveryPollDelaysMs: [],
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      completionScope: createCompletionScope(),
      submissionStore: store,
    });
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    await client.notify(turnStartedNotification("child-turn", { error: null }));
    await client.notify(completedChild("child-turn", "The build passed.", "first-result"));
    await client.notify(deliveredNativeCompletion());
    await client.notify(
      itemNotification({
        type: "collabAgentToolCall",
        id: "followup",
        tool: "sendInput",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
      }),
    );
    await client.notify(
      successfulSendInputOutput({ callId: "followup", submissionId: "next-turn" }),
    );
    await recorded.promise;
    await client.notify(turnStartedNotification("next-turn", { error: null }));
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
    const runtime = createRuntime();
    const forget = vi.fn();
    const completions = observeCompletionAttempts();
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      recoveryPollDelaysMs: [],
      captureChildThreadForget: async () => forget,
    });
    const parent = await registerParent(monitor);
    parent.bindTurn("parent-turn");
    try {
      await notifyChildStarted(client);
      await client.notify(itemNotification(directSpawnItem("v1", "parent-thread", "child-thread")));
      await client.notify(turnStartedNotification("child-turn"));
      await client.notify(closeAgentNotification({ method: "item/started" }));
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: "final",
              phase: "final_answer",
              text: "Accepted result",
            },
          ],
        }),
      );
      await completions.settle();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      // Native close reports the child's previous status, not the close outcome.
      await client.notify(
        closeAgentNotification({ method: "item/completed", previousStatus: "running" }),
      );
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
        super(params[0], params[1], { ...params[2], recoveryPollDelaysMs: [] });
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
    await client.notify(
      itemNotification(directSpawnItem("v1", "parent-thread", "child-thread"), "parent-a"),
    );
    await client.notify(turnStartedNotification("child-a"));
    await client.notify(
      childTurnCompletedNotification({
        turnId: "child-a",
        status: "completed",
        items: [{ type: "agentMessage", id: "a-final", text: "A finished" }],
      }),
    );
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
        await client.notify(
          successfulSendInputOutput({
            turnId: "parent-b",
            callId: submissionId,
            submissionId,
          }),
        );
      }
      await first.unregister();
      await second.unregister();
      await client.notify(turnStartedNotification("child-b"));
      await settleOwnership("child-thread");
      const next = await factory.captureModelSource({
        client: client.client,
        threadId: "child-thread",
        turnId: "child-c",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-b",
        rootTurnId: "parent-b",
      });
      if (!next) {
        throw new Error("Warm replacement discarded another accepted exact model grant");
      }
      expect(next.source).toBe(b);
      next.release();
      await client.notify(
        childTurnCompletedNotification({
          turnId: "child-b",
          status: "completed",
          items: [{ type: "agentMessage", id: "b-final", text: "B finished" }],
        }),
      );
      await client.notify(turnStartedNotification("child-c"));
      await client.notify(
        childTurnCompletedNotification({
          turnId: "child-c",
          status: "completed",
          items: [{ type: "agentMessage", id: "c-final", text: "C finished" }],
        }),
      );
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
      if (!scope) {
        throw new Error("host did not mint a completion scope");
      }
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
      if (!prior) {
        throw new Error("prior native ownership missing");
      }
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
        if (!captureForget) {
          throw new Error("factory did not supply its captured-forget operation");
        }
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
    const runtime = createRuntime();
    const forget = vi.fn();
    const releaseParentThread = vi.fn();
    const captureChildThreadForget = vi.fn(async () => forget);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      captureChildThreadForget,
      retainParentThread: () => releaseParentThread,
    });
    const parent = await registerParent(monitor);
    onTestFinished(() => monitor.dispose());
    await notifyChildStarted(client);

    await client.notify(closeAgentNotification({ method: "item/started" }));
    await client.notify(closeAgentNotification({ method: "item/completed" }));
    expect(forget).not.toHaveBeenCalled();
    parent.bindTurn("parent-turn");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledOnce());

    expect(captureChildThreadForget).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(releaseParentThread).toHaveBeenCalledOnce();
    await client.notify(nativeCompletionNotification());
    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  });
});
