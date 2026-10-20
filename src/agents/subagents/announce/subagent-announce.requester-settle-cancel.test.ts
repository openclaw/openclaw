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
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
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
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";

const fixture = useSubagentControlFixture();
type Dispatch = typeof dispatchGatewayMethodInProcess;
const childResult = "The retained child result.";
const aborted = { status: "timeout", summary: "aborted", stopReason: "rpc" };
const settledResult = () => ({ payloads: [{ text: "The child has settled." }], meta: {} });

const writeSession = (sessionKey: string, defaultSessionId = `${sessionKey}-session`) =>
  writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId,
  });
function registerRun(
  runId: string,
  childSessionKey: string,
  requesterSessionKey: string,
  options: Partial<Parameters<typeof registerSubagentRun>[0]> & { storePath?: string } = {},
) {
  const { storePath, ...overrides } = options;
  return registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey,
    childAgentId: "main",
    requesterAgentId: "main",
    sessionEntry: loadSessionEntry({ agentId: "main", storePath, sessionKey: childSessionKey }),
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    expectsCompletionMessage: true,
    ...overrides,
  });
}
function expectRetired(runIds: string[]) {
  const persisted = loadSubagentRegistryFromSqlite();
  for (const runId of runIds) {
    expect([persisted.has(runId), subagentRuns.has(runId)]).toEqual([false, false]);
  }
}
afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSessionControllerStateForTest();
  resetSystemEventsForTest();
});

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
  const acceptsCancellation = phase !== "declined";
  const ownsTurn = phase !== "unrelated turn";
  const childKeys =
    phase === "exact private retry" ? [childKey, `${childKey}-private`] : [childKey];
  for (const sessionKey of [requesterKey, ...childKeys]) {
    await writeSession(sessionKey, sessionKey === requesterKey ? "requester-session" : undefined);
  }
  const endedAt = Date.now();
  const entries: SubagentRunRecord[] = [];
  for (const childSessionKey of childKeys) {
    const runId = childSessionKey.slice(childSessionKey.lastIndexOf(":") + 1);
    await registerRun(runId, childSessionKey, requesterKey, { task: "Retrieve a result" });
    const entry = structuredClone(subagentRuns.get(runId)!);
    // Restored successful children can owe a wake without a parent turn binding.
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "ok" },
    };
    entry.completion = { required: true, resultText: childResult, capturedAt: endedAt };
    entry.delivery = { status: "pending" };
    entry.cleanupHandled = true;
    entry.cleanupCompletedAt = endedAt;
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    entries.push(entry);
  }
  const entry = entries[0]!;
  if (phase === "exact private retry") {
    entries[1]!.completionTarget = "parent";
    entries[1]!.completionRequesterSessionId = "requester-session";
    for (const child of entries) {
      child.requesterSettleWake = {
        ...child.requesterSettleWake!,
        batchRunIds: entries.map(({ runId }) => runId),
      };
    }
  }
  if (phase === "pending RPC") {
    entry.requesterSettleWake = {
      ...entry.requesterSettleWake!,
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
  const dispatchCancelled = <T>(args: Parameters<Dispatch>) =>
    dispatchGatewayMethodInProcess<T>(args[0], args[1], {
      controllerInput: args[2]?.controllerInput,
      expectFinal: true,
      forceSyntheticClient: true,
      operatorRoleActor: { kind: "system" },
      resolveGatewayContext: () => gatewayContext,
    });
  const completion = { dispatch: dispatchGatewayMethodInProcess };
  let pendingRpcDispatch: Parameters<Dispatch> | undefined;
  vi.spyOn(completion, "dispatch").mockResolvedValue({
    status: "ok",
    inputProcessingCompleted: true,
    result: settledResult(),
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
        custody: { rpcAdopted: undefined },
      });
      if (!controllerInput) {
        throw new Error("Expected settle continuation controller source");
      }
      const sourceSignal = controllerInput.abortSignal;
      pendingRpcDispatch = args;
      admitted.resolve();
      if (!sourceSignal.aborted) {
        await new Promise<void>((resolve) => {
          sourceSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      vi.mocked(completion.dispatch).mockResolvedValueOnce({ runId, ...aborted });
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
        expect(options?.controllerInput).toMatchObject({
          phase: "preparing",
          custody: { rpcAdopted: undefined },
        });
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
        return await dispatchCancelled<T>(args);
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
      await expect(dispatchCancelled(pendingRpcDispatch)).resolves.toMatchObject({
        runId: attempts[0],
        ...aborted,
        providerStarted: false,
      });
      expect(pendingRpcDispatch[2]?.controllerInput?.custody.rpcAdopted).toBeUndefined();
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
          if (acceptsCancellation && ownsTurn) {
            admission?.close();
          }
          return acceptsCancellation;
        },
      });
      if (phase === "failed persistence") {
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining("completion cancellation write rejected"),
        });
      } else if (ownsTurn) {
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
        completion: { resultText: childResult },
        suppressCompletionDelivery: undefined,
      });
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
      expect(persisted).toMatchObject({
        requesterSettleWake: undefined,
        completion: { resultText: childResult },
      });
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
] as const)("settles yielded children after %s without reviving cancelled work", async (phase) => {
  const owner = "agent:main:main";
  const requesterKey = "agent:main:subagent:yielded-requester";
  const nestedKey = "agent:main:subagent:required-child";
  const requester = {
    requesterSessionKey: requesterKey,
    requesterAgentId: "main",
    requesterTurnRunId: "requester",
  };
  let storePath = "";
  for (const [runId, sessionKey, requesterSessionKey] of [
    ["requester", requesterKey, owner],
    ["nested", nestedKey, requesterKey],
  ] as const) {
    storePath = await writeSession(sessionKey, `${runId}-session`);
    await registerRun(runId, sessionKey, requesterSessionKey, {
      storePath,
      requesterTurnRunId: runId === "nested" ? "requester" : undefined,
      expectsCompletionMessage: runId === "nested",
    });
  }
  expect(await markRequesterTurnYielded(requester)).toBe(1);
  await mutateSubagentRuns(["requester"], (rows) => {
    const entry = structuredClone(rows.get("requester")!);
    expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
    return { value: undefined, postimages: new Map([[entry.runId, entry]]) };
  });
  expect(
    await settleRequesterAfterSessionSpawns({
      ...requester,
      requesterYielded: true,
      acceptedSessionSpawns: [
        { runId: "nested", childSessionKey: nestedKey, expectsCompletionMessage: true },
      ],
    }),
  ).toBe(true);

  const original = subagentRuns.get("requester")!;
  const taskId = original.taskRunId ?? original.runId;
  let executionId = original.runId;
  const admitted = createDeferredCore<string>();
  const execute = createDeferredCore();
  const startedTurns: string[] = [];
  const waitBeforeExecution =
    phase === "admitted" || phase === "requester reset" || phase === "requester replacement";
  const completion = { dispatch: dispatchGatewayMethodInProcess };
  vi.spyOn(completion, "dispatch").mockResolvedValue({
    status: "ok",
    result: settledResult(),
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
      taskRunId: taskId,
      childSessionKey: requesterKey,
      requesterSessionKey: owner,
      execution: { status: "running" },
      delivery: { status: "not_required" },
    });
    expect(adopted?.generation).toBeGreaterThan(original.generation ?? 0);
    expect(subagentRuns.has(original.runId)).toBe(false);
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
    executionId = await admitted.promise;
    expect(executionId).not.toBe(original.runId);
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
    await registerRun("replacement", requesterKey, owner, {
      storePath,
      task: "unrelated replacement",
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
    expect(startedTurns).toEqual(phase === "failed kill" ? [requesterKey] : []);
    if (phase === "pending" || phase === "admitted") {
      // Adoption moves custody to the physical run; Stop must publish it before retirement.
      const cancelledRequester = requesterPublications.findLast(
        (entry) =>
          entry.runId === executionId &&
          entry.killReconciliation?.taskCancellationAccepted === true,
      );
      expect(resolveSubagentSessionStatus(cancelledRequester)).toBe("killed");
      expect(cancelledRequester).toMatchObject({
        runId: executionId,
        taskRunId: taskId,
        childSessionKey: requesterKey,
        requesterSessionKey: owner,
        endedReason: "subagent-killed",
        pauseReason: undefined,
        delivery: { status: "not_required" },
        killReconciliation: { taskCancellationAccepted: true, suppressTaskDelivery: true },
        execution: { status: "terminal", outcome: { status: "error", error: "killed" } },
      });
      // With no requester controller to confirm its kill, exercise dormant reconciliation.
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
      expectRetired([executionId, "nested", ...(phase === "admitted" ? [original.runId] : [])]);
      expect(resolveSubagentSessionStatus(nestedPublications.at(-1))).toBe("killed");
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
        expectRetired(["nested"]);
      }
    }
  } finally {
    execute.resolve();
    await fixture.settle();
  }
});
