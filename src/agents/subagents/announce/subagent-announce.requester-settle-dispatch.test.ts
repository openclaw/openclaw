import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { SessionWorkStartChangedError } from "../../../config/sessions/work-start-error.js";
import { resolveGatewayAgentAbortStopReason } from "../../../gateway/agent-turn/agent-run-dispatch-outcome.js";
import type { AgentTurnStartRequest } from "../../../gateway/agent-turn/agent-turn-start-request.types.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { GatewayOperatorAccessUnavailableError } from "../../../infra/operator-authority-error.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { getCurrentSessionControllerClaim } from "../../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../../sessions/session-controller.mailbox.js";
import { markReplyOperationExecutionStarted } from "../../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { prepareEmbeddedAttemptTimeout } from "../../embedded-agent-runner/run/attempt-timeout-prepare.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import {
  createAgentRunDirectAbortError,
  resolveAgentRunAbortLifecycleFields,
} from "../../run-termination.js";
import { toSandboxProvisioningError } from "../../sandbox/provisioning-error.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { SessionFollowupCompletion } from "../completion/session-followup-completion.js";
import { consumeSubagentPauseNotice } from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { retainedOperatorFixture } from "../registry/subagent-registry.completed-followup-authority.test-support.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  registerRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import {
  deliver,
  registryRead,
  readDescendantFacts,
  startTurn,
  REQUESTER_KEY,
  REQUESTER_TARGET,
  REQUESTER_TURN,
  settledChild,
  wakeParams,
  requesterSnapshot,
  useDirectDelivery,
  withGateway,
  useRequesterSettleDispatchFixture,
  finishProcessedCompletion,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

afterEach(() => clearRuntimeConfigSnapshot());

type Wake = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];
function dispatchFixture(child = settledChild()) {
  registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
  const completeBatch = vi.fn<Wake["completeBatch"]>(() => {
    child.requesterSettleWake = undefined;
  });
  return { child, completeBatch, params: wakeParams(child, completeBatch) };
}

// The lifecycle owner records the transcript commit on the batch, as in production.
const recordConsumption: Wake["recordRequesterDelivery"] = async (batch, fact) => {
  for (const entry of batch) {
    entry.delivery = { status: "pending", ...entry.delivery, requesterDelivery: fact };
  }
};

type Turn = Pick<AgentTurnStartRequest, "preflight" | "io" | "controllerInput">;
function acceptTurn({ preflight, io }: Turn, cached?: true) {
  const runId = preflight.request.idempotencyKey;
  io.emitAcceptance([true, { runId, status: "accepted" }, undefined], {
    runId,
    ...(cached ? { cached } : {}),
  });
}
function finishTurn(io: Turn["io"], text: string | undefined) {
  io.emitFinal([true, { status: "ok", result: { payloads: [{ text }] } }, undefined]);
}
function registerRequesterTurn({ preflight, controllerInput }: Turn, timeoutMs: number) {
  return registerChatAbortController({
    target: REQUESTER_TARGET,
    runId: preflight.request.idempotencyKey,
    sessionId: "requester-session",
    sessionKey: preflight.request.sessionKey,
    timeoutMs,
    kind: "agent",
    sourceInput: controllerInput,
  });
}

describe("requester settle dispatch deadline", () => {
  useRequesterSettleDispatchFixture();

  beforeEach(() => setRuntimeConfigSnapshot({}));

  it.each([false, true])(
    "delivers overlapping completions under their own invocations (frozen=%s)",
    (frozen) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = createContext();
        const source = await retainedOperatorFixture("settle-owner", context);
        const children = ["first", "second"].map((name) => {
          const child = settledChild();
          child.runId = name;
          child.childSessionKey = `agent:main:subagent:${name}`;
          child.completion!.resultText = `${name} result`;
          child.completion!.terminalReply = { disposition: "visible", text: `${name} result` };
          child.delivery = { status: "pending" };
          if (frozen) {
            child.requesterSettleWake!.batchRunIds = ["first", "second"];
          }
          subagentRuns.set(child.runId, child);
          return child;
        });
        const invocations = [{}, {}];
        try {
          for (const [index, child] of children.entries()) {
            const client = {
              ...source.client,
              internal: {
                operatorRunAuthority: createAdmittedRunOperatorAuthority({
                  ...source.source.authority,
                  invocation: invocations[index]!,
                }),
              },
            };
            const custody = await withPluginRuntimeGatewayRequestScope(
              { ...source, client, isWebchatConnect: () => false },
              () => captureOperatorToolGatewayContinuationContext(),
            );
            if (!custody) {
              throw new Error("Missing completion custody");
            }
            subagentRuns.bindCompletionAuthority(child, custody);
          }
          registryRead.listSubagentRunsForRequester.mockReturnValue(children);
          useDirectDelivery();
          const received: string[] = [];
          startTurn.mockImplementation(async (turn) => {
            const index = received.length;
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                ?.invocation,
            ).toBe(invocations[index]);
            expect(turn.preflight.request.message).toContain(`${children[index]!.runId} result`);
            expect(turn.preflight.request.message).not.toContain(
              `${children[1 - index]!.runId} result`,
            );
            received.push(children[index]!.runId);
            acceptTurn(turn);
            finishTurn(turn.io, "Completion received.");
          });
          for (const child of children) {
            await expect(
              withGateway(context, () =>
                maybeWakeRequesterAfterAllChildrenSettled(
                  wakeParams(child, (batch, _generation, delivery) => {
                    expect(delivery?.delivered).toBe(true);
                    for (const entry of batch) {
                      entry.requesterSettleWake = undefined;
                    }
                  }),
                ),
              ),
            ).resolves.toBe(true);
          }
          expect(received).toEqual(["first", "second"]);
        } finally {
          for (const child of children) {
            subagentRuns.releaseCompletionAuthority(child);
            subagentRuns.delete(child.runId);
          }
          source.source.release();
        }
      }),
  );

  it.each([
    { persistent: false, returned: false },
    { persistent: true, returned: false },
    { persistent: false, returned: true },
    { persistent: true, returned: true },
    { persistent: false, returned: true, aborted: true },
    { persistent: true, returned: false, aborted: true },
    { persistent: false, returned: false, failure: "preparation" },
    { persistent: true, returned: false, failure: "preparation" },
    { persistent: false, returned: false, failure: "worker" },
    { persistent: true, returned: false, failure: "worker" },
    { persistent: false, returned: true, failure: "timeout" },
    { persistent: true, returned: true, failure: "timeout" },
    { persistent: false, returned: false, failure: "sandbox" },
    { persistent: false, returned: false, failure: "unavailable" },
  ])(
    "keeps interrupted settlement owed with no attempt limit ($persistent, returned=$returned, aborted=$aborted, failure=$failure)",
    async ({ persistent, returned, aborted, failure }) => {
      const failingAttempts = persistent ? 4 : 1;
      const context = createContext();
      const { child, completeBatch, params } = dispatchFixture();
      useDirectDelivery();
      const runIds: string[] = [];
      startTurn.mockImplementation(async (turn) => {
        acceptTurn(turn);
        runIds.push(turn.preflight.request.idempotencyKey);
        if (runIds.length <= failingAttempts) {
          if (failure === "sandbox" || failure === "unavailable") {
            throw failure === "sandbox"
              ? toSandboxProvisioningError(new Error("Aborted"), "synthetic")
              : new GatewayClientRequestError({
                  code: "UNAVAILABLE",
                  message: "Aborted | sandbox_provisioning",
                });
          }
          if (failure === "timeout") {
            turn.io.emitFinal([
              true,
              { status: "timeout", stopReason: "timeout", replaySafe: true },
              undefined,
            ]);
            return;
          }
          if (failure === "preparation") {
            throw new SessionWorkStartChangedError(
              "Session target preparation outlived its attempt",
            );
          }
          if (failure === "worker") {
            throw new WorkerTaskError("worker task timed out", "timeout");
          }
          if (aborted) {
            const registration = registerRequesterTurn(turn, 60_000);
            try {
              await withSessionTurn(
                { ...REQUESTER_TURN, controllerInput: registration.entry?.input },
                async () => registration.controller.abort(createAgentRunDirectAbortError()),
              );
              turn.io.emitFinal([
                true,
                {
                  status: "timeout",
                  replaySafe: true,
                  ...(returned
                    ? {
                        result: {
                          payloads: [],
                          meta: resolveAgentRunAbortLifecycleFields(registration.controller.signal),
                        },
                      }
                    : {
                        stopReason: resolveGatewayAgentAbortStopReason(
                          registration.controller.signal,
                        ),
                      }),
                },
                undefined,
              ]);
            } finally {
              registration.cleanup();
            }
            return;
          }
          const error = {
            kind: "incomplete_turn",
            code: "item_conflict",
            message: "Saved conversation state rejected",
          };
          if (returned) {
            turn.io.emitFinal([
              true,
              { status: "ok", result: { payloads: [], meta: { error } } },
              undefined,
            ]);
            return;
          }
          throw Object.assign(new Error(error.message), error);
        }
        finishTurn(turn.io, "Recovered child result.");
      });
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
      await expect(run()).resolves.toBe(false);
      if (aborted || failure) {
        expect(await deliver.mock.results[0]?.value).toMatchObject({
          delivered: false,
          reason: aborted
            ? "requester_aborted"
            : failure === "sandbox" || failure === "unavailable"
              ? undefined
              : failure === "preparation"
                ? "requester_preparation_changed"
                : "requester_timed_out",
          disposition: "retryable",
        });
      }
      expect(completeBatch).not.toHaveBeenCalled();
      expect(child.requesterSettleWake?.nextAttemptAt).toBeTypeOf("number");
      // Each failed attempt leaves the result owed; the next wake runs it again.
      for (let attempt = 2; attempt <= failingAttempts; attempt++) {
        await expect(run()).resolves.toBe(false);
        expect(completeBatch).not.toHaveBeenCalled();
        expect(child.requesterSettleWake).toMatchObject({ status: "pending" });
      }
      await expect(run()).resolves.toBe(true);
      expect(runIds).toHaveLength(failingAttempts + 1);
      expect(new Set(runIds).size).toBe(runIds.length);
      expect(completeBatch).toHaveBeenCalledOnce();
      expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      await expect(run()).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledTimes(failingAttempts + 1);
    },
  );

  it.each([
    new WorkerTaskError("worker task timed out", "timeout"),
    new SessionWorkStartChangedError("Session target preparation outlived its attempt"),
  ])("does not repeat a committed turn that failed after execution ($name)", async (error) => {
    const context = createContext();
    const { child, completeBatch } = dispatchFixture();
    const params = wakeParams(child, completeBatch, { recordRequesterDelivery: recordConsumption });
    useDirectDelivery();
    startTurn.mockImplementation(async (turn) => {
      acceptTurn(turn);
      await turn.controllerInput?.onTranscriptCommitted?.(turn.preflight.request.idempotencyKey);
      turn.io.emitExecutionStarted?.();
      throw error;
    });
    const run = () => withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    // Consumption prevents replay; retained settlement owns the visible fallback.
    await expect(run()).resolves.toBe(true);
    expect(completeBatch).toHaveBeenCalledOnce();
    expect(completeBatch.mock.calls[0]?.[2]).toEqual(await deliver.mock.results[0]?.value);
    expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: false });
    expect(child.requesterSettleWake).toBeUndefined();
    await expect(run()).resolves.toBe(false);
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("keeps a result owed while cancellation refuses every dispatch", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    useDirectDelivery();
    deliver.mockImplementation((request) =>
      sendSubagentAnnounceDirectly({ ...request, signal: AbortSignal.abort() }),
    );
    const run = () => withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    using clock = vi.spyOn(Date, "now");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(run()).resolves.toBe(false);
      expect(startTurn).not.toHaveBeenCalled();
      expect(completeBatch).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: attempt });
      clock.mockReturnValue(child.requesterSettleWake!.nextAttemptAt!);
    }
  });

  it("keeps a followup completion owed while its policy is unavailable", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    let unavailable = false;
    const owner = SessionFollowupCompletion.bind({
      runId: "followup-before-yield",
      requesterSessionKey: "agent:main:original-requester",
      requesterSessionId: "original-requester",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: REQUESTER_KEY,
      custody: {
        signal: new AbortController().signal,
        release() {},
        assertCurrent() {
          if (unavailable) {
            throw new GatewayOperatorAccessUnavailableError();
          }
        },
        run: (run) => run(),
      },
    });
    onTestFinished(() => owner.close());
    child.requesterSettleWake!.rearmGeneration = 1;
    owner.promoteYield("followup-before-yield", [child], 1);
    owner.finishExecution("followup-before-yield");
    const run = () => withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    deliver.mockImplementationOnce(async () => {
      unavailable = true;
      return { delivered: false, path: "none", disposition: "retryable" };
    });
    await expect(run()).rejects.toThrow(GatewayOperatorAccessUnavailableError);
    expect(completeBatch).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(child.requesterSettleWake).toBeDefined();
    unavailable = false;
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    await expect(run()).resolves.toBe(true);
    expect(completeBatch).toHaveBeenCalledOnce();
  });

  it("does not reserve a foreground-blocking source for a wholly superseded yielded cohort", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    child.killReconciliation = { killedAt: 3_000, supersededAt: 4_000 };
    child.suppressCompletionDelivery = true;
    child.requesterSettleWake = {
      ...child.requesterSettleWake!,
      status: "dispatching",
      attemptCount: 1,
      batchRunIds: [child.runId],
    };
    useDirectDelivery();
    subagentRuns.set(child.runId, child);
    onTestFinished(() => {
      subagentRuns.delete(child.runId);
    });

    await expect(
      withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
    ).resolves.toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
    expect(completeBatch).toHaveBeenCalledWith([child], 1, undefined, expect.any(Function));
    const foreground = vi.fn(async () => "foreground completed");
    await expect(withSessionTurn(REQUESTER_TURN, foreground)).resolves.toBe("foreground completed");
    expect(foreground).toHaveBeenCalledOnce();
  });

  it.each(["superseded sibling", "current killed child"] as const)(
    "dispatches an owed yielded cohort with a %s",
    async (scenario) => {
      const context = createContext();
      const child = settledChild();
      child.delivery = { status: "pending" };
      const obsolete: SubagentRunRecord = {
        ...settledChild(),
        runId: "superseded-child",
        childSessionKey: "agent:main:subagent:superseded-child",
        completion: {
          ...settledChild().completion,
          required: true,
          resultText: "OBSOLETE-FINDING",
        },
        delivery: { status: "pending" },
        suppressCompletionDelivery: true,
        killReconciliation: { killedAt: 3_000, supersededAt: 4_000 },
      };
      const rows = scenario === "superseded sibling" ? [child, obsolete] : [child];
      if (scenario === "current killed child") {
        child.killReconciliation = { killedAt: 3_000 };
        child.suppressCompletionDelivery = true;
        child.endedReason = SUBAGENT_ENDED_REASON_KILLED;
        child.execution.outcome = { status: "error", error: "synthetic cancellation" };
      }
      for (const row of rows) {
        row.requesterSettleWake = {
          ...row.requesterSettleWake!,
          batchRunIds: rows.map((member) => member.runId).toSorted(),
        };
        subagentRuns.set(row.runId, row);
        onTestFinished(() => {
          subagentRuns.delete(row.runId);
        });
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue(rows);
      const completeBatch = vi.fn<Wake["completeBatch"]>(
        async (batch, _generation, _outcome, committed) => {
          for (const row of batch) {
            row.requesterSettleWake = undefined;
          }
          await committed?.();
        },
      );
      const params = wakeParams(child, completeBatch);
      const received: Array<{ message: string; runId: string }> = [];
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        acceptTurn({ controllerInput, preflight, io });
        await withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
          io.emitExecutionStarted?.();
          received.push({
            message: preflight.request.message,
            runId: preflight.request.idempotencyKey,
          });
        });
        finishProcessedCompletion(io);
      });
      useDirectDelivery();

      await expect(
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
      ).resolves.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]!.message).not.toContain("OBSOLETE-FINDING");
      expect(received[0]!.message).toContain(
        scenario === "superseded sibling" ? "child result" : "synthetic cancellation",
      );
      expect(received[0]!.runId).toBe(
        scenario === "superseded sibling"
          ? "announce:requester-settle:main:agent:main:main:settled-child,superseded-child:yield-1"
          : "announce:requester-settle:main:agent:main:main:settled-child:yield-1",
      );
      expect(completeBatch).toHaveBeenCalledWith(
        rows,
        1,
        expect.objectContaining({ delivered: true }),
        expect.any(Function),
      );
      await expect(
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
      ).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
      const foreground = vi.fn(async () => "foreground completed");
      await expect(withSessionTurn(REQUESTER_TURN, foreground)).resolves.toBe(
        "foreground completed",
      );
      expect(foreground).toHaveBeenCalledOnce();
    },
  );

  it("does not dispatch findings whose child becomes superseded after preparation", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    child.delivery = { status: "pending" };
    child.requesterSettleWake!.batchRunIds = [child.runId];
    const prepared = createDeferredCore();
    const release = createDeferredCore();
    readDescendantFacts
      .mockImplementationOnce(async () => ({ unsettled: false, active: 0 }))
      .mockImplementationOnce(async () => {
        // This second read follows the real completion-findings preparation.
        prepared.resolve();
        await release.promise;
        return { unsettled: false, active: 0 };
      });
    const transition = vi.fn(params.transitionBatch);
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      acceptTurn({ controllerInput, preflight, io });
      await withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
      });
      finishProcessedCompletion(io);
    });
    useDirectDelivery();
    const pending = withGateway(context, () =>
      maybeWakeRequesterAfterAllChildrenSettled({ ...params, transitionBatch: transition }),
    );
    try {
      await prepared.promise;
      // Keep the same row owner and terminal outcome: only latest-execution custody changes.
      child.killReconciliation = { killedAt: 3_000, supersededAt: 4_000 };
      release.resolve();
      await expect(pending).rejects.toThrow(
        "Requester completion source changed before continuation admission.",
      );
      expect(startTurn).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(completeBatch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it.each([
    { name: "all consumed, NO_REPLY", undelivered: false, silent: true },
    { name: "all consumed, empty reply", undelivered: false, silent: false },
    { name: "one undelivered, NO_REPLY", undelivered: true, silent: true },
  ])(
    "settles a yielded cohort according to its remaining results: $name",
    async ({ undelivered, silent }) => {
      vi.useFakeTimers();
      const context = createContext();
      const consumed = settledChild();
      const sibling = settledChild();
      sibling.runId = "sibling";
      sibling.childSessionKey = "agent:main:subagent:sibling";
      sibling.delivery = { status: undelivered ? "pending" : "delivered" };
      const children = [consumed, sibling];
      for (const child of children) {
        child.requesterSettleWake!.batchRunIds = children.map((entry) => entry.runId);
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue(children);
      const completeBatch = vi.fn<Wake["completeBatch"]>(() => {
        for (const child of children) {
          child.requesterSettleWake = undefined;
        }
      });
      useDirectDelivery();
      startTurn.mockImplementation(async ({ preflight, io }) => {
        acceptTurn({ preflight, io });
        io.emitFinal([
          true,
          {
            status: "ok",
            result: {
              payloads: [],
              meta: { terminalReply: { disposition: silent ? "silent" : "empty" } },
            },
          },
          undefined,
        ]);
      });
      const params = wakeParams(consumed, completeBatch);
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));

      await expect(run()).resolves.toBe(true);
      expect(startTurn).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
      expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(run()).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "wakes a nested yielded requester once (child completed before yield=%s)",
    async (afterRequesterYield) => {
      const requesterSessionKey = "agent:main:subagent:middle";
      const requester: SubagentRunRecord = {
        ...settledChild(),
        runId: "yielded-requester",
        childSessionKey: requesterSessionKey,
        pauseReason: "sessions_yield",
        runTimeoutSeconds: 0,
      };
      registryRead.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
        (sessionKey, matches) =>
          sessionKey === requesterSessionKey && (!matches || matches(requester))
            ? requester
            : undefined,
      );
      const child = settledChild();
      child.delivery = { status: "pending" };
      child.requesterSessionKey = requesterSessionKey;
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [child.runId],
        requesterYieldBatch: true,
        afterRequesterYield: afterRequesterYield ? true : undefined,
        rearmGeneration: 1,
      };
      const { completeBatch, params } = dispatchFixture(child);
      const append = vi.fn(() => true);
      const owner = {
        requesterAgentId: "main",
        requesterSessionKey,
        requesterSessionId: "requester-session",
        requesterTurnRunId: "yielded-requester",
      };
      const attachment = registerRequesterFinalAttachment({
        ...owner,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        timeoutMs: 60_000,
        append,
      });
      onTestFinished(() => attachment.revoke());
      expect(
        promoteRequesterFinalAttachment({
          ...owner,
          batchRunIds: [child.runId],
          rearmGeneration: 1,
        }),
      ).toBe(true);
      const delivered = {
        delivered: true,
        path: "direct",
        finalAssistantVisibleText: "consolidated final",
      } as const;
      deliver.mockResolvedValue(delivered);

      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRequesterSessionKey: requesterSessionKey,
          requesterIsSubagent: true,
          requireVisibleReply: true,
          sourceTool: "subagent_settle",
          triggerMessage: expect.stringContaining("child result"),
          directIdempotencyKey: `announce:requester-settle:main:${requesterSessionKey}:${child.runId}:yield-1`,
        }),
      );
      expect(completeBatch).toHaveBeenCalledWith([child], 1, delivered, expect.any(Function));
      expect(append).not.toHaveBeenCalled();
      const onCommitted = completeBatch.mock.calls[0]![3]!;
      await onCommitted();
      await onCommitted();
      expect(append).toHaveBeenCalledExactlyOnceWith(delivered.finalAssistantVisibleText);
      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(false);
      expect(deliver).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it("queues a pause notice behind the requester's current turn and delivers it once", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const child = settledChild();
    child.pauseReason = "sessions_yield";
    child.execution.outcome = undefined;
    child.completion = { required: true };
    child.delivery = { status: "pending" };
    child.requesterSettleWake!.pauseNotice = { acknowledgment: "PAUSE-MARKER-mid-turn" };
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    const accepted = createDeferredCore();
    const turnGate = createEnteredGate();
    const received: string[] = [];
    const currentTurn = withSessionTurn(REQUESTER_TURN, turnGate.wait);
    await turnGate.entered;
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      const request = preflight.request;
      acceptTurn({ controllerInput, preflight, io });
      const queued = withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
        received.push(request.message);
      });
      accepted.resolve();
      await queued;
      finishTurn(io, "Continuation needed.");
    });
    useDirectDelivery();
    const params = wakeParams(child, () => {
      consumeSubagentPauseNotice(child);
    });
    const wake = withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    try {
      await accepted.promise;
      expect(received).toEqual([]);
      const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
      expect({
        activeCount: Number(Boolean(mailbox?.claim)),
        queuedCount: mailbox?.entries.filter((entry) => entry.phase !== "claimed").length ?? 0,
      }).toEqual({ activeCount: 1, queuedCount: 1 });
      turnGate.release();
      await currentTurn;
      await expect(wake).resolves.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("PAUSE-MARKER-mid-turn");
      expect(received[0]).toContain('"state":"paused"');
      expect(child.pauseReason).toBe("sessions_yield");
      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
    } finally {
      turnGate.release();
      await currentTurn;
      await wake;
    }
  });

  it.each([
    ["removed", "managed worktree was removed: /synthetic/requester", true],
    ["removed session", "This session's worktree was removed by cleanup or deletion.", true],
    ["removing", "managed worktree removal is in progress: /synthetic/requester", false],
  ] as const)(
    "settles a worktree refusal only when permanent: %s",
    async (_state, message, permanent) => {
      const context = createContext();
      const { child, completeBatch, params } = dispatchFixture();
      useDirectDelivery();
      startTurn.mockRejectedValue(new GatewayClientRequestError({ code: "UNAVAILABLE", message }));
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));

      await expect(run()).resolves.toBe(false);
      expect(await deliver.mock.results[0]?.value).toMatchObject({
        error: message,
        disposition: permanent ? "permanent_failure" : "retryable",
      });
      if (permanent) {
        expect(completeBatch).toHaveBeenCalledOnce();
        expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({
          disposition: "permanent_failure",
        });
        expect(child.requesterSettleWake).toBeUndefined();
        await expect(run()).resolves.toBe(false);
        expect(startTurn).toHaveBeenCalledOnce();
      } else {
        expect(completeBatch).not.toHaveBeenCalled();
        expect(child.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 1 });
        expect(child.requesterSettleWake?.nextAttemptAt).toBeTypeOf("number");
        startTurn.mockImplementation(async (turn) => {
          acceptTurn(turn);
          finishTurn(turn.io, "Completion received.");
        });
        await expect(run()).resolves.toBe(true);
        expect(completeBatch).toHaveBeenCalledOnce();
        expect(startTurn).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each(["unavailable", "admitted", "accepted replay", "ambiguous"] as const)(
    "keeps a result no turn committed owed unless its refusal is permanent: %s",
    async (failure) => {
      const context = createContext();
      const createFacade = context.createAgentTurnFacade;
      const { child, completeBatch, params } = dispatchFixture();
      useDirectDelivery();
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        if (failure === "admitted") {
          const registration = registerRequesterTurn({ controllerInput, preflight, io }, 1_000);
          registration.cleanup();
        } else if (failure === "accepted replay") {
          acceptTurn({ controllerInput, preflight, io }, true);
        }
        throw Object.assign(
          new Error("requester dispatch unavailable"),
          failure === "ambiguous" ? { sentBeforeError: true } : {},
        );
      });
      if (failure === "unavailable") {
        context.createAgentTurnFacade = undefined;
      }
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
      await expect(run()).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledTimes(failure === "unavailable" ? 0 : 1);
      if (failure === "admitted" || failure === "accepted replay") {
        // A refusal after admission is permanent: withheld once, never dispatched again.
        expect(completeBatch).toHaveBeenCalledOnce();
        expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({
          disposition: "permanent_failure",
        });
        await expect(run()).resolves.toBe(false);
        expect(startTurn).toHaveBeenCalledOnce();
        return;
      }
      expect(completeBatch).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 1 });
      context.createAgentTurnFacade = createFacade;
      startTurn.mockImplementation(async ({ preflight, io }) => {
        io.emitAcceptance([true, { runId: preflight.request.idempotencyKey, status: "accepted" }]);
        finishTurn(io, "Continuation.");
      });
      await expect(run()).resolves.toBe(true);
      expect(startTurn).toHaveBeenCalledTimes(failure === "unavailable" ? 1 : 2);
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a replaced anchor after requester wake runtime loading", async () => {
    const retired = settledChild();
    const current = structuredClone(retired);
    registryRead.listSubagentRunsForRequester.mockReturnValue([current]);
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    const completeBatch = vi.fn();

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams(retired, completeBatch)),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(completeBatch).not.toHaveBeenCalled();
  });

  it.each(["final", "runtime timeout", "stop"] as const)(
    "keeps an executing completion under requester lifecycle ownership: %s",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const context = createContext();
      const child = settledChild();
      child.completionRequesterSessionId = "requester-session";
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const cfg = {
        agents: { defaults: { timeoutSeconds: 1, subagents: { announceTimeoutMs: 20 } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const preparationStarted = createDeferredCore();
      const finishPreparation = createDeferredCore();
      const executionStarted = createDeferredCore();
      const workDone = createDeferredCore();
      const stop = new AbortController();
      const timeoutMs = resolveAgentTimeoutMs({ cfg });
      const timedOut = vi.fn();
      const completeBatch = vi.fn();
      const finalReceipts: string[] = [];
      let acceptedSignal: AbortSignal | undefined;
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        const request = preflight.request as { idempotencyKey: string; sessionKey: string };
        const registration = registerRequesterTurn({ controllerInput, preflight, io }, timeoutMs);
        acceptedSignal = registration.controller.signal;
        try {
          if (!registration.registered) {
            throw new Error("expected requester RPC source");
          }
          io.emitStartOwner?.(request.idempotencyKey, registration.entry);
          preparationStarted.resolve();
          await finishPreparation.promise;
          acceptTurn({ controllerInput, preflight, io });
          await withSessionTurn(
            {
              ...REQUESTER_TURN,
              controllerInput: registration.entry.input,
              abortSignal: registration.controller.signal,
            },
            async (operation) => {
              if (!operation) {
                throw new Error("expected requester operation");
              }
              await controllerInput?.onTranscriptCommitted?.(request.idempotencyKey);
              markReplyOperationExecutionStarted(operation);
              operation.setPhase("running");
              io.emitExecutionStarted?.();
              const timeout = prepareEmbeddedAttemptTimeout({
                attempt: {
                  runId: request.idempotencyKey,
                  sessionId: "requester-session",
                  timeoutMs,
                },
                activeSession: { isCompacting: false, isStreaming: true },
                compactionState: { isCompacting: () => false },
                compactionTimeoutMs: 100,
                runAbortSignal: registration.controller.signal,
                isProbeSession: true,
                abortRun: () => registration.controller.abort(new Error("requester run timed out")),
                markTimedOutDuringCompaction: vi.fn(),
                markTimedOutByRunBudget: timedOut,
              });
              executionStarted.resolve();
              try {
                await waitForGatewayDispatch(
                  "synthetic requester work",
                  workDone.promise,
                  undefined,
                  registration.controller.signal,
                );
                finalReceipts.push("consolidated requester final");
              } finally {
                timeout.clearTimers();
              }
            },
          );
          finishTurn(io, finalReceipts[0]);
        } finally {
          const claim = registration.entry?.input.claim;
          registration.cleanup();
          await registration.entry?.input.settlement.promise;
          await claim?.settlement.promise;
        }
      });
      useDirectDelivery(requesterSnapshot(cfg));
      const wake = withGateway(context, () =>
        maybeWakeRequesterAfterAllChildrenSettled({
          ...wakeParams(child, completeBatch, { recordRequesterDelivery: recordConsumption }),
          signal: stop.signal,
        }),
      );
      let settled = false;
      void wake.then(() => {
        settled = true;
      });
      try {
        await preparationStarted.promise;
        await vi.advanceTimersByTimeAsync(21);
        expect(settled).toBe(false);
        expect(acceptedSignal?.aborted).toBe(false);
        finishPreparation.resolve();
        expect(
          await Promise.race([executionStarted.promise.then(() => true), wake.then(() => false)]),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(21);
        expect(acceptedSignal?.aborted).toBe(false);
        expect(finalReceipts).toEqual([]);
        expect(completeBatch).not.toHaveBeenCalled();
        if (outcome === "final") {
          workDone.resolve();
        } else if (outcome === "runtime timeout") {
          await vi.advanceTimersByTimeAsync(timeoutMs);
        } else {
          stop.abort(new Error("requester stopped"));
        }
        // The turn committed its input: it settles once, whatever the turn did next.
        await expect(wake).resolves.toBe(true);
        expect(startTurn).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(timedOut).toHaveBeenCalledTimes(outcome === "runtime timeout" ? 1 : 0);
        expect(finalReceipts).toEqual(outcome === "final" ? ["consolidated requester final"] : []);
        if (outcome === "final") {
          expect(completeBatch).toHaveBeenCalledWith(
            [child],
            1,
            expect.objectContaining({ delivered: true, requesterVisibleFinalDelivered: true }),
            expect.any(Function),
          );
        } else {
          expect(acceptedSignal?.aborted).toBe(true);
          expect(completeBatch).toHaveBeenCalledOnce();
          expect(completeBatch.mock.calls[0]?.[2]).toEqual(await deliver.mock.results[0]?.value);
          expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: false });
        }
        const later = vi.fn();
        let laterClaim: ReturnType<typeof getCurrentSessionControllerClaim>;
        await withSessionTurn(REQUESTER_TURN, async () => {
          laterClaim = getCurrentSessionControllerClaim();
          later();
        });
        await laterClaim?.settlement.promise;
        expect(later).toHaveBeenCalledOnce();
        const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
        expect(mailbox?.claim).toBeUndefined();
        expect(mailbox?.entries ?? []).toEqual([]);
        expect(rpcSourceTesting.size).toBe(0);
        expect(child.execution.outcome).toEqual({ status: "ok" });
        expect(child.completion?.resultText).toBe("child result");
      } finally {
        finishPreparation.resolve();
        workDone.resolve();
        stop.abort();
        await wake;
      }
    },
  );
});
