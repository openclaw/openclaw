// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  persistSubagentRunsToDiskOrThrow,
  useSubagentControlFixture,
} from "../registry/subagent-control.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-runtime.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods/core-handlers.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../infra/system-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { finalizeTaskRunByRunId } from "../../../tasks/detached-task-runtime.js";
import { tasksWithPendingDelivery } from "../../../tasks/task-registry-state.js";
import {
  cancelTaskById,
  findTaskByRunId,
  getTaskById,
  maybeDeliverTaskTerminalUpdate,
} from "../../../tasks/task-registry.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { killSessionSubagentRuns } from "../registry/subagent-control-kill.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../registry/subagent-registry-run-pause.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../registry/subagent-registry-state.js";
import {
  adoptPausedSubagentRunForFollowUp,
  markRequesterTurnYielded,
  markSubagentRunTerminated,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../registry/subagent-registry.persistence.test-support.js";
import { testing as registryTesting } from "../registry/subagent-registry.test-helpers.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "./subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";

const fixture = useSubagentControlFixture();
afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSystemEventsForTest();
});

it.each([
  "pending",
  "admitted",
  "exact admitted",
  "exact private retry",
  "pending RPC",
  "retry backoff",
  "declined",
  "failed persistence",
  "worker persistence",
  "unrelated turn",
  "transient failure",
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
  const entries = childKeys.map((childSessionKey) => {
    const runId = childSessionKey.slice(childSessionKey.lastIndexOf(":") + 1);
    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: requesterKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterKey,
      task: "Retrieve a result",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const entry = subagentRuns.get(runId)!;
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
    return entry;
  });
  const entry = entries[0]!;
  if (phase === "exact private retry") {
    const privateEntry = entries[1]!;
    privateEntry.completionTarget = "parent";
    privateEntry.completionRequesterSessionId = "requester-session";
    for (const child of entries) {
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 1,
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
  persistSubagentRunsToDiskOrThrow(
    subagentRuns,
    entries.map(({ runId }) => runId),
  );
  for (const child of entries) {
    finalizeTaskRunByRunId({
      runId: child.runId,
      runtime: "subagent",
      sessionKey: child.childSessionKey,
      status: "succeeded",
      endedAt,
    });
  }

  const admitted = createDeferredCore();
  const execute = createDeferredCore();
  const attempts: string[] = [];
  const started: string[] = [];
  const dedupe = new Map<string, { ts: number; ok: boolean; payload: Record<string, unknown> }>();
  const abortContext = createChatAbortContext({ dedupe, getRuntimeConfig });
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
  const completion = { dispatch: dispatchGatewayMethodInProcess };
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
      dedupe.set(`agent:${runId}`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId,
          sessionKey: requesterKey,
          sessionId: "requester-session",
          agentId: "main",
          status: "accepted",
          controlUiVisible: true,
        },
      });
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
      admitted.resolve();
      if (attempts.length === 1) {
        await execute.promise;
        if (phase === "transient failure" || phase === "retry backoff") {
          throw new Error("temporary requester delivery failure");
        }
        if (phase === "pending RPC") {
          const cancelled = dedupe.get(`agent:${runId}`)?.payload;
          expect(cancelled).toMatchObject({
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          });
          vi.mocked(completion.dispatch).mockResolvedValueOnce(cancelled);
          return await completion.dispatch<T>(...args);
        }
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
    if (phase !== "pending") {
      await registryTesting.sweepOnceForTests();
      await admitted.promise;
    }
    if (phase === "retry backoff") {
      execute.resolve();
      await fixture.settle();
      expect(entry.requesterSettleWake?.status).toBe("pending");
    }
    if (phase === "failed persistence") {
      fixture.persist.mockImplementation((runs, runIds) => {
        if (runs.get(entry.runId)?.suppressCompletionDelivery) {
          throw new Error("completion cancellation write rejected");
        }
        persistSubagentRunsToDiskOrThrow(runs, runIds);
      });
    }
    if (phase === "worker persistence") {
      const actual = await vi.importActual<typeof import("../registry/subagent-registry-state.js")>(
        "../registry/subagent-registry-state.js",
      );
      vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementationOnce(
        actual.persistSubagentRunsToDiskAsyncOrThrow,
      );
    }
    if (phase === "pending RPC") {
      const respond = await invokeChatAbortHandler({
        handler: coreGatewayHandlers["chat.abort"]!,
        context: abortContext,
        request: { sessionKey: requesterKey, runId: attempts[0], agentId: "main" },
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({ aborted: true, runIds: [attempts[0]] }),
      );
    } else if (phase !== "transient failure") {
      const result = await abortControlledSubagents({
        cfg: getRuntimeConfig(),
        sessionKey: requesterKey,
        agentId: "main",
        ...(phase === "exact admitted" ||
        phase === "exact private retry" ||
        phase === "retry backoff"
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
        expect(result?.status).toBe("error");
      } else if (phase !== "unrelated turn") {
        expect(result?.status).toBe("ok");
      }
    }
    execute.resolve();
    if (phase === "pending") {
      await registryTesting.sweepOnceForTests();
    }
    await fixture.settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await registryTesting.sweepOnceForTests();
    await fixture.settle();

    const retry = phase === "transient failure" || phase === "failed persistence";
    const continues = retry || phase === "declined" || phase === "unrelated turn";
    expect.soft(attempts).toHaveLength(retry ? 2 : phase === "pending" ? 0 : 1);
    expect.soft(started).toHaveLength(continues ? 1 : 0);
    if (retry) {
      expect(attempts[1]).toBe(`${attempts[0]}:retry-1`);
    }
    for (const child of entries) {
      expect.soft(child.requesterSettleWake).toBeUndefined();
      expect(child.execution.outcome).toEqual({ status: "ok" });
      expect(child.completion?.resultText).toBe("The retained child result.");
      expect(findTaskByRunId(child.runId)?.status).toBe("succeeded");
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
  "unsuppressed",
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
      registerSubagentRun({
        runId,
        childSessionKey: sessionKey,
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
      markRequesterTurnYielded({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
      }),
    ).toBe(1);
    expect(markSubagentRunPausedAfterYield({ entry: subagentRuns.get("requester")! })).toBe(true);
    persistSubagentRunsToDiskOrThrow(subagentRuns, ["requester"]);
    expect(
      settleRequesterAfterSessionSpawns({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "nested", childSessionKey: nestedKey, expectsCompletionMessage: true },
        ],
      }),
    ).toBe(true);

    const admitted = createDeferredCore();
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
      adoptPausedSubagentRunForFollowUp({
        childSessionKey: String(params?.sessionKey),
        runId: String(params?.idempotencyKey),
        task: String(params?.message),
      });
      admitted.resolve();
      if (waitBeforeExecution) {
        await execute.promise;
      }
      options?.onExecutionStarted?.();
      startedTurns.push(String(params?.sessionKey));
      return await completion.dispatch<T>(...args);
    };
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });

    if (phase !== "pending") {
      // A terminal child is skipped by tree cancellation; its yielded requester
      // still owns the pending synthesis and must fence an already admitted wake.
      expect(markSubagentRunTerminated({ runId: "nested", reason: "killed" })).toBe(1);
    }
    if (waitBeforeExecution) {
      await registryTesting.sweepOnceForTests();
      await admitted.promise;
    }
    if (phase === "failed kill") {
      fixture.persist.mockImplementation((runs, changedRunIds) => {
        if (runs.get("requester")?.killIntent) {
          throw new Error("requester kill intent rejected");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      });
    }
    if (phase === "requester reset") {
      await patchSessionEntryCore({ storePath, sessionKey: requesterKey }, (entry) => ({
        ...entry,
        lifecycleRevision: "replacement-incarnation",
      }));
    }
    if (phase === "requester replacement") {
      registerSubagentRun({
        runId: "replacement",
        childSessionKey: requesterKey,
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
      if (phase === "unsuppressed" || phase === "failed kill") {
        expect(startedTurns).toEqual([requesterKey]);
      } else {
        expect(startedTurns).toEqual([]);
        if (phase === "pending" || phase === "admitted") {
          expect(findTaskByRunId("requester")?.status).toBe("cancelled");
          expect(findTaskByRunId("nested")?.status).toBe("cancelled");
        }
      }
      expect(subagentRuns.get("nested")?.requesterSettleWake).toBeUndefined();
    } finally {
      execute.resolve();
      await fixture.settle();
    }
  },
);

it.each(["batch", "ordinary"] as const)(
  "keeps %s cancellation delivery with its current owner",
  async (mode) => {
    const parentKey = `agent:main:cancel-notification-${mode}`;
    const childKey = `agent:main:subagent:cancel-notification-${mode}`;
    const siblingKey = `agent:main:subagent:cancel-sibling-${mode}`;
    const parentRunId = `parent-${mode}`;
    const childRunId = `cancel-${mode}`;
    for (const sessionKey of [parentKey, childKey, siblingKey]) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${sessionKey}-session`,
      });
    }
    const acceptedSessionSpawns = [
      { runId: childRunId, childSessionKey: childKey, expectsCompletionMessage: true },
      { runId: `sibling-${mode}`, childSessionKey: siblingKey, expectsCompletionMessage: true },
    ];
    for (const spawn of acceptedSessionSpawns) {
      registerSubagentRun({
        ...spawn,
        requesterSessionKey: parentKey,
        requesterAgentId: "main",
        requesterTurnRunId: parentRunId,
        requesterDisplayKey: parentKey,
        task: "Read an independently held result",
        cleanup: "keep",
      });
    }
    if (mode === "batch") {
      expect(
        markRequesterTurnYielded({
          requesterSessionKey: parentKey,
          requesterAgentId: "main",
          requesterTurnRunId: parentRunId,
        }),
      ).toBe(2);
      expect(
        settleRequesterAfterSessionSpawns({
          requesterSessionKey: parentKey,
          requesterAgentId: "main",
          requesterTurnRunId: parentRunId,
          requesterYielded: true,
          acceptedSessionSpawns,
        }),
      ).toBe(true);
    }
    const task = findTaskByRunId(childRunId)!;
    const result = await cancelTaskById({
      cfg: getRuntimeConfig(),
      taskId: task.taskId,
      reason: "Operator cancelled this retrieval",
    });
    expect(result).toMatchObject({ found: true, cancelled: true });
    // Cancellation owns a detached notification; join it before checking claim release.
    await fixture.settle();
    expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
    // Redrive the public delivery path as well as the immediate cancellation notification.
    await maybeDeliverTaskTerminalUpdate(task.taskId);
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "cancelled",
      error: "Operator cancelled this retrieval",
      deliveryStatus: mode === "batch" ? "pending" : "session_queued",
    });
    expect(peekSystemEvents(parentKey)).toHaveLength(mode === "batch" ? 0 : 1);
    if (mode === "batch") {
      expect(subagentRuns.get(childRunId)?.requesterSettleWake).toBeDefined();
      expect(subagentRuns.get(`sibling-${mode}`)?.execution.endedAt).toBeUndefined();
    }
  },
);
