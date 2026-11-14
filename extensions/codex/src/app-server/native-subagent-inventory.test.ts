import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixture,
  completeInForeground,
  submitFollowup,
} from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  collabItem,
  agentMessage,
  createClient,
  createNativeModelSourceFixture,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import { bindingStoreKey } from "./session-binding-record.js";

setupRunAttemptTestHooks();

type History = ReturnType<typeof threadRead>;
type HistoryOptions = Parameters<typeof threadRead>[0];

function finalHistory(turnId: string, result: string, options?: HistoryOptions) {
  return threadRead({ turnId, result, resultPhase: "final_answer", ...options });
}

type Inventory = Awaited<ReturnType<typeof fixture>>;
type Client = ReturnType<typeof createClient>;
type Parent = Awaited<ReturnType<Inventory["register"]>>;

async function closeAssignment(parent: Parent, client: Client) {
  await parent.unregister();
  client.close();
}

function changeOwner(owner: ReturnType<Inventory["historyOwner"]>, scenario: string) {
  if (scenario === "connection") {
    owner.connectionFingerprint = "f".repeat(64);
  } else if (scenario === "lifecycle") {
    owner.lifecycleRevision = "replacement";
  } else if (scenario === "session") {
    owner.sessionId = "replacement";
  }
  return owner;
}

function interceptMutation(
  f: Inventory,
  intercept: (
    mutation: Parameters<Inventory["store"]["mutate"]>[1],
    commit: () => Promise<boolean>,
  ) => Promise<boolean>,
) {
  const mutate = f.store.mutate.bind(f.store);
  vi.spyOn(f.store, "mutate").mockImplementation((identity, mutation, guard, authority) =>
    intercept(mutation, () => mutate(identity, mutation, guard, authority)),
  );
}

function prependHistory(history: History, prior: History) {
  assert(history.thread.turns && prior.thread.turns);
  history.thread.turns.unshift(...prior.thread.turns);
  return history;
}

async function startAssignment(
  observeTurn = true,
  source?: ReturnType<typeof createNativeModelSourceFixture>,
) {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(client, f.historyOwner(), source);
  await parent.ready;
  parent.bindTurn("parent-turn");
  await f.spawn(client, observeTurn);
  return { f, client, parent };
}

async function detachedAssignment(observeTurn = true) {
  const { f, client, parent } = await startAssignment(observeTurn);
  await closeAssignment(parent, client);
  return f;
}

function holdHistory(client: Client, fallback?: History) {
  const entered = createDeferred<void>();
  const history = createDeferred<History>();
  client.setThreadReadFactory("child-thread", ({ includeTurns }) => {
    if (fallback && includeTurns !== false) {
      return fallback;
    }
    entered.resolve();
    return history.promise;
  });
  return { entered: entered.promise, history };
}

async function pauseRecovery(f: Inventory, client = createClient()) {
  const { entered, history } = holdHistory(client);
  const parent = await f.register(client);
  await Promise.race([
    entered,
    parent.ready.then(() => {
      throw new Error("Recovery completed without reading pending history");
    }),
  ]);
  return { client, parent, history };
}

function completeChild(
  client: Client,
  text: string,
  turnId = "child-turn",
  threadId = "child-thread",
) {
  return client.completeTurn({
    threadId,
    turnId,
    status: "completed",
    items: [agentMessage("final", text, "final_answer")],
  });
}

function captureSource(
  client: Client,
  threadId = "child-thread",
  parentThreadId = "parent-thread",
) {
  return codexNativeSubagentMonitorRuntime.captureModelSource({
    client: client.client,
    threadId,
    turnId: threadId === "grandchild" ? "grandchild-turn" : "child-turn",
    parentThreadId,
    parentTurnId: parentThreadId === "child-thread" ? "child-turn" : "parent-turn",
    rootTurnId: "parent-turn",
  });
}

function prepareInput(client: Client, threadId: string, turnId: string, target: string) {
  return codexNativeSubagentMonitorRuntime.prepareModelInput({
    client: client.client,
    threadId,
    turnId,
    itemId: target === "/root" ? "native-root" : "followup",
    target,
    readQualification: () => undefined,
    assertCurrent: () => {},
  });
}

async function startNestedAssignment() {
  const { f, client, parent } = await startAssignment(
    true,
    createNativeModelSourceFixture(["model-a"]),
  );
  await notifyChildStarted(client, "child-thread", "grandchild", "/root/child/grandchild");
  await client.spawn("grandchild", "child-turn", "v2", "child-thread");
  await client.startTurn("grandchild-turn", { threadId: "grandchild" });
  const capture = await captureSource(client, "grandchild", "child-thread");
  assert(capture);
  capture.release();
  return { f, client, parent };
}

describe("native pending assignment inventory through registered monitor admission", () => {
  it("acknowledges a grandchild's native completion without root delivery or restart replay", async () => {
    const { f, client, parent } = await startNestedAssignment();
    await completeChild(client, "Nested result", "grandchild-turn", "grandchild");
    await completeInForeground(client);
    await parent.unregister();
    expect(await f.assignments()).toEqual([]);
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
      await closeAssignment(parent, client);
      const saved = await f.assignments();
      expect(saved).toMatchObject([{ childThreadId: "grandchild" }]);
      const recoveredClient = createClient();
      recoveredClient.setThreadRead(
        "grandchild",
        finalHistory("grandchild-turn", "Nested result", {
          childThreadId: "grandchild",
          parentThreadId: "child-thread",
        }),
      );
      const metadata = threadRead({ childThreadId: "child-thread", directParentField: false });
      const { entered, history: release } = holdHistory(recoveredClient);
      if (scenario !== "revoked") {
        recoveredClient.setThreadReadFactory("child-thread", () => {
          if (scenario === "unavailable") {
            throw new Error("Native middle thread is temporarily unavailable");
          }
          return metadata;
        });
      }
      const recovered = await f.register(recoveredClient);
      if (scenario === "revoked") {
        await entered;
        recovered.closeGateway();
        release.resolve(metadata);
      }
      await recovered.ready;
      await recovered.unregister();
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
    interceptMutation(f, async (mutation, commit) => {
      if (mutation.kind !== "record-native-subagent-assignment") {
        return await commit();
      }
      writing = true;
      entered.resolve();
      try {
        await releaseWrite.promise;
        return await commit();
      } finally {
        writing = false;
      }
    });
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
        finalHistory(assignment.nativeTurnId, `Recovered ${assignment.childThreadId}`, {
          childThreadId: assignment.childThreadId,
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
      expect(conflictingRead).not.toHaveBeenCalled();
      expect(parent.listPendingChildren()).toHaveLength(2);
      expect(await f.assignments()).toMatchObject(assignments);
    } finally {
      releaseWrite.resolve();
      await closeAssignment(parent, client);
    }
  });

  it.each(["committed", "rejected", "failed", "source-revoked", "binding-retired"] as const)(
    "withholds native inference authority until its exact assignment is acknowledged (%s)",
    async (outcome) => {
      const source = createNativeModelSourceFixture(["model-a"]);
      const { f, client, parent } = await startAssignment(false, source);
      const entered = createDeferred<void>();
      const releaseWrite = createDeferred<void>();
      interceptMutation(f, async (mutation, commit) => {
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
        return await commit();
      });
      const granted = vi.fn();
      const capture = captureSource(client);
      void capture.then(granted, () => {});
      await Promise.race([
        entered.promise,
        capture.then(() => {
          throw new Error("Source grant settled without exact assignment persistence");
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
      if (outcome === "committed") {
        const value = await capture;
        assert(value);
        value.assertCurrent();
        expect(await f.assignments()).toMatchObject([{ nativeTurnId: "child-turn" }]);
        value.release();
      } else {
        await expect(capture).rejects.toBeInstanceOf(Error);
      }
      await closeAssignment(parent, client);
    },
  );

  it.each([
    { rotate: false, observeTurn: true, followup: false },
    { rotate: true, observeTurn: false, followup: false },
    { rotate: true, observeTurn: true, followup: true },
  ])(
    "recovers durable work after monitor loss ($rotate rotation, $observeTurn turn observed, $followup followup)",
    async ({ rotate, observeTurn, followup }) => {
      const { f, client: firstClient, parent: first } = await startAssignment(observeTurn);
      if (followup) {
        await completeInForeground(firstClient);
        await submitFollowup(firstClient);
      }
      // Neither the follow-up start nor unobserved spawn gets another turn notification.
      await first.unregister();
      first.closeCaller();
      if (!followup) {
        // Initial spawn result agent_id is never interpreted as submission_id.
        expect(await f.submissions()).toEqual([]);
      }
      expect(f.deliver).not.toHaveBeenCalled();
      firstClient.close();
      const owner = f.historyOwner(rotate ? "rotated-parent" : "parent-thread");
      if (rotate) {
        await f.rotate(owner.parentThreadId);
      }
      expect(await f.submissions(owner)).toEqual([]);
      const turnId = followup ? "followup-turn" : "child-turn";
      const result = followup ? "Recovered follow-up" : "Recovered initial result";
      const history = finalHistory(turnId, result);
      if (followup) {
        prependHistory(history, threadRead({ turnId: "child-turn", result: "Native result" }));
      }
      const client = createClient();
      client.setThreadRead("child-thread", history);
      const recovered = await f.register(client, owner);
      await recovered.ready;
      expect(f.deliver).not.toHaveBeenCalled();
      await recovered.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      const delivered = f.deliver.mock.calls[0]?.[0];
      expect(delivered).toMatchObject({
        childSessionKey: followup
          ? "codex-thread:child-thread:turn:followup-turn"
          : "codex-thread:child-thread",
        result,
        expectedRequester: {
          sessionId: f.identity.sessionId,
          lifecycleRevision: f.historyOwner().lifecycleRevision,
        },
      });
      if (followup) {
        recovered.closeCaller();
      }
      expect(await f.assignments(owner)).toEqual([]);
      expect(await f.submissions(owner)).toEqual([]);
      client.close();
      await f.settle(createClient(), owner);
      expect(f.deliver).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "does not infer fork provenance from the current parent history (observed turn: %s)",
    async (observeTurn) => {
      const f = await detachedAssignment(observeTurn);
      const client = createClient();
      const history = prependHistory(
        finalHistory("child-turn", "Actual child result"),
        finalHistory("copied-parent-turn", "Parent final copied before rollback"),
      );
      history.thread.forkedFromId = "parent-thread";
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
        expect(await f.assignments()).toMatchObject([{ childThreadId: "child-thread" }]);
      }
    },
  );

  it.each(["missing-lineage", "wrong-lineage", "connection", "lifecycle", "session"])(
    "does not adopt pending native work under %s history ownership",
    async (scenario) => {
      const f = await detachedAssignment();
      const owner = changeOwner(f.historyOwner(), scenario);
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
      const f = await detachedAssignment();
      const { parent: recovered, history } = await pauseRecovery(f);
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

  it.each(["current", "session", "lifecycle", "connection", "lineage", "revoked"] as const)(
    "admits a fresh follow-up after native parent rotation only with current matching custody (%s)",
    async (scenario) => {
      const { f, client, parent: first } = await startAssignment();
      onTestFinished(async () => {
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "rotated-parent");
        client.close();
      });
      f.deliver.mockImplementation(async ({ completionCustody }) => {
        assert(completionCustody?.isCurrent());
        return { delivered: false, path: "direct" };
      });
      const history = threadRead({
        turnId: "child-turn",
        result: "A result",
        agentPath: "/root/worker",
        threadStatus: "notLoaded",
      });
      history.thread.modelProvider = "provider-b";
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      await client.finishTurn("child-turn", agentMessage("a-final", "A result"));
      await first.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      await f.rotate("rotated-parent");
      const owner = changeOwner(f.historyOwner("rotated-parent"), scenario);
      client.setThreadRead("child-thread", history);
      const source = createNativeModelSourceFixture(["model-b"]);
      const replacement = await f.register(client, owner, source, {
        assertCurrent: source.assertCurrent,
        hasProvider: (provider) => provider === "provider-b",
      });
      await replacement.ready;
      replacement.bindTurn("rotated-turn");
      const { entered, history: read } = holdHistory(client, history);
      const input = prepareInput(client, "rotated-parent", "rotated-turn", "child-thread");
      if (scenario === "session" || scenario === "lifecycle" || scenario === "connection") {
        await expect(input).rejects.toThrow("outside the sender's admitted tree");
        await closeAssignment(replacement, client);
        return;
      }
      await entered;
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
        await closeAssignment(replacement, client);
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
      await client.sendInputOutput({
        parentThreadId: "rotated-parent",
        turnId: "rotated-turn",
        callId: "followup",
        submissionId: "followup-turn",
      });
      await client.startTurn("followup-turn");
      const nativeRoot = threadRead({ childThreadId: "parent-thread", threadStatus: "notLoaded" });
      nativeRoot.thread.parentThreadId = null;
      nativeRoot.thread.source = "cli";
      nativeRoot.thread.modelProvider = "provider-a";
      client.setThreadRead("parent-thread", nativeRoot);
      await expect(prepareInput(client, "child-thread", "followup-turn", "/root")).rejects.toThrow(
        "does not admit this model",
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
      await completeChild(client, "B result", "followup-turn");
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(await f.assignments(owner)).toMatchObject([
        {
          runId: "codex-thread:child-thread:turn:followup-turn",
          nativeParentThreadId: "parent-thread",
        },
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
        await client.startTurn("followup-turn");
      }
      const turnId = assignment === "followup" ? "followup-turn" : "child-turn";
      if (assignment !== "empty") {
        await completeChild(client, "Pending result", turnId);
      }
      client.setLoadedThreads([]);
      await client.closeAgent({ method: "item/started" });
      await client.closeAgent({ method: "item/completed" });
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
      expect(attempts).toBe({ empty: 0, blocked: 1, followup: 7 }[assignment]);
      await f.settle(client);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.deliver).toHaveBeenCalledTimes(attempts);
      expect(await f.assignments()).toEqual([]);
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
      const history = finalHistory(turnId, "Pending result");
      if (assignment === "followup") {
        prependHistory(history, threadRead({ turnId: "child-turn", result: "Native result" }));
      }
      recoveredClient.setThreadRead("child-thread", history);
      await f.settle(recoveredClient);
      expect(f.deliver).not.toHaveBeenCalled();
      recoveredClient.close();
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(
        assignment === "empty" ? 0 : 1,
      );
    },
  );

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
    prependHistory(second, first);
    client.setThreadRead("child-thread", second);
    peerClient.setThreadRead("child-thread", second);
    const parent = await f.register(client);
    let peer: Awaited<ReturnType<typeof f.register>> | undefined;
    try {
      await parent.ready;
      peer = await f.register(peerClient);
      await peer.ready;
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
      let reject = true;
      interceptMutation(f, async (mutation, commit) => {
        if (
          mutation.kind === "consume-native-subagent-assignment" &&
          mutation.undelivered &&
          reject
        ) {
          reject = false;
          if (failure === "lost reply") {
            await commit();
            throw new Error("Binding retirement reply lost after commit");
          }
          return false;
        }
        return await commit();
      });
      await completeChild(client, "Result");
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

  it.each([
    ["observed turn", "child-turn", false],
    ["canonical locator", "child-turn", true],
    ["resumed turn", "resumed-turn", false],
    ["different turn", "other-turn", true],
  ] as const)(
    "reconciles a pending assignment's %s during its history read",
    async (change, nativeTurnId, canonical) => {
      const f = await fixture();
      const initial = {
        runId: "codex-thread:child-thread",
        childThreadId: "child-thread",
        ...(change === "observed turn" ? {} : { nativeTurnId: "child-turn" }),
        nativeParentThreadId: "parent-thread",
        owner: f.historyOwner(),
      };
      await f.record(initial);
      const { client, parent, history } = await pauseRecovery(f);
      const recovered = finalHistory(
        change === "resumed turn" ? "resumed-turn" : "child-turn",
        "Recovered result",
      );
      if (change === "resumed turn") {
        prependHistory(recovered, threadRead({ turnId: "child-turn", status: "interrupted" }));
      }
      try {
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
          runId: canonical ? `${initial.runId}:turn:${nativeTurnId}` : initial.runId,
          nativeTurnId,
        };
        await f.record(surviving);
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
        await closeAssignment(parent, client);
      }
    },
  );

  it("does not restore an assignment retired while native history was being read", async () => {
    const { f, client, parent } = await startAssignment();
    f.deliver.mockResolvedValue({ delivered: false, path: "none", error: "Unavailable" });
    await completeChild(client, "Result");
    await parent.unregister();
    const { client: replacementClient, parent: replacement, history } = await pauseRecovery(f);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await f.assignments()).toEqual([]);
    const attempts = f.deliver.mock.calls.length;
    history.resolve(finalHistory("child-turn", "Result"));
    await replacement.ready;
    await replacement.unregister();
    expect(f.deliver).toHaveBeenCalledTimes(attempts);
    expect(await f.assignments()).toEqual([]);
    client.close();
    replacementClient.close();
  });
});
