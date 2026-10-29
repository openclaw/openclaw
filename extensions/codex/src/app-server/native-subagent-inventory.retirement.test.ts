import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixture,
  completeInForeground,
  startAssignment,
  submitFollowup,
} from "./native-subagent-inventory.test-support.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  createClient,
  createRuntime,
  nativeHistoryOwner,
  notifyChildStarted,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import { bindingStoreKey } from "./session-binding-record.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());
setupRunAttemptTestHooks();

describe("native parent retirement after rotation", () => {
  it.each([false, true])(
    "releases the earlier parent's live child pin (replacement detached: %s)",
    async (detached) => {
      const f = await fixture();
      const client = createClient();
      const releasePin = vi.fn();
      const first = await f.register(client, undefined, undefined, undefined, {
        retainParentThread: () => releasePin,
      });
      await first.ready;
      first.bindTurn("parent-turn");
      await f.spawn(client);
      await first.unregister();
      await f.store.mutate(f.identity, {
        kind: "replace-thread",
        expectedThreadId: "parent-thread",
        binding: { ...f.binding, threadId: "replacement-parent" },
      });
      client.setThreadRead(
        "child-thread",
        threadRead({ turnId: "child-turn", status: "inProgress" }),
      );
      const replacement = await f.register(client, f.historyOwner("replacement-parent"));
      try {
        await replacement.ready;
        if (detached) {
          await replacement.unregister();
        }
        expect(releasePin).not.toHaveBeenCalled();
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        expect(releasePin).toHaveBeenCalledOnce();
        expect(f.deliver).not.toHaveBeenCalled();
      } finally {
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "replacement-parent");
        await replacement.unregister();
        client.close();
      }
    },
  );

  it.each(["requester", "session", "lifecycle", "connection", "agent"] as const)(
    "preserves retained child ownership for a different %s",
    async (difference) => {
      const client = createClient();
      const releasePin = vi.fn();
      const monitor = new codexNativeSubagentMonitorRuntime.Monitor(
        client.client,
        createRuntime(),
        {
          recoveryPollDelaysMs: [],
          retainParentThread: () => releasePin,
        },
      );
      const original = {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:original",
        agentId: "main",
        historyOwner: nativeHistoryOwner(),
      };
      const first = await monitor.registerParent(original);
      first.bindTurn("parent-turn");
      try {
        await notifyChildStarted(client);
        await first.unregister();
        const other = {
          ...original,
          parentThreadId: "other-parent",
          historyOwner: { ...original.historyOwner, parentThreadId: "other-parent" },
        };
        if (difference === "requester") {
          other.requesterSessionKey = "agent:main:other";
        } else if (difference === "session") {
          other.historyOwner.sessionId = "other-physical-session";
        } else if (difference === "lifecycle") {
          other.historyOwner.lifecycleRevision = "other-revision";
        } else if (difference === "connection") {
          other.historyOwner.connectionFingerprint = "0".repeat(64);
        } else {
          other.agentId = "other";
        }
        const replacement = await monitor.registerParent(other);
        await monitor.retireParent("other-parent");
        expect(releasePin).not.toHaveBeenCalled();
        await monitor.retireParent("parent-thread");
        expect(releasePin).toHaveBeenCalledOnce();
        await replacement.unregister();
      } finally {
        await monitor.dispose();
        client.close();
      }
    },
  );
});

describe("native pending assignment retirement after terminal give-up", () => {
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
      const settled = await f.register(client);
      await settled.ready;
      await settled.unregister();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.deliver).toHaveBeenCalledTimes(attempts);
      const saved = await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner());
      expect(saved).toEqual([]);
      expect(await f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toEqual([]);
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
      const recovered = await f.register(recoveredClient);
      await recovered.ready;
      await recovered.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual(
        [],
      );
      expect(await f.store.readNativeSubagentSubmissions(f.identity, f.historyOwner())).toEqual([]);
      recoveredClient.close();
      const duplicate = await f.register(createClient());
      await duplicate.ready;
      await duplicate.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
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
      await f.store.mutate(
        f.identity,
        {
          kind: "record-native-subagent-assignment",
          owner: f.historyOwner(),
          assignment,
        },
        () => {},
      );
    }
    expect(
      await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
    ).toHaveLength(2);
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
    const first = threadRead({
      turnId: "first-turn",
      result: "First result",
      resultPhase: "final_answer",
    });
    const second = threadRead({
      turnId: "second-turn",
      result: "Second result",
      resultPhase: "final_answer",
    });
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
      expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual(
        [],
      );
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
      expect(
        await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
      ).toHaveLength(failure === "lost reply" ? 0 : 1);
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await f.register(client);
      await settled.ready;
      await settled.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual(
        [],
      );
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
      const recovered = threadRead({
        turnId: change === "resumed turn" ? "resumed-turn" : "child-turn",
        result: "Recovered result",
        resultPhase: "final_answer",
      });
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
          expect(
            await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
          ).toEqual([surviving]);
        } else {
          expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              childSessionKey: surviving.runId,
              result: "Recovered result",
            }),
          );
          expect(
            await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
          ).toEqual([]);
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
    expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    const attempts = f.deliver.mock.calls.length;
    history.resolve(
      threadRead({ turnId: "child-turn", result: "Result", resultPhase: "final_answer" }),
    );
    await replacement.ready;
    await replacement.unregister();
    expect(f.deliver).toHaveBeenCalledTimes(attempts);
    expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    client.close();
    replacementClient.close();
  });
});
