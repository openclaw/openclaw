// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "../registry/subagent-control.test-support.js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods/core-handlers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import { resetSessionControllerStateForTest } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { killSessionSubagentRuns } from "../registry/subagent-control-kill.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "../registry/subagent-registry-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "../registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { markSubagentRunPausedAfterYield } from "../registry/subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  adoptPausedSubagentRunForFollowUp,
  markRequesterTurnYielded,
  markSubagentRunTerminated,
  registerSubagentRun,
  resumeSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../registry/subagent-registry.persistence.test-support.js";
import { testing as registryTesting } from "../registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "./subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";

const fixture = useSubagentControlFixture();
afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSessionControllerStateForTest();
  resetSystemEventsForTest();
});

it.each(["delivered", "failed"] as const)(
  "settles a restored late-killed child's completion once (%s)",
  async (outcome) => {
    const requesterKey = "agent:main:late-kill-requester";
    const childKey = "agent:main:subagent:late-killed-child";
    for (const sessionKey of [requesterKey, childKey]) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${sessionKey}-session`,
      });
    }
    const runId = "late-killed-child";
    await registerSubagentRun({
      runId,
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: childKey }),
      requesterSessionKey: requesterKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterKey,
      task: "Return the child result",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const killedAt = Date.now();
    const endedAt = killedAt - 9 * 24 * 60 * 60_000;
    await mutateSubagentRuns([runId], (rows) => {
      const entry = structuredClone(rows.get(runId)!);
      Object.assign(entry, {
        createdAt: endedAt - 1_000,
        execution: {
          status: "terminal",
          startedAt: endedAt - 1_000,
          endedAt,
          outcome: { status: "error", error: "killed" },
        },
        endedReason: "subagent-killed",
        suppressAnnounceReason: "killed",
        completion: { required: true },
        delivery: { status: "pending" },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
        killReconciliation: { killedAt, taskCancellationAccepted: true },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 3,
          batchRunIds: [runId],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      return { value: undefined, postimages: new Map([[runId, entry]]) };
    });
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    const completion = { dispatch: dispatchGatewayMethodInProcess };
    const dispatch = vi.spyOn(completion, "dispatch").mockResolvedValue({
      status: "ok",
      inputProcessingCompleted: true,
      result: { payloads: [{ text: "The child was cancelled." }], meta: {} },
    });
    if (outcome === "failed") {
      dispatch.mockRejectedValue(new Error("requester unavailable"));
    }
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: completion.dispatch });
    resumeSubagentRun(runId, "restore");
    await fixture.settle();
    expect(dispatch).toHaveBeenCalledOnce();
    const settled = loadSubagentRegistryFromSqlite().get(runId)!;
    expect(settled.killReconciliation).toBeUndefined();
    expect(settled.requesterSettleWake).toBeUndefined();
    expect(settled.delivery?.status).toBe(outcome);

    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    resumeSubagentRun(runId, "restore");
    await registryTesting.sweepOnceForTests();
    await fixture.settle();
    expect(dispatch).toHaveBeenCalledOnce();
  },
);

it.each([
  "pending",
  "exact private retry",
  "pending RPC",
  "declined",
  "failed persistence",
  "admitted",
  "unrelated turn",
] as const)("preserves completed-child continuation ownership through %s", async (phase) => {
  const requesterKey = "agent:main:stop-completion";
  const childKey = "agent:main:subagent:completed-before-stop";
  const childKeys =
    phase === "exact private retry" ? [childKey, `${childKey}-private`] : [childKey];
  for (const sessionKey of [requesterKey, ...childKeys]) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionKey === requesterKey ? "requester-session" : `${sessionKey}-session`,
    });
  }
  const endedAt = Date.now();
  const entries: SubagentRunRecord[] = [];
  for (const childSessionKey of childKeys) {
    const runId = childSessionKey.slice(childSessionKey.lastIndexOf(":") + 1);
    await registerSubagentRun({
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: childSessionKey }),
      requesterSessionKey: requesterKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterKey,
      task: "Retrieve a result",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const entry = structuredClone(subagentRuns.get(runId)!);
    // Restored successful children can owe a wake without a parent turn binding.
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "ok" },
    };
    entry.completion = {
      required: true,
      resultText: "The retained child result.",
      capturedAt: endedAt,
    };
    entry.delivery = { status: "pending" };
    entry.cleanupHandled = true;
    entry.cleanupCompletedAt = endedAt;
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    entries.push(entry);
  }
  const entry = entries[0]!;
  if (phase === "exact private retry") {
    const privateEntry = entries[1]!;
    privateEntry.completionTarget = "parent";
    privateEntry.completionRequesterSessionId = "requester-session";
    for (const child of entries) {
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: entries.map(({ runId }) => runId),
      };
    }
  }
  if (phase === "pending RPC") {
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    };
  }
  await mutateSubagentRuns(
    entries.map(({ runId }) => runId),
    () => ({
      value: undefined,
      postimages: new Map(entries.map((draft) => [draft.runId, draft])),
    }),
  );

  const admitted = createDeferredCore();
  const execute = createDeferredCore();
  const attempts: string[] = [];
  const started: string[] = [];
  const dedupe = new Map<string, { ts: number; ok: boolean; payload: Record<string, unknown> }>();
  const abortContext = createChatAbortContext({ dedupe, getRuntimeConfig });
  const gatewayContext = Object.assign(abortContext, {
    trackExecution: trackAsyncWork,
  }) as unknown as GatewayRequestContext;
  gatewayContext.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => gatewayContext,
    });
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  let firstAttemptCurrent: (() => void) | undefined;
  type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
  const realGatewayDispatch = dispatchGatewayMethodInProcess;
  const completion = { dispatch: dispatchGatewayMethodInProcess };
  let pendingRpcDispatch: Parameters<Dispatch> | undefined;
  vi.spyOn(completion, "dispatch").mockResolvedValue({
    status: "ok",
    inputProcessingCompleted: true,
    result: { payloads: [{ text: "The child has settled." }], meta: {} },
  });
  const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
    const [, params, options] = args;
    const runId = String(params?.idempotencyKey);
    attempts.push(runId);
    if (phase === "pending RPC") {
      const controllerInput = options?.controllerInput;
      expect(controllerInput).toMatchObject({
        protocolRunId: runId,
        phase: "preparing",
      });
      if (!controllerInput) {
        throw new Error("Expected settle continuation controller source");
      }
      expect(controllerInput.custody.rpcAdopted).toBeUndefined();
      const sourceSignal = controllerInput.abortSignal;
      pendingRpcDispatch = args;
      admitted.resolve();
      if (!sourceSignal.aborted) {
        await new Promise<void>((resolve) => {
          sourceSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      vi.mocked(completion.dispatch).mockResolvedValueOnce({
        runId,
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });
      return await completion.dispatch<T>(...args);
    }
    const owner = prepareSystemAgentRunAdmission(
      getRuntimeConfig(),
      runId,
      "main",
      "stop-completion-proof",
    );
    admission = owner;
    const assertCurrent = resolveAdmittedRunActiveAssertion(await owner.admit("embedded"))!;
    try {
      if (phase === "failed persistence") {
        expect(options?.controllerInput).toMatchObject({ phase: "preparing" });
        expect(options?.controllerInput?.custody.rpcAdopted).toBeUndefined();
        expect(getRpcSource(runId)).toBeUndefined();
      }
      if (attempts.length === 1) {
        firstAttemptCurrent = assertCurrent;
      }
      admitted.resolve();
      if (attempts.length === 1) {
        await execute.promise;
      }
      if (options?.controllerInput?.abortSignal.aborted) {
        // The stopped controller source owns the cancellation receipt, not this fixture's admission.
        return await realGatewayDispatch<T>(args[0], params, {
          controllerInput: options.controllerInput,
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => gatewayContext,
        });
      }
      assertCurrent();
      options?.onExecutionStarted?.();
      started.push(runId);
      return await completion.dispatch<T>(...args);
    } finally {
      owner.close();
    }
  };
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    // Restore resumes each durable wake; the sweeper never re-drives one.
    const resumeWakes = () => {
      for (const child of entries) {
        resumeSubagentRun(child.runId, "restore");
      }
    };
    if (phase !== "pending") {
      resumeWakes();
      await admitted.promise;
    }
    if (phase === "failed persistence") {
      fixture.rejectRegistryWrites(
        (row) => row.runId === entry.runId && row.suppressCompletionDelivery === true,
        "completion cancellation write rejected",
      );
    }
    if (phase === "pending RPC") {
      expect(getRpcSource(attempts[0]!)).toBeUndefined();
      const respond = await invokeChatAbortHandler({
        handler: coreGatewayHandlers["chat.abort"]!,
        context: abortContext,
        request: { sessionKey: requesterKey, runId: attempts[0], agentId: "main" },
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({ aborted: true, runIds: [attempts[0]] }),
      );
      if (!pendingRpcDispatch) {
        throw new Error("Expected captured pending RPC dispatch");
      }
      const [method, pendingParams, pendingOptions] = pendingRpcDispatch;
      await expect(
        realGatewayDispatch(method, pendingParams, {
          controllerInput: pendingOptions?.controllerInput,
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => gatewayContext,
        }),
      ).resolves.toMatchObject({
        runId: attempts[0],
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
        providerStarted: false,
      });
      expect(pendingOptions?.controllerInput?.custody.rpcAdopted).toBeUndefined();
      expect(getRpcSource(attempts[0]!)).toBeUndefined();
    } else {
      const result = await abortControlledSubagents({
        cfg: getRuntimeConfig(),
        sessionKey: requesterKey,
        agentId: "main",
        ...(phase === "exact private retry"
          ? { requesterTurnRunId: attempts[0] }
          : phase === "unrelated turn"
            ? { requesterTurnRunId: "later-human-turn" }
            : {}),
        beforeKill: () => {
          if (phase === "declined") {
            return false;
          }
          if (phase !== "unrelated turn") {
            admission?.close();
          }
          return true;
        },
      });
      if (phase === "failed persistence") {
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining("completion cancellation write rejected"),
        });
      } else if (phase !== "unrelated turn") {
        expect(result?.status).toBe("ok");
      }
    }
    execute.resolve();
    if (phase === "pending") {
      resumeWakes();
    }
    await fixture.settle();

    if (phase === "failed persistence") {
      expect(attempts).toHaveLength(1);
      expect(started).toEqual([]);
      expect(firstAttemptCurrent).toThrow();
      const retained = loadSubagentRegistryFromSqlite().get(entry.runId);
      expect(retained).toMatchObject({
        requesterSettleWake: { status: "pending", attemptCount: 0 },
        execution: { outcome: { status: "ok" } },
        completion: { resultText: "The retained child result." },
      });
      expect(retained?.suppressCompletionDelivery).toBeUndefined();
      expect(subagentRuns.get(entry.runId)?.requesterSettleWake).toEqual(
        retained?.requesterSettleWake,
      );
      // No Gateway turn accepted the failed attempt; restore revalidates fresh authority.
      fixture.worker.mockImplementation(runSubagentStateWorkerOperation);
      resumeWakes();
      await fixture.settle();
      expect(attempts[1]).toBe(attempts[0]);
    }

    const recovered = phase === "failed persistence";
    const continues = recovered || phase === "declined" || phase === "unrelated turn";
    expect.soft(attempts).toHaveLength(recovered ? 2 : phase === "pending" ? 0 : 1);
    expect.soft(started).toHaveLength(continues ? 1 : 0);
    for (const child of entries) {
      const current = subagentRuns.get(child.runId);
      expect.soft(current?.requesterSettleWake).toBeUndefined();
      expect(current?.execution.outcome).toEqual({ status: "ok" });
      const persisted = loadSubagentRegistryFromSqlite().get(child.runId);
      expect(persisted?.requesterSettleWake).toBeUndefined();
      expect(persisted?.completion?.resultText).toBe("The retained child result.");
    }
  } finally {
    admission?.close();
    execute.resolve();
    vi.useRealTimers();
    await fixture.settle();
  }
});

it.each([
  "pending",
  "admitted",
  "failed kill",
  "requester reset",
  "requester replacement",
] as const)(
  "settles a yielded requester's child after %s cancellation without reviving cancelled work",
  async (phase) => {
    const owner = "agent:main:main";
    const requesterKey = "agent:main:subagent:yielded-requester";
    const nestedKey = "agent:main:subagent:required-child";
    let storePath = "";
    for (const [runId, sessionKey, requesterSessionKey] of [
      ["requester", requesterKey, owner],
      ["nested", nestedKey, requesterKey],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
      await registerSubagentRun({
        runId,
        childSessionKey: sessionKey,
        childAgentId: "main",
        sessionEntry: loadSessionEntry({ agentId: "main", storePath, sessionKey }),
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: runId === "nested" ? "requester" : undefined,
        requesterDisplayKey: requesterSessionKey,
        task: runId,
        cleanup: "keep",
        expectsCompletionMessage: runId === "nested",
      });
    }
    expect(
      await markRequesterTurnYielded({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
      }),
    ).toBe(1);
    await mutateSubagentRuns(["requester"], (rows) => {
      const entry = structuredClone(rows.get("requester")!);
      expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
      return { value: undefined, postimages: new Map([[entry.runId, entry]]) };
    });
    expect(
      await settleRequesterAfterSessionSpawns({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "nested", childSessionKey: nestedKey, expectsCompletionMessage: true },
        ],
      }),
    ).toBe(true);

    const originalRequester = subagentRuns.get("requester")!;
    const requesterTaskRunId = originalRequester.taskRunId ?? originalRequester.runId;
    let requesterExecutionRunId = originalRequester.runId;
    const admitted = createDeferredCore<string>();
    const execute = createDeferredCore();
    const startedTurns: string[] = [];
    const waitBeforeExecution =
      phase === "admitted" || phase === "requester reset" || phase === "requester replacement";
    type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
    const completion = { dispatch: dispatchGatewayMethodInProcess };
    vi.spyOn(completion, "dispatch").mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: "The child has settled." }], meta: {} },
    });
    const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
      const [, params, options] = args;
      // Production admission adopts a paused requester before execution starts.
      const runId = String(params?.idempotencyKey);
      expect(
        await adoptPausedSubagentRunForFollowUp({
          childSessionKey: String(params?.sessionKey),
          runId,
          task: String(params?.message),
        }),
      ).toBe(true);
      const adopted = subagentRuns.get(runId);
      expect(adopted).toMatchObject({
        runId,
        taskRunId: requesterTaskRunId,
        childSessionKey: requesterKey,
        requesterSessionKey: owner,
        execution: { status: "running" },
        delivery: { status: "not_required" },
      });
      expect(adopted?.generation).toBeGreaterThan(originalRequester.generation ?? 0);
      expect(subagentRuns.has(originalRequester.runId)).toBe(false);
      admitted.resolve(runId);
      if (waitBeforeExecution) {
        await execute.promise;
      }
      options?.onExecutionStarted?.();
      startedTurns.push(String(params?.sessionKey));
      return await completion.dispatch<T>(...args);
    };
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
    const requesterPublications: SubagentRunRecord[] = [];
    const nestedPublications: SubagentRunRecord[] = [];
    onTestFinished(
      subscribeSubagentRunChanges("persistence", ({ runIds }) => {
        for (const runId of runIds ?? subagentRuns.keys()) {
          const published = subagentRuns.get(runId);
          if (published?.childSessionKey === requesterKey) {
            requesterPublications.push(published);
          } else if (
            published?.childSessionKey === nestedKey &&
            published.execution.status === "terminal"
          ) {
            nestedPublications.push(published);
          }
        }
      }),
    );

    if (phase !== "pending") {
      // A terminal child is skipped by tree cancellation; its yielded requester
      // still owns the pending synthesis and must fence an already admitted wake.
      expect(await markSubagentRunTerminated({ runId: "nested", reason: "killed" })).toBe(1);
    }
    const completedNestedOutcome =
      phase === "pending"
        ? undefined
        : structuredClone(subagentRuns.get("nested")!.execution.outcome);
    if (waitBeforeExecution) {
      await registryTesting.sweepOnceForTests();
      requesterExecutionRunId = await admitted.promise;
      expect(requesterExecutionRunId).not.toBe(originalRequester.runId);
    }
    if (phase === "failed kill") {
      fixture.rejectRegistryWrites(
        (row) => row.runId === "requester" && Boolean(row.killIntent),
        "requester kill intent rejected",
      );
    }
    if (phase === "requester reset") {
      await patchSessionEntryCore({ storePath, sessionKey: requesterKey }, (entry) => ({
        ...entry,
        lifecycleRevision: "replacement-incarnation",
      }));
    }
    if (phase === "requester replacement") {
      await registerSubagentRun({
        runId: "replacement",
        childSessionKey: requesterKey,
        childAgentId: "main",
        sessionEntry: loadSessionEntry({ agentId: "main", storePath, sessionKey: requesterKey }),
        requesterSessionKey: owner,
        requesterAgentId: "main",
        requesterDisplayKey: owner,
        task: "unrelated replacement",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
    }
    try {
      if (phase === "pending" || phase === "admitted" || phase === "failed kill") {
        const result = await killSessionSubagentRuns({
          cfg: getRuntimeConfig(),
          sessionKey: owner,
          agentId: "main",
        });
        expect(result.status).toBe(phase === "failed kill" ? "error" : "ok");
      }
      execute.resolve();
      if (!waitBeforeExecution) {
        await registryTesting.sweepOnceForTests();
      }
      await fixture.settle();
      if (phase === "failed kill") {
        expect(startedTurns).toEqual([requesterKey]);
      } else {
        expect(startedTurns).toEqual([]);
        if (phase === "pending" || phase === "admitted") {
          // The retired Task ledger was keyed by the stable taskRunId. Native
          // adoption moves custody to the admitted physical run before Stop.
          // Stop publishes the terminal record before the completed obligation retires it.
          const cancelledRequester = requesterPublications.findLast(
            (entry) =>
              entry.runId === requesterExecutionRunId &&
              entry.killReconciliation?.taskCancellationAccepted === true,
          );
          expect(resolveSubagentSessionStatus(cancelledRequester)).toBe("killed");
          expect(cancelledRequester).toMatchObject({
            runId: requesterExecutionRunId,
            taskRunId: requesterTaskRunId,
            childSessionKey: requesterKey,
            requesterSessionKey: owner,
            endedReason: "subagent-killed",
            pauseReason: undefined,
            delivery: { status: "not_required" },
            killReconciliation: { taskCancellationAccepted: true, suppressTaskDelivery: true },
          });
          expect(cancelledRequester?.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "error", error: "killed" },
          });
          // This fixture has no requester controller operation to confirm its kill.
          // Exercise the dormant reconciliation owner before expecting row retirement.
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValue(Date.now() + PROVISIONAL_KILL_RECONCILIATION_MS);
          try {
            await registryTesting.sweepOnceForTests();
            await fixture.settle();
          } finally {
            clock.mockRestore();
          }
          expect(startedTurns).toEqual([]);
          const persisted = loadSubagentRegistryFromSqlite();
          expect(persisted.has(requesterExecutionRunId)).toBe(false);
          expect(subagentRuns.has(requesterExecutionRunId)).toBe(false);
          if (phase === "admitted") {
            expect(persisted.has(originalRequester.runId)).toBe(false);
            expect(subagentRuns.has(originalRequester.runId)).toBe(false);
          }
          expect(resolveSubagentSessionStatus(nestedPublications.at(-1))).toBe("killed");
          expect(persisted.has("nested")).toBe(false);
          expect(subagentRuns.has("nested")).toBe(false);
        }
      }
      expect(subagentRuns.get("nested")?.requesterSettleWake).toBeUndefined();
      if (completedNestedOutcome) {
        expect(nestedPublications.length).toBeGreaterThan(0);
        for (const published of nestedPublications) {
          expect(published.execution.outcome).toEqual(completedNestedOutcome);
        }
        if (phase === "requester reset" || phase === "requester replacement") {
          expect(subagentRuns.get("nested")?.execution.outcome).toEqual(completedNestedOutcome);
        } else {
          expect(subagentRuns.has("nested")).toBe(false);
          expect(loadSubagentRegistryFromSqlite().has("nested")).toBe(false);
        }
      }
    } finally {
      execute.resolve();
      await fixture.settle();
    }
  },
);
