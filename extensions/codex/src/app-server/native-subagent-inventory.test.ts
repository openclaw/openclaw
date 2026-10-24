import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixture,
  completeInForeground,
  submitFollowup,
} from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  collabItem,
  createClient,
  createNativeModelSourceFixture,
  directSpawnItem,
  notifyChildStarted,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { readCodexNativeSubagentSubmissions } from "./native-subagent-submission.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import { bindingStoreKey } from "./session-binding-record.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());
setupRunAttemptTestHooks();

function finalHistory(turnId: string, result: string) {
  return threadRead({ turnId, result, resultPhase: "final_answer" });
}

async function startAssignment(observeTurn = true) {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(client);
  await parent.ready;
  parent.bindTurn("parent-turn");
  await f.spawn(client, observeTurn);
  return { f, client, parent };
}

async function startNestedAssignment() {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(
    client,
    f.historyOwner(),
    createNativeModelSourceFixture(["model-a"]),
  );
  await parent.ready;
  parent.bindTurn("parent-turn");
  await f.spawn(client);
  await notifyChildStarted(client, "child-thread", "grandchild", "/root/child/grandchild");
  await client.item(
    directSpawnItem("v2", "child-thread", "grandchild"),
    "child-turn",
    "child-thread",
  );
  await client.notify({
    method: "turn/started",
    params: { threadId: "grandchild", turn: { id: "grandchild-turn" } },
  });
  const capture = await codexNativeSubagentMonitorRuntime.captureModelSource({
    client: client.client,
    threadId: "grandchild",
    turnId: "grandchild-turn",
    parentThreadId: "child-thread",
    parentTurnId: "child-turn",
    rootTurnId: "parent-turn",
  });
  assert(capture);
  capture.release();
  return { f, client, parent };
}

describe("native pending assignment inventory through registered monitor admission", () => {
  it("acknowledges a grandchild's native completion without root delivery or restart replay", async () => {
    const { f, client, parent } = await startNestedAssignment();
    expect(await f.assignments()).toEqual([
      expect.objectContaining({ childThreadId: "child-thread" }),
      expect.objectContaining({
        childThreadId: "grandchild",
        nativeParentThreadId: "child-thread",
      }),
    ]);
    await client.completeTurn({
      threadId: "grandchild",
      turnId: "grandchild-turn",
      status: "completed",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Nested result" }],
    });
    await completeInForeground(client);
    await parent.unregister();
    expect(await f.assignments()).toEqual([]);
    expect(f.deliver).not.toHaveBeenCalled();
    client.close();
    const recovered = await f.settle(createClient());
    expect(recovered.listPendingChildren()).toEqual([]);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each(["available", "unavailable", "revoked"] as const)(
    "settles a restored grandchild only with native lineage and current custody (%s)",
    async (scenario) => {
      const { f, client, parent } = await startNestedAssignment();
      await completeInForeground(client);
      await parent.unregister();
      client.close();
      const saved = await f.assignments();
      expect(saved).toEqual([expect.objectContaining({ childThreadId: "grandchild" })]);
      const recoveredClient = createClient();
      recoveredClient.setThreadRead(
        "grandchild",
        threadRead({
          childThreadId: "grandchild",
          parentThreadId: "child-thread",
          turnId: "grandchild-turn",
          result: "Nested result",
          resultPhase: "final_answer",
        }),
      );
      const metadata = threadRead({ childThreadId: "child-thread", directParentField: false });
      const entered = createDeferred<void>();
      const release = createDeferred<typeof metadata>();
      recoveredClient.setThreadReadFactory("child-thread", () => {
        if (scenario === "unavailable") {
          throw new Error("Native middle thread is temporarily unavailable");
        }
        if (scenario === "revoked") {
          entered.resolve();
          return release.promise;
        }
        return metadata;
      });
      const recovered = await f.register(recoveredClient);
      if (scenario === "revoked") {
        await entered.promise;
        recovered.closeGateway();
        release.resolve(metadata);
      }
      await recovered.ready;
      await recovered.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(await f.assignments()).toEqual(scenario === "available" ? [] : saved);
      if (scenario !== "available") {
        recoveredClient.setThreadRead("child-thread", metadata);
        await f.settle(recoveredClient);
        expect(await f.assignments()).toEqual([]);
      }
      recoveredClient.close();
      const restarted = await f.settle(createClient());
      expect(restarted.listPendingChildren()).toEqual([]);
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );

  it("settles restoration writes before reading the next assignment or reporting readiness", async () => {
    const f = await fixture();
    const assignments = ["first-child", "second-child"].map((childThreadId) => ({
      runId: `codex-thread:${childThreadId}`,
      childThreadId,
      nativeTurnId: `${childThreadId}-turn`,
      nativeParentThreadId: "parent-thread",
      owner: f.historyOwner(),
    }));
    for (const assignment of assignments) {
      await f.record(assignment);
    }
    const entered = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    let writing = false;
    const mutate = f.store.mutate.bind(f.store);
    vi.spyOn(f.store, "mutate").mockImplementation(
      async (identity, mutation, assertCurrent, authority) => {
        if (mutation.kind !== "record-native-subagent-assignment") {
          return await mutate(identity, mutation, assertCurrent, authority);
        }
        writing = true;
        entered.resolve();
        try {
          await releaseWrite.promise;
          return await mutate(identity, mutation, assertCurrent, authority);
        } finally {
          writing = false;
        }
      },
    );
    const readAssignments = f.store.readNativeSubagentAssignments!.bind(f.store);
    const conflictingRead = vi.fn();
    vi.spyOn(f.store, "readNativeSubagentAssignments").mockImplementation(async (...args) => {
      if (writing) {
        conflictingRead();
        throw new Error("Plugin state authority is unavailable");
      }
      return await readAssignments(...args);
    });
    const client = createClient();
    for (const assignment of assignments) {
      client.setThreadRead(
        assignment.childThreadId,
        threadRead({
          childThreadId: assignment.childThreadId,
          turnId: assignment.nativeTurnId,
          result: `Recovered ${assignment.childThreadId}`,
          resultPhase: "final_answer",
        }),
      );
    }
    const parent = await f.register(client);
    let ready = false;
    void parent.ready.then(() => {
      ready = true;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(false);
      expect(conflictingRead).not.toHaveBeenCalled();
      releaseWrite.resolve();
      await parent.ready;
      expect(ready).toBe(true);
      expect(conflictingRead).not.toHaveBeenCalled();
      expect(parent.listPendingChildren()).toHaveLength(2);
      expect(await f.assignments()).toEqual(
        assignments.map((assignment) => expect.objectContaining(assignment)),
      );
    } finally {
      releaseWrite.resolve();
      await parent.unregister();
      client.close();
    }
  });

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
      vi.spyOn(f.store, "mutate").mockImplementation(
        async (identity, mutation, assertCurrent, authority) => {
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
          return await mutate(identity, mutation, assertCurrent, authority);
        },
      );
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
        expect(await f.assignments()).toEqual([
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
    { rotate: true, observeTurn: false },
  ])(
    "recovers an initial spawn after monitor loss ($rotate rotation, $observeTurn turn observed)",
    async ({ rotate, observeTurn }) => {
      const { f, client: firstClient, parent: first } = await startAssignment(observeTurn);
      await first.unregister();
      first.closeCaller();
      expect(await f.assignments()).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread",
          ...(observeTurn ? { nativeTurnId: "child-turn" } : {}),
        }),
      ]);
      // Initial spawn result agent_id is never interpreted as submission_id.
      expect(await f.submissions()).toEqual([]);
      firstClient.close();
      const owner = f.historyOwner(rotate ? "rotated-parent" : "parent-thread");
      if (rotate) {
        await f.rotate(owner.parentThreadId);
      }
      const client = createClient();
      client.setThreadRead("child-thread", finalHistory("child-turn", "Recovered initial result"));
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
          sessionId: f.identity.sessionId,
          lifecycleRevision: f.historyOwner().lifecycleRevision,
        },
      });
      expect(delivered?.completionCustody).toBeDefined();
      expect(await f.assignments(owner)).toEqual([]);
      client.close();
      await f.settle(createClient(), owner);
      expect(f.deliver).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "does not infer fork provenance from the current parent history (observed turn: %s)",
    async (observeTurn) => {
      const { f, client: firstClient, parent: first } = await startAssignment(observeTurn);
      await first.unregister();
      firstClient.close();
      const client = createClient();
      const history = finalHistory("copied-parent-turn", "Parent final copied before rollback");
      history.thread.forkedFromId = "parent-thread";
      const childHistory = finalHistory("child-turn", "Actual child result");
      assert(history.thread.turns && childHistory.thread.turns);
      history.thread.turns.push(...childHistory.thread.turns);
      client.setThreadRead("child-thread", history);
      const parentHistory = threadRead({ childThreadId: "parent-thread" });
      parentHistory.thread.turns = [];
      client.setThreadRead("parent-thread", parentHistory);
      await f.settle(client);
      if (observeTurn) {
        expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result: "Actual child result" }),
        );
        expect(await f.assignments()).toEqual([]);
      } else {
        expect(f.deliver).not.toHaveBeenCalled();
        expect(await f.assignments()).toEqual([
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
      const { f, client: initialClient, parent: initial } = await startAssignment();
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
      await f.settle(client, owner);
      expect(f.deliver).not.toHaveBeenCalled();
      expect(await f.assignments()).toHaveLength(1);
    },
  );

  it.each(["binding", "gateway"] as const)(
    "revalidates %s authority after an awaited history read",
    async (authority) => {
      const { f, client: firstClient, parent: first } = await startAssignment();
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

  it("recovers accepted follow-up after monitor loss and parent rotation", async () => {
    const { f, client, parent } = await startAssignment();
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
    expect(await f.submissions()).toEqual([receipt]);
    expect(await f.assignments()).toEqual([
      expect.objectContaining({
        runId: "codex-thread:child-thread:turn:followup-turn",
        submission: receipt,
      }),
    ]);
    expect(f.deliver).not.toHaveBeenCalled();
    client.close();
    const owner = f.historyOwner("rotated-parent");
    await f.rotate(owner.parentThreadId);
    expect(await f.submissions(owner)).toEqual([]);
    const history = finalHistory("followup-turn", "Recovered follow-up");
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
    expect(await f.assignments(owner)).toEqual([]);
    expect(await f.submissions(owner)).toEqual([]);
    resumedClient.close();
    await f.settle(createClient(), owner);
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it.each(["current", "session", "lifecycle", "connection", "lineage", "revoked"] as const)(
    "admits a fresh follow-up after native parent rotation only with current matching custody (%s)",
    async (scenario) => {
      const f = await fixture();
      const client = createClient();
      onTestFinished(async () => {
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "rotated-parent");
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
      await f.rotate("rotated-parent");
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
      if (scenario === "session" || scenario === "lifecycle" || scenario === "connection") {
        await expect(input).rejects.toThrow("outside the sender's admitted tree");
        await replacement.unregister();
        client.close();
        return;
      }
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
      await client.item(
        collabItem("sendInput", ["child-thread"], {
          id: "followup",
          senderThreadId: "rotated-parent",
        }),
        "rotated-turn",
        "rotated-parent",
      );
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
      nativeRoot.thread.parentThreadId = null;
      nativeRoot.thread.source = "cli";
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
      await client.item(
        collabItem("wait", ["child-thread"], {
          id: "wait-a",
          senderThreadId: "rotated-parent",
          agentsStates: { "child-thread": { status: "completed", message: "A result" } },
        }),
        "rotated-turn",
        "rotated-parent",
      );
      await client.completeTurn({
        turnId: "followup-turn",
        status: "completed",
        items: [{ id: "b-final", type: "agentMessage", phase: "final_answer", text: "B result" }],
      });
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(await f.assignments(owner)).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread:turn:followup-turn",
          nativeParentThreadId: "parent-thread",
        }),
      ]);
      client.close();
    },
  );

  it.each(["followup", "empty", "blocked"] as const)(
    "retires terminal give-up without restoring the completion (%s)",
    async (assignment) => {
      const { f, client, parent } = await startAssignment();
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
        ...(assignment === "blocked" ? { recoveryBlocked: true as const } : {}),
      });
      await parent.unregister();
      // Stop at exhaustion so fake time cannot expire the real transcript worker write.
      await vi.advanceTimersByTimeAsync(530_000);
      const attempts = f.deliver.mock.calls.length;
      if (assignment === "empty") {
        expect(attempts).toBe(0);
      } else if (assignment === "blocked") {
        expect(attempts).toBe(1);
      } else {
        expect(attempts).toBe(7);
      }
      await f.settle(client);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.deliver).toHaveBeenCalledTimes(attempts);
      const saved = await f.assignments();
      expect(saved).toEqual([]);
      expect(await f.submissions()).toEqual([]);
      const notes = await readVisibleSessionTranscriptMessageEntries(f.identity);
      expect(notes).toHaveLength(assignment === "empty" ? 0 : 1);
      if (assignment !== "empty") {
        expect(notes[0]?.message).toMatchObject({
          role: "custom",
          customType: "openclaw.system-note",
          display: true,
          content: expect.stringContaining("status succeeded"),
        });
        expect(notes[0]?.message).toMatchObject({
          content: expect.stringContaining("child session key: codex-thread:child-thread"),
        });
      }
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
      await f.settle(recoveredClient);
      expect(f.deliver).not.toHaveBeenCalled();
      expect(await f.assignments()).toEqual([]);
      expect(await f.submissions()).toEqual([]);
      recoveredClient.close();
      await f.settle(createClient());
      expect(f.deliver).not.toHaveBeenCalled();
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(
        assignment === "empty" ? 0 : 1,
      );
    },
  );

  it("consumes native foreground delivery without a duplicate on re-registration", async () => {
    const { f, client, parent } = await startAssignment();
    await completeInForeground(client);
    await parent.unregister();
    expect(await f.assignments()).toEqual([]);
    client.close();
    await f.settle(createClient());
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

  it("restores aliases once across clients while delivering distinct child turns", async () => {
    const f = await fixture();
    const assignments = ["first-turn", "second-turn"].map((turnId) => ({
      runId: `codex-thread:child-thread:turn:${turnId}`,
      childThreadId: "child-thread",
      nativeTurnId: turnId,
      nativeParentThreadId: "parent-thread",
      owner: f.historyOwner(),
    }));
    for (const assignment of assignments) {
      await f.record(assignment);
    }
    expect(await f.assignments()).toHaveLength(2);
    const row = f.state.lookup(bindingStoreKey(f.identity));
    assert(row?.state === "active");
    f.state.register(bindingStoreKey(f.identity), {
      ...row,
      nativeSubagentAssignments: {
        version: 1,
        assignments: [{ ...assignments[0]!, runId: "codex-thread:child-thread" }, ...assignments],
      },
    });
    const client = createClient();
    const peerClient = createClient();
    const first = finalHistory("first-turn", "First result");
    const second = finalHistory("second-turn", "Second result");
    assert(first.thread.turns && second.thread.turns);
    first.thread.turns.push(...second.thread.turns);
    client.setThreadRead("child-thread", first);
    peerClient.setThreadRead("child-thread", first);
    const parent = await f.register(client);
    let peer: Awaited<ReturnType<typeof f.register>> | undefined;
    try {
      await parent.ready;
      expect(parent.listPendingChildren()).toHaveLength(2);
      peer = await f.register(peerClient);
      await peer.ready;
      expect(peer.listPendingChildren()).toEqual([]);
      await peer.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
      await parent.unregister();
      expect(f.deliver.mock.calls.map(([completion]) => completion.result)).toEqual([
        "First result",
        "Second result",
      ]);
      expect(await f.assignments()).toEqual([]);
    } finally {
      await peer?.unregister();
      await parent.unregister();
      client.close();
      peerClient.close();
    }
  });

  it.each(["rejected write", "lost reply"])(
    "retries retirement after %s without resending the completion",
    async (failure) => {
      const { f, client, parent } = await startAssignment();
      f.deliver.mockResolvedValue({ delivered: false, path: "none", recoveryBlocked: true });
      const mutate = f.store.mutate.bind(f.store);
      let reject = true;
      vi.spyOn(f.store, "mutate").mockImplementation(
        async (identity, mutation, guard, authority) => {
          if (
            mutation.kind === "consume-native-subagent-assignment" &&
            mutation.undelivered &&
            reject
          ) {
            reject = false;
            if (failure === "lost reply") {
              await mutate(identity, mutation, guard, authority);
              throw new Error("Binding retirement reply lost after commit");
            }
            return false;
          }
          return await mutate(identity, mutation, guard, authority);
        },
      );
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Result" }],
        }),
      );
      await parent.unregister();
      expect(await f.assignments()).toHaveLength(failure === "lost reply" ? 0 : 1);
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await f.settle(client);
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(await f.assignments()).toEqual([]);
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(1);
      client.close();
    },
  );

  it.each(["observed turn", "canonical locator", "resumed turn", "different turn"])(
    "reconciles a pending assignment's %s during its history read",
    async (change) => {
      const f = await fixture();
      const initial = {
        runId: "codex-thread:child-thread",
        childThreadId: "child-thread",
        ...(change === "observed turn" ? {} : { nativeTurnId: "child-turn" }),
        nativeParentThreadId: "parent-thread",
        owner: f.historyOwner(),
      };
      await f.store.mutate(
        f.identity,
        { kind: "record-native-subagent-assignment", owner: f.historyOwner(), assignment: initial },
        () => {},
      );
      const entered = createDeferred<void>();
      const history = createDeferred<ReturnType<typeof threadRead>>();
      const client = createClient();
      client.setThreadReadFactory("child-thread", () => {
        entered.resolve();
        return history.promise;
      });
      const parent = await f.register(client);
      const recovered = finalHistory(
        change === "resumed turn" ? "resumed-turn" : "child-turn",
        "Recovered result",
      );
      if (change === "resumed turn") {
        const interrupted = threadRead({ turnId: "child-turn", status: "interrupted" });
        assert(recovered.thread.turns && interrupted.thread.turns);
        recovered.thread.turns.unshift(...interrupted.thread.turns);
      }
      try {
        await entered.promise;
        if (change === "different turn") {
          await f.store.mutate(
            f.identity,
            {
              kind: "consume-native-subagent-assignment",
              owner: f.historyOwner(),
              assignment: initial,
            },
            () => {},
          );
        }
        const surviving = {
          ...initial,
          runId:
            change === "canonical locator"
              ? "codex-thread:child-thread:turn:child-turn"
              : change === "different turn"
                ? "codex-thread:child-thread:turn:other-turn"
                : initial.runId,
          nativeTurnId:
            change === "resumed turn"
              ? "resumed-turn"
              : change === "different turn"
                ? "other-turn"
                : "child-turn",
        };
        await f.store.mutate(
          f.identity,
          {
            kind: "record-native-subagent-assignment",
            owner: f.historyOwner(),
            assignment: surviving,
          },
          () => {},
        );
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        if (change === "different turn") {
          expect(f.deliver).not.toHaveBeenCalled();
          expect(await f.assignments()).toEqual([surviving]);
        } else {
          expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              childSessionKey: surviving.runId,
              result: "Recovered result",
            }),
          );
          expect(await f.assignments()).toEqual([]);
        }
      } finally {
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        client.close();
      }
    },
  );

  it("does not restore an assignment retired while native history was being read", async () => {
    const { f, client, parent } = await startAssignment();
    f.deliver.mockResolvedValue({ delivered: false, path: "none", error: "Unavailable" });
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Result" }],
      }),
    );
    await parent.unregister();
    const entered = createDeferred<void>();
    const history = createDeferred<ReturnType<typeof threadRead>>();
    const replacementClient = createClient();
    replacementClient.setThreadReadFactory("child-thread", () => {
      entered.resolve();
      return history.promise;
    });
    const replacement = await f.register(replacementClient);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await f.assignments()).toEqual([]);
    const attempts = f.deliver.mock.calls.length;
    history.resolve(
      threadRead({ turnId: "child-turn", result: "Result", resultPhase: "final_answer" }),
    );
    await replacement.ready;
    await replacement.unregister();
    expect(f.deliver).toHaveBeenCalledTimes(attempts);
    expect(await f.assignments()).toEqual([]);
    client.close();
    replacementClient.close();
  });
});
