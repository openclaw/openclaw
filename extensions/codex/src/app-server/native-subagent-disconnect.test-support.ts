import assert from "node:assert/strict";
import path from "node:path";
import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  agentMessage,
  collabItem,
  CodexNativeSubagentMonitor,
  createClient,
  createNativeModelSourceFixture,
  createRuntime,
  createCompletionScope,
  directSpawnItem,
  notifyChildStarted,
  observeCompletionAttempts,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentPendingAssignment as Assignment } from "./native-subagent-pending-assignments.js";
import { readCodexNativeSubagents } from "./native-subagent-roster.js";
import type { NativeSubagentDisconnectFixture } from "./native-subagent-submission-store.test.js";
import type { CodexNativeSubagentSubmission as Submission } from "./native-subagent-submission.js";

export function registerNativeSubagentDisconnectCases({
  binding,
  consumeSubmission,
  fixture,
  identity,
  makeAssignment,
  receipt,
  recordSubmission,
}: NativeSubagentDisconnectFixture) {
  it.each([
    "receipt",
    "assignment",
    "lost final",
    "still running",
    "idle during read",
    "running snapshot overlaps idle",
    "running snapshot overlaps system error",
    "wrong detached successor",
    "active during read",
    "still interrupted on reread",
    "revoked while running",
    "retired while running",
    "rotated during read",
    "registered during read",
    "registered while running",
    "revoked before read",
  ])(
    "settles an accepted follow-up after Stop acknowledgement failure or disconnect (%s)",
    async (scenario) => {
      const queued =
        scenario === "lost final"
          ? {
              ...receipt,
              callId: "queued-call",
              childThreadId: "sibling",
              predecessorRunId: "codex-thread:sibling",
              predecessorNativeTurnId: "sibling-a",
              submissionId: "sibling-b",
            }
          : undefined;
      const f = await fixture(queued);
      const { owner, assertCurrent, reopen, assignmentStore, submissionStore } = f;
      const stopReceipt = { ...receipt, predecessorRunId: "codex-thread:child-thread" };
      const { childThreadId, submissionId, predecessorNativeTurnId, parentTurnId, callId } =
        stopReceipt;
      const parentThreadId = binding.threadId;
      const assignment = makeAssignment(owner, { submission: stopReceipt });
      const assignmentRecorded = createDeferred<boolean>();
      const receiptRecorded = createDeferred<boolean>();
      const rejectedKind =
        scenario === "receipt" ? consumeSubmission : "consume-native-subagent-assignment";
      let reject = false;
      const mutate = f.store.mutate.bind(f.store);
      vi.spyOn(f.store, "mutate").mockImplementation((caller, mutation, ...guards) => {
        if (reject && mutation.kind === rejectedKind) {
          return Promise.resolve(false);
        }
        const recorded = mutate(caller, mutation, ...guards);
        if (mutation.kind === recordSubmission) {
          receiptRecorded.resolve(recorded);
        } else if (
          mutation.kind === "record-native-subagent-assignment" &&
          mutation.assignment.runId === assignment.runId &&
          !mutation.assignment.submission
        ) {
          assignmentRecorded.resolve(recorded);
        }
        return recorded;
      });
      const createObserverClient = () => {
        const client = createClient();
        if (queued) {
          const { childThreadId: sibling, predecessorNativeTurnId: turnId } = queued;
          client.setThreadRead(sibling, threadRead({ childThreadId: sibling, turnId }));
        }
        return client;
      };
      const client = createObserverClient();
      const parentItem = (item: Parameters<typeof client.item>[0]) =>
        client.item(item, parentTurnId, parentThreadId);
      const activeTurn = (turnId: string) =>
        threadRead({ turnId, status: "inProgress", threadStatus: "active" });
      const completedTurn = (turnId: string, result: string, threadStatus: "idle" | "notLoaded") =>
        threadRead({ turnId, result, resultPhase: "final_answer", threadStatus });
      client.setThreadRead(childThreadId, activeTurn(predecessorNativeTurnId));
      const runtime = createRuntime();
      const authority = new AbortController();
      const custody: AgentHarnessCompletionCustody = {
        signal: authority.signal,
        isCurrent: () => !authority.signal.aborted,
        retain: () => custody,
        settleExecution() {},
        release() {},
      };
      runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(custody);
      const interrupt = vi.fn(async (threadId: string, turnId: string, guard: () => void) => {
        guard();
        expect([threadId, turnId]).toEqual([childThreadId, submissionId]);
        await client.completeTurn({ turnId: submissionId, status: "interrupted" });
        return true;
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        interruptChildAndWait: interrupt,
        hasObservationBacking: (_parent, child) => child === queued?.childThreadId,
      });
      const requestCustody = Object.freeze({});
      const modelSource = createNativeModelSourceFixture(["test-model"]);
      const cleanup = vi.fn(async (_threadId: string, _turnId: string, guard: () => void) =>
        guard(),
      );
      const requesterStorePath = path.join(
        f.root,
        "agents",
        identity.agentId,
        "sessions",
        "sessions.json",
      );
      const parentObservation = () => ({
        parentThreadId,
        requesterSessionKey: identity.sessionKey,
        requesterStorePath,
        historyOwner: owner,
        completionScope: createCompletionScope(identity.sessionKey),
        assignmentStore,
        submissionStore,
      });
      const parent = await monitor.registerParent({
        ...parentObservation(),
        requesterTurnRunId: "parent-run",
        requestCustody,
        agentId: identity.agentId,
        modelSource,
        configurationQualification: {
          assertCurrent: modelSource.assertCurrent,
          hasProvider: (provider) => provider === "test-provider",
        },
        claimDirectChild: () => () => {},
        cancelChildProcesses: cleanup,
      });
      const stop = () =>
        monitor.withDescendantCancellation(
          {
            parentThreadId,
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            sessionId: identity.sessionId,
            lifecycleRevision: owner.lifecycleRevision,
            acceptsRequest: (acceptedCustody) => acceptedCustody === requestCustody,
            assertCurrent,
          },
          (cancel) => cancel(),
        );
      try {
        await parent.ready;
        parent.bindTurn(parentTurnId);
        await notifyChildStarted(client);
        await parentItem(directSpawnItem("v1", parentThreadId, childThreadId));
        await client.startTurn(predecessorNativeTurnId);
        await client.finishTurn(
          predecessorNativeTurnId,
          agentMessage("a-final", "A result", "final_answer"),
        );
        const wait = (id: string, message: string) => {
          const agentsStates = { [childThreadId]: { status: "completed", message } };
          return collabItem("wait", [childThreadId], { id, agentsStates });
        };
        await parentItem(wait("wait-a", "A result"));
        const predecessor = completedTurn(predecessorNativeTurnId, "A result", "notLoaded");
        predecessor.thread.modelProvider = "test-provider";
        client.setThreadRead(childThreadId, predecessor);
        await monitor.prepareModelInput({
          threadId: parentThreadId,
          turnId: parentTurnId,
          itemId: callId,
          target: childThreadId,
          readQualification: () => undefined,
          assertCurrent,
        });
        const history = activeTurn(submissionId);
        assert(history.thread.turns && predecessor.thread.turns);
        history.thread.turns.unshift(...predecessor.thread.turns);
        history.thread.modelProvider = "test-provider";
        client.setThreadRead(childThreadId, history);
        await parentItem(collabItem("sendInput", [childThreadId], { id: callId }));
        await client.sendInputOutput({
          parentThreadId,
          turnId: parentTurnId,
          callId,
          submissionId,
        });
        await client.startTurn(submissionId);
        expect(await assignmentRecorded.promise).toBe(true);
        expect(await receiptRecorded.promise).toBe(true);
        const expectSaved = async (assignments: Assignment[], receipts: Submission[]) => {
          expect(await assignmentStore.read()).toEqual(assignments);
          expect(await submissionStore.read()).toEqual(receipts);
        };
        await expectSaved([assignment], queued ? [queued, stopReceipt] : [stopReceipt]);
        if (scenario !== "receipt" && scenario !== "assignment") {
          await parent.unregister();
          const attempts = observeCompletionAttempts();
          const peer = createClient();
          peer.client.initialize = async () => {};
          const closePeer = vi.fn(peer.close);
          peer.client.close = closePeer;
          let replacement: typeof monitor | undefined;
          let observer: typeof parent | undefined;
          const final = completedTurn(submissionId, "B result", "idle");
          final.thread.turns!.unshift(...predecessor.thread.turns);
          const registerAgain = async (snapshot = final) => {
            const next = createObserverClient();
            next.setThreadRead(childThreadId, snapshot);
            replacement = new CodexNativeSubagentMonitor(next.client, runtime);
            observer = await replacement.registerParent(parentObservation());
            await observer.ready;
            await attempts.settle();
            return next;
          };
          const running = scenario.endsWith("running");
          const systemError = scenario === "running snapshot overlaps system error";
          const activeReadChecked = running || systemError ? createDeferred<void>() : undefined;
          let readActiveReply = false;
          if (activeReadChecked) {
            const readAssignments = assignmentStore.read;
            vi.spyOn(assignmentStore, "read").mockImplementation(async () => {
              const entries = await readAssignments();
              if (readActiveReply) {
                activeReadChecked.resolve();
              }
              return entries;
            });
          }
          const observe = (overrides?: { lifecycleRevision?: string; storePath?: string }) =>
            readCodexNativeSubagents(
              {
                ...identity,
                lifecycleRevision: owner.lifecycleRevision,
                storePath: requesterStorePath,
                assertCurrent,
                ...overrides,
              },
              { bindingStore: f.store },
            );
          const releaseOther = vi.fn();
          if (scenario === "still running") {
            const other = await monitor.registerParent({
              parentThreadId: "other-parent",
              submissionStore: { ...submissionStore, read: async () => [], release: releaseOther },
            });
            await other.ready;
          }
          const statusChanged = (threadId: string, type: "idle" | "systemError" = "idle") =>
            peer.notify({
              method: "thread/status/changed",
              params: { threadId, status: { type } },
            });
          const stillInterrupted = scenario === "still interrupted on reread";
          const activeFinal = scenario === "active during read";
          const activeOverlap = scenario === "running snapshot overlaps idle" || systemError;
          const retired = scenario === "retired while running";
          const wrongSuccessor = scenario === "wrong detached successor";
          const rereadStarted = createDeferred<void>();
          const allowFinal = createDeferred<void>();
          const overlaps = scenario === "idle during read" || activeFinal || stillInterrupted;
          peer.setThreadReadFactory(childThreadId, async () => {
            if (activeOverlap) {
              history.thread.turns!.at(-1)!.completedAt = null;
              await statusChanged(childThreadId, systemError ? "systemError" : "idle");
              readActiveReply = true;
              peer.setThreadReadFactory(childThreadId, async () => {
                rereadStarted.resolve();
                await allowFinal.promise;
                return final;
              });
              return history;
            }
            if (wrongSuccessor) {
              Object.assign(history.thread.turns!.at(-1)!, {
                id: "unrelated-turn",
                completedAt: null,
              });
              return history;
            }
            if (overlaps) {
              await statusChanged(childThreadId);
              if (activeFinal) {
                history.thread.turns = final.thread.turns;
              } else {
                history.thread.status = { type: "idle" };
                const successor = history.thread.turns!.at(-1)!;
                successor.status = "interrupted";
                successor.completedAt = null;
              }
              peer.setThreadRead(childThreadId, stillInterrupted ? history : final);
              return history;
            }
            if (running) {
              history.thread.turns!.at(-1)!.completedAt = null;
              readActiveReply = true;
              return history;
            }
            if (scenario === "rotated during read") {
              await f.rotate("replacement");
            }
            if (scenario === "registered during read") {
              await registerAgain();
            }
            return final;
          });
          const openPeer = vi.fn(() => peer.client);
          client.client.getDisconnectedPeer = () => openPeer;
          expect(await f.patch({ clientId: client.client.getInstanceId() })).toBe(true);
          try {
            if (scenario === "still running") {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }
            client.close();
            if (activeOverlap) {
              // Observe the old reply even if a broken watcher never starts the fresh read.
              await (activeReadChecked
                ? Promise.race([activeReadChecked.promise, rereadStarted.promise])
                : rereadStarted.promise);
              expect(await observe()).toBeUndefined();
              if (systemError) {
                await statusChanged(childThreadId);
              }
              await rereadStarted.promise;
              allowFinal.resolve();
            }
            if (scenario === "revoked before read") {
              authority.abort();
            }
            if (running && activeReadChecked) {
              await activeReadChecked.promise;
              await statusChanged("unrelated");
              expect(await observe()).toEqual({
                coverage: "live",
                children: [{ id: childThreadId, label: childThreadId, status: "running" }],
                truncated: false,
              });
              expect(await observe({ lifecycleRevision: "another-generation" })).toBeUndefined();
              expect(await observe({ storePath: path.join(f.root, "other.json") })).toBeUndefined();
              await expectSaved([assignment], [stopReceipt]);
              expect(peer.request).toHaveBeenCalledOnce();
              expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
              if (scenario === "still running") {
                expect(releaseOther).toHaveBeenCalledOnce();
                const quietRead = createDeferred<void>();
                peer.setThreadReadFactory(childThreadId, async () => {
                  quietRead.resolve();
                  return { ...history, thread: { ...history.thread, turns: [] } };
                });
                await vi.advanceTimersByTimeAsync(300_000);
                await quietRead.promise;
                expect(peer.request.mock.calls[1]?.slice(0, 2)).toEqual([
                  "thread/read",
                  { threadId: childThreadId, includeTurns: false },
                ]);
                expect((await observe())?.children[0]?.status).toBe("running");
              }
              peer.setThreadReadFactory(childThreadId, async () => {
                await allowFinal.promise;
                return final;
              });
              if (retired) {
                expect(
                  await f.mutate(
                    {
                      kind: "consume-native-subagent-assignment",
                      owner,
                      assignment,
                      undelivered: true,
                    },
                    assertCurrent,
                  ),
                ).toBe(true);
                expect(await observe()).toBeUndefined();
                expect(closePeer).not.toHaveBeenCalled();
              }
              if (scenario === "revoked while running") {
                authority.abort();
                await monitor.dispose();
                expect(await observe()).toBeUndefined();
              }
              if (scenario === "registered while running") {
                const next = await registerAgain(history);
                expect(await observe()).toBeUndefined();
                await statusChanged(childThreadId);
                allowFinal.resolve();
                await monitor.dispose();
                await attempts.settle();
                expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
                await expectSaved([assignment], [stopReceipt]);
                next.setThreadRead(childThreadId, final);
                observer!.bindTurn("next");
                await next.finishTurn(submissionId, agentMessage("b", "B result", "final_answer"));
                await next.item(wait("wait-b", "B result"), "next");
                await observer!.unregister();
                await attempts.settle();
                await expectSaved([], []);
                expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
                return;
              }
              await statusChanged(childThreadId);
              expect(await observe()).toBeUndefined();
              allowFinal.resolve();
            }
            await monitor.dispose();
            await attempts.settle();
            if (overlaps || activeOverlap) {
              const read = ["thread/read", { threadId: childThreadId, includeTurns: true }];
              expect(peer.request.mock.calls.map((call) => call.slice(0, 2))).toEqual([read, read]);
            }
            if (authority.signal.aborted) {
              for (const call of [openPeer, peer.request, closePeer]) {
                expect(call).toHaveBeenCalledTimes(running ? 1 : 0);
              }
            }
            if (wrongSuccessor) {
              expect(await observe()).toBeUndefined();
              expect(peer.request).toHaveBeenCalledOnce();
            }
            if (retired) {
              expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
              await expectSaved([], []);
              expect(closePeer).toHaveBeenCalledOnce();
              return;
            }
            if (stillInterrupted || wrongSuccessor || authority.signal.aborted) {
              expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
              await expectSaved([assignment], [stopReceipt]);
              return;
            }
            if (scenario === "registered during read") {
              expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
            } else if (queued) {
              expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
              await expectSaved([], [queued]);
              await registerAgain();
            }
          } finally {
            if (scenario === "still running") {
              vi.useRealTimers();
            }
            allowFinal.resolve();
            if (running || systemError) {
              authority.abort();
            }
            await observer?.unregister();
            await attempts.settle();
            await replacement?.dispose();
          }
          if (scenario !== "rotated during read") {
            expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ childSessionKey: assignment.runId, result: "B result" }),
            );
            await expectSaved([], queued ? [queued] : []);
          } else {
            expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
            expect(
              await f.store.readNativeSubagentAssignments?.(identity, {
                ...owner,
                parentThreadId: "replacement",
              }),
            ).toEqual([assignment]);
          }
          expect(closePeer).toHaveBeenCalledOnce();
          return;
        }
        reject = true;
        const failed = await stop();
        expect(failed.killed).toBe(0);
        expect(failed.errors).toEqual([
          new Error(
            scenario === "receipt"
              ? "Cancelled native follow-up receipt was not acknowledged."
              : "Native assignment was not acknowledged.",
          ),
        ]);
        await reopen();
        await expectSaved([assignment], scenario === "receipt" ? [stopReceipt] : []);
        reject = false;
        const retried = await stop();
        expect([retried.killed, retried.errors]).toEqual([1, undefined]);
        expect(interrupt).toHaveBeenCalledOnce();
        expect(cleanup.mock.calls.map(([threadId, turnId]) => [threadId, turnId])).toEqual([
          [childThreadId, submissionId],
          [childThreadId, submissionId],
        ]);
        await reopen();
        await expectSaved([], []);
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        await parent.unregister();
        await monitor.dispose();
      }
    },
  );
}
