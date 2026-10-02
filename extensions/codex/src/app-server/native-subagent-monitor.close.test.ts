import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  directSpawnItem,
  successfulSendInputOutput,
  notifyChildStarted,
  registerParent,
  turnStartedNotification,
  threadRead,
  observeCompletionAttempts,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
): CodexServerNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

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
    const captureChildThreadForget = vi.fn(async () => forget);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      captureChildThreadForget,
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
  });
});
