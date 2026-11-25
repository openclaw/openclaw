/** Accepted cancellation retains exact turn, actor, and late-runtime custody. */
import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";
import {
  cancelledEvent,
  createAcceptedFixture as fixture,
  gate,
} from "./manager.ownership.test-support.js";
import {
  baseCfg,
  disposeAcpSessionManagerInstance,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
} from "./manager.test-helpers.js";

const cancelFailure = { message: "cancel transport failure" };
const rejectedCancellation = [{ status: "rejected", reason: cancelFailure }];
const rejectedStop = [
  {
    status: "rejected",
    reason: { message: "Session source cleanup failed", errors: [cancelFailure] },
  },
];

describe("ACP accepted cancellation ownership", () => {
  installAcpSessionManagerTestLifecycle();

  it("cancels only the accepted snapshot and records queued cancellation signals before releasing the actor", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = fixture({ parented: true });
      const actorGate = gate();
      state.getStatus.mockImplementationOnce(async () => {
        await actorGate.wait();
        return { summary: "ready" };
      });
      const actor = state.manager.getSessionStatus(state.target);
      await actorGate.entered;
      const snapshot = [0, 1].map((index) =>
        state.startTurn(`snapshot-${index}`, {
          text: "cancelled",
          admittedRunContext: createTestAdmittedRunContext(`snapshot-${index}`),
        }),
      );
      const cancelled = snapshot.map(({ turn }) => turn);
      const events = snapshot.map((accepted) => accepted.events);
      const cancellation = stopAcpControllerTurns(state.target);
      const { turn: later } = state.startTurn("later", { text: "survivor" });
      try {
        await Promise.all([...cancelled, cancellation]);
        expect(state.runTurn).not.toHaveBeenCalled();
        expect(events).toEqual([[cancelledEvent], [cancelledEvent]]);
        expect(
          (await state.recordedEvents())
            .map(({ kind, runId, payload }) => ({ kind, runId, payload }))
            .toSorted((left, right) => String(left.runId).localeCompare(String(right.runId))),
        ).toMatchObject([
          { kind: "run_failed", runId: "snapshot-0", payload: { outcome: "cancelled" } },
          { kind: "run_failed", runId: "snapshot-1", payload: { outcome: "cancelled" } },
        ]);
      } finally {
        actorGate.release();
        await Promise.allSettled([actor, ...cancelled, cancellation, later]);
      }
      expect(state.runTurn).toHaveBeenCalledOnce();
      expect(state.runTurn.mock.calls[0]?.[0].text).toBe("survivor");
    });
  });

  it("cancels a queued exact instance without terminalizing its same-id predecessor", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = fixture({ parented: true });
      const turnGate = gate();
      let activeSignal: AbortSignal | undefined;
      state.runTurn.mockImplementationOnce(async function* (input) {
        activeSignal = input.signal;
        await turnGate.wait();
        yield { type: "done", stopReason: "end_turn" };
      });
      const { turn: first } = state.startTurn("same-id", { text: "predecessor" });
      await turnGate.entered;
      const cancellation = new AbortController();
      const { turn: queued, events } = state.startTurn("same-id", {
        text: "successor",
        admittedRunContext: createTestAdmittedRunContext("same-id"),
        signal: cancellation.signal,
      });
      try {
        cancellation.abort();
        await queued;
        expect(events).toEqual([cancelledEvent]);
        expect(extractStatesFromUpserts().at(-1)).toBe("running");
        expect(activeSignal?.aborted).toBe(false);
        expect(state.cancel).not.toHaveBeenCalled();
        expect(await state.recordedEvents()).toEqual([]);
      } finally {
        turnGate.release();
        await Promise.allSettled([first, queued]);
      }
      expect(state.runTurn).toHaveBeenCalledOnce();
      expect(await state.recordedEvents()).toMatchObject([
        { kind: "run_completed", runId: "same-id" },
      ]);
    });
  });

  it("keeps a different agent's identical logical session outside cancellation", async () => {
    const state = fixture({ sessionKey: "shared-session" });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: { ...state.runtime, ownerAwareSessions: 1 },
    });
    const cfg = {
      ...baseCfg,
      agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } },
    };
    const actorGate = gate();
    state.getStatus.mockImplementationOnce(async () => {
      await actorGate.wait();
      return { summary: "ready" };
    });
    const alpha = { cfg, sessionKey: "shared-session", agentId: "alpha" };
    const beta = { cfg, sessionKey: "shared-session", agentId: "beta" };
    const actor = state.manager.getSessionStatus(alpha);
    await awaitGateBeforeSettlement(actorGate.entered, actor, "status ended before partition gate");
    const { turn: cancelled } = state.startTurn("alpha", {
      ...alpha,
      admittedRunContext: createTestAdmittedRunContext("alpha"),
    });
    const { turn: live } = state.startTurn("beta", beta);
    try {
      await Promise.all([cancelled, stopAcpControllerTurns(alpha), live]);
    } finally {
      actorGate.release();
      await Promise.allSettled([actor, cancelled, live]);
    }
    expect(state.runTurn).toHaveBeenCalledOnce();
    expect(state.runTurn.mock.calls[0]?.[0].text).toBe("beta");
  });

  it("settles cancellation after disposal before actor admission without setup", async () => {
    const state = fixture();
    await disposeAcpSessionManagerInstance(state.manager, "shutdown");
    const { turn, events } = state.startTurn("disposed");
    await turn;
    expect(state.ensureSession).not.toHaveBeenCalled();
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(events).toEqual([cancelledEvent]);
  });

  it("preserves late runtime cancellation failure instead of claiming a cancelled terminal", async () => {
    const state = fixture();
    const setupGate = gate();
    state.ensureSession.mockImplementationOnce(async () => {
      await setupGate.wait();
      return {
        sessionKey: state.target.sessionKey,
        backend: "acpx",
        runtimeSessionName: "late-failed",
      };
    });
    state.cancel.mockRejectedValue(new Error("cancel transport failure"));
    const { turn, events } = state.startTurn("failed");
    const turnResult = Promise.allSettled([turn]);
    await setupGate.entered;
    const cancel = stopAcpControllerTurns(state.target);
    const cancelResult = Promise.allSettled([cancel]);
    setupGate.release();
    expect(await turnResult).toMatchObject(rejectedCancellation);
    expect(await cancelResult).toMatchObject(rejectedStop);
    expect(events).toEqual([]);
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it("keeps failed backend cancellation attached to Stop until the producer settles", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = fixture({ parented: true });
      const turnGate = gate();
      const cancelEntered = createDeferred();
      state.runTurn.mockImplementationOnce(async function* () {
        await turnGate.wait();
        yield { type: "done", status: "cancelled" };
      });
      state.cancel.mockImplementationOnce(async () => {
        cancelEntered.resolve();
        throw new Error("cancel transport failure");
      });
      const { turn } = state.startTurn("active-cancel-failed");
      const turnResult = Promise.allSettled([turn]);
      await turnGate.entered;
      let stopSettled = false;
      const stopResult = Promise.allSettled([stopAcpControllerTurns(state.target)]).then(
        (result) => {
          stopSettled = true;
          return result;
        },
      );
      try {
        await cancelEntered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopSettled).toBe(false);
        turnGate.release();
        expect(await turnResult).toMatchObject(rejectedCancellation);
        expect(await stopResult).toMatchObject(rejectedStop);
        expect(state.cancel).toHaveBeenCalledOnce();
      } finally {
        turnGate.release();
        await Promise.all([turnResult, stopResult]);
      }
    });
  });
});
