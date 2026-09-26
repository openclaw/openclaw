import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixture,
  completeInForeground,
  submitFollowup,
} from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  createClient,
  createNativeModelSourceFixture,
  notifyChildStarted,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { readCodexNativeSubagentSubmissions } from "./native-subagent-submission.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("native pending assignment inventory through registered monitor admission", () => {
  it.each(["committed", "rejected", "failed", "source-revoked", "binding-retired"] as const)(
    "withholds native inference authority until its exact assignment is acknowledged (%s)",
    async (outcome) => {
      const f = await fixture();
      const source = createNativeModelSourceFixture(["model-a"]);
      const client = createClient();
      const parent = await f.register(client, f.historyOwner(), source);
      await parent.ready;
      parent.bindTurn("parent-turn");
      // Forked children can reach inference before turn/started. The grant, not
      // a fabricated parent-history predecessor, must persist their actual turn.
      await f.spawn(client, false);
      const entered = createDeferred<void>();
      const releaseWrite = createDeferred<void>();
      const mutate = f.store.mutate.bind(f.store);
      vi.spyOn(f.store, "mutate").mockImplementation(async (identity, mutation, assertCurrent) => {
        if (
          mutation.kind === "record-native-subagent-assignment" &&
          mutation.assignment.nativeTurnId === "child-turn"
        ) {
          entered.resolve();
          await releaseWrite.promise;
          if (outcome === "failed") {
            throw new Error("Synthetic binding write failure");
          }
          if (outcome === "rejected") {
            return false;
          }
        }
        return await mutate(identity, mutation, assertCurrent);
      });
      const granted = vi.fn();
      const capture = codexNativeSubagentMonitorRuntime
        .captureModelSource({
          client: client.client,
          threadId: "child-thread",
          turnId: "child-turn",
          parentThreadId: "parent-thread",
          parentTurnId: "parent-turn",
          rootTurnId: "parent-turn",
        })
        .then(
          (value) => {
            granted();
            return { value, error: undefined };
          },
          (error: unknown) => ({ value: undefined, error }),
        );
      await Promise.race([
        entered.promise,
        capture.then(({ value, error }) => {
          throw new Error("Source grant settled without exact assignment persistence", {
            cause:
              error ??
              new Error(
                value ? "Source grant escaped before persistence" : "No admissible native source",
              ),
          });
        }),
      ]);
      await Promise.resolve();
      expect(granted).not.toHaveBeenCalled();
      if (outcome === "source-revoked") {
        source.release();
      }
      if (outcome === "binding-retired") {
        await f.store.retireSessionGeneration(f.identity);
      }
      releaseWrite.resolve();
      const result = await capture;
      if (outcome === "committed") {
        expect(result.error).toBeUndefined();
        assert(result.value);
        result.value.assertCurrent();
        expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            nativeTurnId: "child-turn",
          }),
        ]);
        result.value.release();
      } else {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.value).toBeUndefined();
        expect(granted).not.toHaveBeenCalled();
      }
      await parent.unregister();
      client.close();
    },
  );

  it.each([
    { rotate: false, observeTurn: true },
    { rotate: true, observeTurn: true },
    { rotate: false, observeTurn: false },
    { rotate: true, observeTurn: false },
  ])(
    "recovers an initial spawn after monitor loss ($rotate rotation, $observeTurn turn observed)",
    async ({ rotate, observeTurn }) => {
      const f = await fixture();
      const firstClient = createClient();
      const first = await f.register(firstClient);
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(firstClient, observeTurn);
      await first.unregister();
      first.closeCaller();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread",
          ...(observeTurn ? { nativeTurnId: "child-turn" } : {}),
        }),
      ]);
      // Initial spawn result agent_id is never interpreted as submission_id.
      expect(f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toEqual([]);
      firstClient.close();
      const owner = f.historyOwner(rotate ? "rotated-parent" : "parent-thread");
      if (rotate) {
        await f.store.mutate(f.identity, {
          kind: "replace-thread",
          expectedThreadId: "parent-thread",
          binding: { ...f.binding, threadId: owner.parentThreadId },
        });
      }
      const client = createClient();
      client.setThreadRead(
        "child-thread",
        threadRead({
          turnId: "child-turn",
          result: "Recovered initial result",
          resultPhase: "final_answer",
        }),
      );
      const recovered = await f.register(client, owner);
      await recovered.ready;
      expect(f.deliver).not.toHaveBeenCalled();
      await recovered.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      const delivered = f.deliver.mock.calls[0]?.[0];
      expect(delivered).toMatchObject({
        childSessionKey: "codex-thread:child-thread",
        result: "Recovered initial result",
        expectedRequester: {
          sessionId: "physical-1",
          lifecycleRevision: f.historyOwner().lifecycleRevision,
        },
      });
      expect(delivered?.completionCustody).toBeDefined();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, owner)).toEqual([]);
      client.close();
      const third = await f.register(createClient(), owner);
      await third.ready;
      await third.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "does not infer fork provenance from the current parent history (observed turn: %s)",
    async (observeTurn) => {
      const f = await fixture();
      const firstClient = createClient();
      const first = await f.register(firstClient);
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(firstClient, observeTurn);
      await first.unregister();
      firstClient.close();
      const client = createClient();
      const history = threadRead({
        turnId: "copied-parent-turn",
        result: "Parent final copied before rollback",
        resultPhase: "final_answer",
      });
      history.thread.forkedFromId = "parent-thread";
      const childHistory = threadRead({
        turnId: "child-turn",
        result: "Actual child result",
        resultPhase: "final_answer",
      });
      assert(history.thread.turns && childHistory.thread.turns);
      history.thread.turns.push(...childHistory.thread.turns);
      client.setThreadRead("child-thread", history);
      const parentHistory = threadRead({ childThreadId: "parent-thread" });
      parentHistory.thread.turns = [];
      client.setThreadRead("parent-thread", parentHistory);
      const recovered = await f.register(client);
      await recovered.ready;
      await recovered.unregister();
      if (observeTurn) {
        expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result: "Actual child result" }),
        );
        expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
      } else {
        expect(f.deliver).not.toHaveBeenCalled();
        expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
          expect.objectContaining({
            runId: "codex-thread:child-thread",
            childThreadId: "child-thread",
          }),
        ]);
      }
      expect(client.request).not.toHaveBeenCalledWith(
        "thread/read",
        expect.objectContaining({ threadId: "parent-thread" }),
        expect.anything(),
      );
    },
  );

  it.each(["missing-lineage", "wrong-lineage", "connection", "lifecycle", "session"])(
    "does not adopt pending native work under %s history ownership",
    async (scenario) => {
      const f = await fixture();
      const initialClient = createClient();
      const initial = await f.register(initialClient);
      await initial.ready;
      initial.bindTurn("parent-turn");
      await f.spawn(initialClient);
      await initial.unregister();
      initialClient.close();
      let owner = f.historyOwner();
      if (scenario === "connection") {
        owner = { ...owner, connectionFingerprint: "f".repeat(64) };
      } else if (scenario === "lifecycle") {
        owner = { ...owner, lifecycleRevision: "replacement" };
      } else if (scenario === "session") {
        owner = { ...owner, sessionId: "replacement" };
      }
      const client = createClient();
      const history = threadRead({
        turnId: "child-turn",
        parentThreadId: scenario === "wrong-lineage" ? "foreign-parent" : "parent-thread",
        result: "Must not deliver",
      });
      if (scenario === "missing-lineage") {
        delete history.thread.parentThreadId;
        history.thread.source = "unknown";
      }
      client.setThreadRead("child-thread", history);
      const recovered = await f.register(client, owner);
      await recovered.ready;
      await recovered.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toHaveLength(1);
    },
  );

  it.each(["binding", "gateway"] as const)(
    "revalidates %s authority after an awaited history read",
    async (authority) => {
      const f = await fixture();
      const firstClient = createClient();
      const first = await f.register(firstClient);
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(firstClient);
      await first.unregister();
      firstClient.close();
      const entered = createDeferred<void>();
      const history = createDeferred<ReturnType<typeof threadRead>>();
      const client = createClient();
      client.setThreadReadFactory("child-thread", () => {
        entered.resolve();
        return history.promise;
      });
      const recovered = await f.register(client);
      await Promise.race([
        entered.promise,
        recovered.ready.then(() => {
          throw new Error("Recovery completed without reading pending history");
        }),
      ]);
      if (authority === "binding") {
        await f.store.retireSessionGeneration(f.identity);
      } else {
        recovered.closeGateway();
      }
      history.resolve(threadRead({ turnId: "child-turn", result: "Revoked result" }));
      await recovered.ready;
      await recovered.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "recovers accepted follow-up after monitor loss (parent rotation: %s)",
    async (rotate) => {
      const f = await fixture();
      const client = createClient();
      const parent = await f.register(client);
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await completeInForeground(client);
      await submitFollowup(client);
      // No follow-up turn notification arrives before the monitor is lost.
      await parent.unregister();
      parent.closeCaller();
      const receipt = {
        parentTurnId: "parent-turn",
        callId: "followup",
        childThreadId: "child-thread",
        submissionId: "followup-turn",
        predecessorRunId: "codex-thread:child-thread",
        predecessorNativeTurnId: "child-turn",
      };
      expect(f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toEqual([
        receipt,
      ]);
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread:turn:followup-turn",
          submission: receipt,
        }),
      ]);
      expect(f.deliver).not.toHaveBeenCalled();
      client.close();
      const owner = f.historyOwner(rotate ? "rotated-parent" : "parent-thread");
      if (rotate) {
        await f.store.mutate(f.identity, {
          kind: "replace-thread",
          expectedThreadId: "parent-thread",
          binding: { ...f.binding, threadId: owner.parentThreadId },
        });
        expect(f.store.readNativeSubagentSubmissions(f.identity, owner)).toEqual([]);
      }
      const history = threadRead({
        turnId: "followup-turn",
        result: "Recovered follow-up",
        resultPhase: "final_answer",
      });
      const predecessor = threadRead({ turnId: "child-turn", result: "Native result" });
      assert(history.thread.turns && predecessor.thread.turns);
      history.thread.turns.unshift(...predecessor.thread.turns);
      const resumedClient = createClient();
      resumedClient.setThreadRead("child-thread", history);
      const resumed = await f.register(resumedClient, owner);
      await resumed.ready;
      expect(f.deliver).not.toHaveBeenCalled();
      await resumed.unregister();
      resumed.closeCaller();
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          childSessionKey: "codex-thread:child-thread:turn:followup-turn",
          result: "Recovered follow-up",
          announceId:
            "codex-native:parent-thread:codex-thread:child-thread:turn:followup-turn:succeeded",
        }),
      );
      expect(f.store.readNativeSubagentAssignments?.(f.identity, owner)).toEqual([]);
      expect(f.store.readNativeSubagentSubmissions(f.identity, owner)).toEqual([]);
      resumedClient.close();
      const duplicate = await f.register(createClient(), owner);
      await duplicate.ready;
      await duplicate.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
    },
  );

  it.each(["current", "session", "lifecycle", "connection", "lineage", "revoked"] as const)(
    "admits a fresh follow-up after native parent rotation only with current matching custody (%s)",
    async (scenario) => {
      const f = await fixture();
      const client = createClient();
      onTestFinished(() => {
        codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        codexNativeSubagentMonitorRuntime.retireParent(client.client, "rotated-parent");
        client.close();
      });
      f.deliver.mockImplementation(async ({ completionCustody }) => {
        assert(completionCustody?.isCurrent());
        return { delivered: false, path: "direct", recoveryPending: true };
      });
      const first = await f.register(client);
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(client);
      const history = threadRead({
        turnId: "child-turn",
        result: "A result",
        agentPath: "/root/worker",
        threadStatus: "notLoaded",
      });
      history.thread.modelProvider = "provider-b";
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [{ type: "agentMessage", id: "a-final", text: "A result" }],
        }),
      );
      await first.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      await f.store.mutate(f.identity, {
        kind: "replace-thread",
        expectedThreadId: "parent-thread",
        binding: { ...f.binding, threadId: "rotated-parent" },
      });
      const owner = f.historyOwner("rotated-parent");
      if (scenario === "session") {
        owner.sessionId = "other-session";
      } else if (scenario === "lifecycle") {
        owner.lifecycleRevision = "other-lifecycle";
      } else if (scenario === "connection") {
        owner.connectionFingerprint = "f".repeat(64);
      }
      client.setThreadRead("child-thread", history);
      const source = createNativeModelSourceFixture(["model-b"]);
      const replacement = await f.register(client, owner, source, {
        assertCurrent: source.assertCurrent,
        hasProvider: (provider) => provider === "provider-b",
      });
      await replacement.ready;
      replacement.bindTurn("rotated-turn");
      const entered = createDeferred<void>();
      const read = createDeferred<typeof history>();
      client.setThreadReadFactory("child-thread", ({ includeTurns }) => {
        if (includeTurns === false) {
          entered.resolve();
          return read.promise;
        }
        return history;
      });
      const input = codexNativeSubagentMonitorRuntime.prepareModelInput({
        client: client.client,
        threadId: "rotated-parent",
        turnId: "rotated-turn",
        itemId: "followup",
        target: "child-thread",
        readQualification: () => undefined,
        assertCurrent: () => {},
      });
      await entered.promise;
      if (scenario === "revoked") {
        replacement.closeGateway();
      }
      const metadata = structuredClone(history);
      if (scenario === "lineage") {
        metadata.thread.parentThreadId = "foreign-parent";
      }
      read.resolve(metadata);
      if (scenario !== "current") {
        await expect(input).rejects.toThrow();
        await replacement.unregister();
        client.close();
        return;
      }
      await input;
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "rotated-parent",
          turnId: "rotated-turn",
          item: {
            id: "followup",
            type: "collabAgentToolCall",
            tool: "sendInput",
            status: "completed",
            senderThreadId: "rotated-parent",
            receiverThreadIds: ["child-thread"],
          },
        },
      });
      await client.notify(
        successfulSendInputOutput({
          parentThreadId: "rotated-parent",
          turnId: "rotated-turn",
          callId: "followup",
          submissionId: "followup-turn",
        }),
      );
      await client.notify(turnStartedNotification("followup-turn"));
      const nativeRoot = threadRead({ childThreadId: "parent-thread", threadStatus: "notLoaded" });
      nativeRoot.thread.modelProvider = "provider-a";
      client.setThreadRead("parent-thread", nativeRoot);
      await expect(
        codexNativeSubagentMonitorRuntime.prepareModelInput({
          client: client.client,
          threadId: "child-thread",
          turnId: "followup-turn",
          itemId: "native-root",
          target: "/root",
          readQualification: () => undefined,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("does not admit this model");
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        { threadId: "parent-thread", includeTurns: false },
        expect.anything(),
      );
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "rotated-parent",
          turnId: "rotated-turn",
          item: {
            id: "wait-a",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "rotated-parent",
            receiverThreadIds: ["child-thread"],
            agentsStates: { "child-thread": { status: "completed", message: "A result" } },
          },
        },
      });
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, owner)).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread:turn:followup-turn",
          nativeParentThreadId: "parent-thread",
        }),
      ]);
      client.close();
    },
  );

  it.each(["initial", "followup", "empty"] as const)(
    "preserves closed-child settlement across retry exhaustion (%s)",
    async (assignment) => {
      const f = await fixture();
      const client = createClient();
      const parent = await f.register(client);
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      if (assignment === "followup") {
        await completeInForeground(client);
        await submitFollowup(client);
        await client.notify(turnStartedNotification("followup-turn"));
      }
      const turnId = assignment === "followup" ? "followup-turn" : "child-turn";
      if (assignment !== "empty") {
        await client.notify(
          childTurnCompletedNotification({
            turnId,
            status: "completed",
            items: [
              { id: "final", type: "agentMessage", phase: "final_answer", text: "Pending result" },
            ],
          }),
        );
      }
      client.setLoadedThreads([]);
      await client.notify(closeAgentNotification({ method: "item/started" }));
      await client.notify(closeAgentNotification({ method: "item/completed" }));
      f.deliver.mockResolvedValue({
        delivered: false,
        path: "direct",
        error: "Delivery unavailable",
      });
      await parent.unregister();
      await vi.advanceTimersByTimeAsync(600_000);
      const attempts = f.deliver.mock.calls.length;
      if (assignment === "empty") {
        expect(attempts).toBe(0);
      } else {
        expect(attempts).toBeGreaterThan(1);
      }
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.deliver).toHaveBeenCalledTimes(attempts);
      const saved = f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner());
      expect(saved).toHaveLength(assignment === "empty" ? 0 : 1);
      expect(f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toHaveLength(
        assignment === "followup" ? 1 : 0,
      );
      parent.closeCaller();
      client.close();
      f.deliver.mockClear();
      f.deliver.mockImplementation(async ({ completionCustody }) => {
        assert(completionCustody?.isCurrent());
        return { delivered: true, path: "direct" };
      });
      const recoveredClient = createClient();
      const history = threadRead({ turnId, result: "Pending result", resultPhase: "final_answer" });
      if (assignment === "followup") {
        const predecessor = threadRead({ turnId: "child-turn", result: "Native result" });
        assert(history.thread.turns && predecessor.thread.turns);
        history.thread.turns.unshift(...predecessor.thread.turns);
      }
      recoveredClient.setThreadRead("child-thread", history);
      const recovered = await f.register(recoveredClient);
      await recovered.ready;
      await recovered.unregister();
      if (assignment === "empty") {
        expect(f.deliver).not.toHaveBeenCalled();
      } else {
        expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result: "Pending result" }),
        );
      }
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
      expect(f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toEqual([]);
      recoveredClient.close();
      const duplicate = await f.register(createClient());
      await duplicate.ready;
      await duplicate.unregister();
      expect(f.deliver).toHaveBeenCalledTimes(assignment === "empty" ? 0 : 1);
    },
  );

  it("consumes native foreground delivery without a duplicate on re-registration", async () => {
    const f = await fixture();
    const client = createClient();
    const parent = await f.register(client);
    await parent.ready;
    parent.bindTurn("parent-turn");
    await f.spawn(client);
    await completeInForeground(client);
    await parent.unregister();
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    client.close();
    const recovered = await f.register(createClient());
    await recovered.ready;
    await recovered.unregister();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(() =>
      readCodexNativeSubagentSubmissions({
        version: 1,
        owner: f.historyOwner(),
        receipts: [
          { parentTurnId: "p", callId: "c", childThreadId: "child", submissionId: "child" },
        ],
      }),
    ).toThrow("Invalid Codex native subagent submission metadata");
  });
});
