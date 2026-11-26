import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../../config/sessions/session-accessor.sqlite-read.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import {
  registerRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import type { RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import { registerRequesterRestartDeliveryTests } from "./subagent-registry.restart-delivery.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRequesterWakeSettlementBoundaryTests<Response>({
  requesterSessionKey,
  getFixture,
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
  registerRequesterRestartDeliveryTests({
    requesterSessionKey,
    getFixture,
    prepareChildSession,
    callGatewayMock,
    spawnVisibleChild,
    settleTurn,
    flushOwnedWork,
    waitForDeliveredCleanup,
    getRequesterWakeCalls,
    createGatewayContext,
    getLifecycleHandler,
  });

  it.each(["never bound", "binding retired", "restored"])(
    "delivers the bound member of a frozen batch with a %s member",
    async (binding) => {
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const batchRunIds = ["run-unbound", "run-bound"];
      for (const runId of batchRunIds) {
        const childSessionKey = `agent:main:subagent:${runId}`;
        const sessionEntry = await prepareChildSession(childSessionKey, `sess-${runId}`);
        await registry.addSubagentRunForTests({
          runId,
          childSessionKey,
          childAgentId: "main",
          childSessionIdentity: sessionEntry,
          requesterSessionKey,
          requesterAgentId: "main",
          completionRequesterSessionId: "sess-main",
          expectsCompletionMessage: true,
          endedAt: Date.now() - 32 * 60_000,
          outcome: { status: "ok" },
          completion: {
            required: true,
            resultText: `saved result ${runId}`,
            capturedAt: Date.now(),
          },
          delivery: { status: "pending" },
          cleanupCompletedAt: Date.now(),
          retireAfterSettle: binding === "restored" && runId === "run-unbound" ? true : undefined,
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            batchRunIds,
            rearmGeneration: 1,
          },
        });
        const entry = subagentRuns.get(runId)!;
        if (runId === "run-bound" || binding === "binding retired") {
          bindGatewayContextResolver(entry, context.resolveGatewayContext);
        }
        if (runId === "run-unbound") {
          if (binding === "binding retired") {
            retireSubagentGatewayBinding(entry);
          } else if (binding === "restored") {
            subagentRuns.delete(runId);
            await restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true });
            expect(subagentRuns.isCompletionAuthorityRetired(subagentRuns.get(runId)!)).toBe(true);
          }
        }
      }
      const append = vi.fn(() => true);
      const owner = {
        requesterAgentId: "main",
        requesterSessionKey,
        requesterSessionId: "sess-main",
        requesterTurnRunId: "yielded-requester",
      };
      const attachment = registerRequesterFinalAttachment({
        ...owner,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        timeoutMs: 60_000,
        append,
      });
      onTestFinished(() => attachment.revoke());
      expect(promoteRequesterFinalAttachment({ ...owner, batchRunIds, rearmGeneration: 1 })).toBe(
        true,
      );
      registry.resumeSubagentRun(binding === "restored" ? "run-unbound" : "run-bound");
      await flushOwnedWork();
      expect(registry.getSubagentRunByRunId("run-bound")?.delivery).toMatchObject({
        status: "delivered",
      });
      expect(
        getRequesterWakeCalls().some((call) =>
          String(call.params?.message).includes("saved result run-bound"),
        ),
      ).toBe(true);
      expect(append).toHaveBeenCalledWith("completion delivered");
      expect(append).toHaveBeenCalledTimes(binding === "restored" ? 1 : 2);
      const unbound = registry.getSubagentRunByRunId("run-unbound");
      if (binding === "restored") {
        expect(unbound).toBeUndefined();
        const statuses = readTranscriptEventRows(
          openOpenClawAgentDatabase({ agentId: "main" }),
          "sess-main",
        )
          .map((row) => JSON.parse(row.eventJson))
          .filter((event) => event.customType === "subagent-completion");
        expect(statuses).toEqual([
          expect.objectContaining({
            display: false,
            content: expect.stringContaining("saved result run-unbound"),
            details: expect.objectContaining({ childRunIds: ["run-unbound"] }),
          }),
        ]);
        expect(statuses[0]).not.toHaveProperty("excludeFromContext");
        return;
      }
      expect(unbound?.requesterSettleWake).toBeUndefined();
      expect(unbound?.delivery?.status).toBe("delivered");
    },
  );

  it.each([
    ...["alpha", "beta"].flatMap((firstCompleted) =>
      ["same", "distinct", "mixed-unbound", "yielded"].map((mode) => ({
        firstCompleted,
        binding: mode === "yielded" ? "same" : mode,
        yieldedParent: mode === "yielded" ? "alpha" : undefined,
        rawChild: false,
        visible: false,
      })),
    ),
    {
      firstCompleted: "alpha",
      binding: "same",
      yieldedParent: "alpha",
      rawChild: true,
      visible: false,
    },
    {
      firstCompleted: "alpha",
      binding: "same",
      yieldedParent: "alpha",
      rawChild: false,
      visible: true,
    },
  ])(
    "settles overlapping caller turns with $firstCompleted first ($binding ownership, yielded=$yieldedParent, raw=$rawChild, visible=$visible)",
    async ({ firstCompleted, binding, yieldedParent, rawChild, visible }) => {
      vi.setSystemTime(100_000);
      const context = createGatewayContext();
      const otherContext = createGatewayContext();
      await registry.initSubagentRegistry();
      const activate = async () => {
        // Standalone registration can be wholly unbound, but cannot mix ambient
        // routing with a captured owner. Each live run retains its admitting owner.
        if (binding !== "mixed-unbound") {
          await registry.activateSubagentRegistry(() => context);
        }
      };
      await activate();
      const children = ["alpha", "beta"].map((name) => ({
        name,
        runId: `run-${name}`,
        childSessionKey: rawChild && name === "alpha" ? "global" : `agent:main:subagent:${name}`,
      }));
      const resolvers: Array<GatewayRequestContext["resolveGatewayContext"]> = [];
      for (const child of children) {
        const sessionEntry = await prepareChildSession(child.childSessionKey, `sess-${child.name}`);
        const requesterTurnRunId = `requester-${child.name}`;
        const admission = prepareSystemAgentRunAdmission(
          {},
          requesterTurnRunId,
          "main",
          "requester-wake-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          bindGatewayContextResolver(
            admitted,
            binding !== "same" && child.name === "beta"
              ? binding === "distinct"
                ? otherContext.resolveGatewayContext
                : undefined
              : context.resolveGatewayContext,
          );
          await withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: requesterSessionKey,
            }),
            async () => {
              const gatewayContextResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
              resolvers.push(gatewayContextResolver);
              if (visible) {
                await spawnVisibleChild({ ...child, requesterTurnRunId });
                return;
              }
              await registry.registerSubagentRun(
                createSubagentRunParams({
                  ...child,
                  childAgentId: "main",
                  sessionEntry,
                  requesterTurnRunId,
                  requesterAgentId: "main",
                  expectsCompletionMessage: true,
                  gatewayContextResolver,
                }),
              );
            },
          );
          if (child.name === yieldedParent) {
            await createRequesterYieldTool(requesterSessionKey, requesterTurnRunId).execute(
              `yield-${child.name}`,
              {},
            );
          }
          await registry.settleRequesterAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: child.name === yieldedParent,
            acceptedSessionSpawns: [child],
          });
        } finally {
          admission.close();
        }
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(resolvers[0]).not.toBe(resolvers[1]);
      expect(resolvers[0]?.()).toBe(context);
      expect(resolvers[1]?.()).toBe(
        binding === "same" ? context : binding === "distinct" ? otherContext : undefined,
      );
      await activate();
      await activate();
      children.forEach((child, index) => {
        expect(getGatewayContextResolver(registry.getSubagentRunByRunId(child.runId)!)).toBe(
          resolvers[index],
        );
      });
      const completionOrder = firstCompleted === "alpha" ? children : children.toReversed();
      const first = completionOrder[0]!;
      const second = completionOrder[1]!;
      emitCompleted(first.runId, first.childSessionKey, `${first.name} complete`);
      await flushOwnedWork();
      await waitForDeliveredCleanup(first.runId, {
        allowPendingRequesterSettleWake: first.name !== yieldedParent,
      });
      if (rawChild) {
        const settled = registry.getSubagentRunByRunId(first.runId);
        expect(settled).toMatchObject({
          childAgentId: "main",
          childSessionIdentity: { sessionId: "sess-alpha", lifecycleRevision: "original" },
          execution: { status: "terminal" },
          delivery: { status: "delivered" },
        });
        expect(settled?.execution.suppressSessionEffects).not.toBe(true);
        expect(settled?.requesterSettleWake).toBeUndefined();
        expect(settled?.cleanupCompletedAt).toBeTypeOf("number");
        expect(settled?.browserCleanupDispatchedAt).toBeTypeOf("number");
      }
      expect(registry.getSubagentRunByRunId(second.runId)).toMatchObject({
        execution: { status: "running" },
        delivery: { status: "pending" },
      });
      expect(getRequesterWakeCalls()).toHaveLength(first.name === yieldedParent ? 1 : 0);
      if (first.name === yieldedParent) {
        const wake = getRequesterWakeCalls()[0]?.params;
        expect(wake?.inputProvenance?.sourceSessionKey).toBe(first.childSessionKey);
        expect(wake?.message).toContain(`${first.name} complete`);
        expect(wake?.message).not.toContain(`${second.name} complete`);
        const completed = registry.getSubagentRunByRunId(first.runId)!;
        expect(completed.execution.status).toBe("terminal");
        expect(getGatewayContextResolver(completed)).toBeUndefined();
      }
      await activate();
      await activate();
      children.forEach((child, index) => {
        const row = registry.getSubagentRunByRunId(child.runId)!;
        if (child === first) {
          // Ordinary delivered singletons release their source just like yielded batches.
          expect(getGatewayContextResolver(row)).toBeUndefined();
        } else {
          expect(getGatewayContextResolver(row)).toBe(resolvers[index]);
        }
        expect(row.requesterTurnRunId).toBeUndefined();
      });
      emitCompleted(second.runId, second.childSessionKey, `${second.name} complete`);
      await flushOwnedWork();
      await waitForDeliveredCleanup(second.runId, { allowPendingRequesterSettleWake: true });
      await activate();
      await registry.testing.sweepOnceForTests();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      // Separately delivered singletons do not mint a redundant aggregate continuation.
      expect(getRequesterWakeCalls()).toHaveLength(yieldedParent ? 1 : 0);
      for (const child of children) {
        const entry = registry.getSubagentRunByRunId(child.runId);
        expect(entry).toMatchObject({
          delivery: { status: "delivered" },
        });
        expect(entry?.requesterSettleWake).toBeUndefined();
      }
      if (rawChild) {
        const retained = loadSubagentRegistryFromSqlite().get(first.runId);
        expect(retained).toMatchObject({
          childSessionKey: "global",
          childAgentId: "main",
          delivery: { status: "delivered" },
        });
        expect(retained?.execution.suppressSessionEffects).not.toBe(true);
        expect(retained?.requesterSettleWake).toBeUndefined();
        expect(retained?.cleanupCompletedAt).toBeTypeOf("number");
        expect(retained?.browserCleanupDispatchedAt).toBeTypeOf("number");
        expect(
          loadExactSessionEntryReadOnly({
            agentId: "main",
            storePath: getFixture().sessionStorePath,
            sessionKey: "global",
          })?.entry,
        ).toMatchObject({ sessionId: "sess-alpha", lifecycleRevision: "original" });
      }
    },
  );

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

  it("reports a stopped child and its finished sibling to a yielded parent once each", async () => {
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
    // The stop is a settled outcome; the parent hears it while the sibling still works.
    expect(getRequesterWakeCalls()).toHaveLength(1);
    const stopWake = String(getRequesterWakeCalls()[0]?.params?.message);
    expect(stopWake).toMatch(
      /run-stopped\n<\/prompt-data>\nstatus: cancelled[^\n]*\n[^\n]*\n<prompt-data>\n\(no output\)/,
    );
    expect(stopWake).toContain("still working: run-finished");

    emitCompleted(finished.runId, finished.childSessionKey, "finished sibling findings");
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(2);
    const wake = String(getRequesterWakeCalls()[1]?.params?.message);
    expect(wake).toContain("finished sibling findings");
    expect(wake).not.toContain("run-stopped");
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.testing.sweepOnceForTests();
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(2);
    expect(readRun(finished.runId)?.requesterSettleWake).toBeUndefined();
    expect(readRun(stopped.runId)).toBeUndefined();
  });
}
