import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import { type RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRequesterWakeSettlementBoundaryTests<Response>({
  requesterSessionKey,
  prepareChildSession,
  wakeRequester,
  flushAsync,
  callGatewayMock,
  setReleaseAgentCallGate,
  spawnVisibleChild,
  settleTurn,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  getAgentCalls,
  createGatewayContext,
  getLifecycleHandler,
  useGlobalSessionScope,
}: RequesterWakeFixture & {
  callGatewayMock: Mock<(request: GatewayRequest) => Promise<Response>>;
  flushAsync: () => Promise<void>;
  setReleaseAgentCallGate: (release: () => void) => void;
  useGlobalSessionScope: () => void;
}): void {
  it("delivers an adopted self-yield follow-up once while ordinary announce is in flight", async () => {
    vi.setSystemTime(100_000);
    const context = createGatewayContext();
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context);
    const childSessionKey = "agent:main:subagent:self-yield-followup";
    const kickoffRunId = "run-self-yield-kickoff";
    const followupRunId = "run-self-yield-followup";
    const sessionEntry = await prepareChildSession(childSessionKey, "sess-self-yield-followup");
    const register = (runId: string, expectsCompletionMessage: boolean) =>
      registry.registerSubagentRun(
        createSubagentRunParams({
          runId,
          childSessionKey,
          sessionEntry,
          requesterAgentId: "main",
          expectsCompletionMessage,
          gatewayContextResolver: context.resolveGatewayContext,
        }),
      );
    await register(kickoffRunId, true);
    await registry.claimSubagentYield({
      runId: kickoffRunId,
      sessionKey: childSessionKey,
      agentId: "main",
      waitForMessage: true,
      hasPendingWork: () => false,
    });
    await register(followupRunId, false);
    getLifecycleHandler()!({
      stream: "lifecycle",
      runId: kickoffRunId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: { phase: "end", endedAt: Date.now(), yielded: true },
    });
    await flushOwnedWork();

    const ordinaryEntered = createDeferred();
    const ordinaryRelease = createDeferred();
    setReleaseAgentCallGate(() => ordinaryRelease.resolve());
    const respond = callGatewayMock.getMockImplementation()!;
    callGatewayMock.mockImplementation(async (request) => {
      if (
        request.method === "agent" &&
        request.params?.idempotencyKey?.startsWith("announce:v1:")
      ) {
        ordinaryEntered.resolve();
        await ordinaryRelease.promise;
      }
      return respond(request);
    });
    const wakes = vi
      .mocked(maybeWakeRequesterAfterAllChildrenSettled)
      .mockClear()
      .mockImplementation(wakeRequester);
    emitCompleted(followupRunId, childSessionKey, "follow-up completed");
    const completion = flushOwnedWork();
    try {
      await awaitGateBeforeSettlement(
        ordinaryEntered.promise,
        completion,
        "adopted follow-up settled without an ordinary announcement",
      );
      // Join all live wakes started before the delivery receipt commits.
      await registry.testing.sweepOnceForTests();
      await flushAsync();
      await Promise.all(wakes.mock.results.map(({ value }) => value));
    } finally {
      ordinaryRelease.resolve();
      await completion;
    }
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    await waitForDeliveredCleanup(followupRunId);
  });
  const readRun = registry.getSubagentRunByRunId;
  async function settleYield(runId: string, children: ReturnType<typeof visibleChild>[]) {
    await createRequesterYieldTool(requesterSessionKey, runId).execute(runId, {});
    await settleTurn(runId, children);
  }
  const addRun = (
    runId: string,
    childSessionKey: string,
    overrides: Omit<Parameters<typeof registry.addSubagentRunForTests>[0], "runId">,
  ) =>
    registry.addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      ...overrides,
    });
  it("delivers a yielded result despite an older failed grandchild awaiting cleanup", async () => {
    const oldTime = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oldParentKey = "agent:main:subagent:old-parent";
    await addRun("old-parent", oldParentKey, {
      childAgentId: "main",
      createdAt: oldTime,
      endedAt: oldTime + 100,
      delivery: { status: "delivered", disposition: "delivered" },
      cleanupCompletedAt: oldTime + 100,
    });
    await addRun("old-grandchild", "agent:main:subagent:old-grandchild", {
      childAgentId: "main",
      requesterSessionKey: oldParentKey,
      createdAt: oldTime + 10,
      endedAt: oldTime + 50,
      outcome: { status: "error", error: "Gateway lifecycle dispatch unavailable" },
      completion: { required: true, resultText: "unrelated old result" },
    });

    const requesterTurnRunId = "current-requester";
    const child = visibleChild("current-child");
    await spawnVisibleChild({ ...child, requesterTurnRunId });
    await settleYield(requesterTurnRunId, [child]);
    emitCompleted(child.runId, child.childSessionKey, "current counting result");
    await flushOwnedWork();
    await waitForDeliveredCleanup(child.runId);

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
    expect(wakeMessage).toContain("current counting result");
    expect(wakeMessage).not.toContain("unrelated old result");
    expect(readRun("old-grandchild")).toMatchObject({
      delivery: { status: "pending" },
    });
    expect(readRun("old-grandchild")?.cleanupCompletedAt).toBeUndefined();
  });
  it("delivers after its owned descendant settles despite foreign active work in a global session", async () => {
    vi.setSystemTime(100_000);
    useGlobalSessionScope();
    await addRun("run-main-batch", "agent:main:subagent:batch", {
      createdAt: 1_000,
      endedAt: 1_200,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-main-batch"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    await addRun("run-main-stale", "agent:main:subagent:stale", {
      requesterSessionKey: "agent:main:subagent:batch",
      createdAt: 2_000,
      endedAt: 2_200,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    });
    await addRun("run-research-active", "agent:research:subagent:active", {
      requesterAgentId: "research",
      createdAt: 3_000,
    });

    const transitions: Array<{ status: string; attemptCount: number }> = [];
    const waits: Array<number | undefined> = [];
    const completions: Array<{ delivered: boolean; error?: string }> = [];
    const runWake = () =>
      maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry: expectDefined(readRun("run-main-batch"), "main requester batch"),
        onDescendantsPending: (deadline) => waits.push(deadline),
        transitionBatch: async (entries, state, onPublished) => {
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "transition", state },
            assertCurrent: () => {},
            onPublished: () =>
              onPublished?.(entries.map((entry) => subagentRuns.get(entry.runId)!)),
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          transitions.push({ status: state.status, attemptCount: state.attemptCount });
        },
        completeBatch: async (entries, _rearmGeneration, outcome) => {
          const delivery = expectDefined(outcome, "requester delivery outcome");
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "settle", outcome: delivery },
            assertCurrent: () => {},
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          completions.push({ delivered: delivery.delivered, error: delivery.error });
        },
      });

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toEqual([]);
    expect(waits).toEqual([302_200]);
    expect(completions).toEqual([]);

    // Descendant settlement makes this recorded cohort runnable. Foreign work
    // sharing the logical key still cannot hold this physical requester's wake.
    await mutateSubagentRuns(["run-main-stale"], (rows) => {
      const stale = expectDefined(rows.get("run-main-stale"), "owned descendant");
      const settled: SubagentRunRecord = {
        ...stale,
        delivery: { status: "delivered", disposition: "delivered" },
        cleanupCompletedAt: Date.now(),
      };
      return {
        value: undefined,
        postimages: new Map([[stale.runId, settled]]),
      };
    });
    await expect(runWake()).resolves.toBe(true);
    expect(transitions).toEqual([{ status: "dispatching", attemptCount: 1 }]);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(completions).toEqual([{ delivered: true, error: undefined }]);
    expect(readRun("run-main-batch")?.requesterSettleWake).toBeUndefined();
    const activeDescendants = (agentId?: string) =>
      buildScopedSubagentRunReadIndexFromRuns(
        subagentRuns,
        requesterSessionKey,
        agentId,
      ).countActiveDescendantRuns(requesterSessionKey);
    expect([activeDescendants(), activeDescendants("main")]).toEqual([1, 0]);
  });

  it("wakes a yielded parent once after one running child is stopped", async () => {
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(createGatewayContext);
    const requesterTurnRunId = "requester-stopped-pair";
    const stopped = visibleChild("stopped");
    const finished = visibleChild("finished");
    for (const child of [stopped, finished]) {
      await spawnVisibleChild({ ...child, requesterTurnRunId });
    }
    await settleYield(requesterTurnRunId, [stopped, finished]);
    const lifecycleHandler = expectDefined(getLifecycleHandler(), "lifecycle listener before Stop");
    lifecycleHandler({
      stream: "lifecycle",
      runId: stopped.runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: stopped.childSessionKey,
      data: { phase: "end", endedAt: Date.now(), aborted: true, stopReason: "aborted" },
    });
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(readRun(stopped.runId)).toMatchObject({
      endedReason: "subagent-killed",
      suppressCompletionDelivery: true,
    });

    emitCompleted(finished.runId, finished.childSessionKey, "finished sibling findings");
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wake = String(getRequesterWakeCalls()[0]?.params?.message);
    expect(wake).toContain("finished sibling findings");
    expect(wake).toMatch(
      /run-stopped\n<\/prompt-data>\nstatus: cancelled[^\n]*\n[^\n]*\n<prompt-data>\n\(no output\)/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.testing.sweepOnceForTests();
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    expect(readRun(finished.runId)?.requesterSettleWake).toBeUndefined();
    expect(readRun(stopped.runId)).toBeUndefined();
  });
}
