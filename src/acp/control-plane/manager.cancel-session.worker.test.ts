import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as terminalSignals from "../../sessions/subagent-terminal-state.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { applyAcpSessionMutation } from "../runtime/session-meta-write.kernel.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  withAcpCancellationFixture,
  readDurableAcpSignals,
} from "./manager.cancel-session.worker.test-support.js";
import {
  createGate,
  holdEnsure,
  startTurn,
  untilAborted,
} from "./manager.cancellation-locator.test-support.js";
import {
  startAcpControllerStop,
  stopAcpControllerTurns,
} from "./manager.controller-test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it("cancels a cold runtime with one resolution and one pre-ensure metadata read", async () => {
  await withAcpCancellationFixture(async (f) => {
    const read = vi.spyOn(DEFAULT_DEPS, "loadSessionEntryAsync");
    try {
      await f.manager.cancelSession({ ...f.target, expectedOwnerKey: "agent:main:main" });
      expect(f.ensureSession).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
      expect(readAcpSessionEntry(f.target)?.acp?.state).toBe("idle");
    } finally {
      read.mockRestore();
    }
  });
});

it("refuses inline-only idle ACP metadata without host data SQL", async () => {
  await withAcpCancellationFixture(
    async (f) => {
      const sql = observeHostDataSql();
      try {
        await expect(
          f.manager.cancelSession({ ...f.target, expectedOwnerKey: "agent:main:main" }),
        ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
        sql.restore();
        expect(f.ensureSession).not.toHaveBeenCalled();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(readAcpSessionEntry(f.target)?.entry?.acp?.state).toBe("running");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    },
    { metadata: "inline" },
  );
});

it("does not admit durable runtime cancellation from an inherited discovery snapshot", async () => {
  await withAcpCancellationFixture(async (f) => {
    const ensureGate = createGate("Cancellation ended before runtime preparation.");
    holdEnsure(f, ensureGate, "retained-runtime");
    const cancellation = withOpenClawStateDatabaseReadSnapshot(
      () => f.manager.cancelSession(f.target),
      { env: f.state.env },
    );
    const result = Promise.allSettled([cancellation]);
    try {
      await ensureGate.reached(result);
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          applyAcpSessionMutation(db, {
            agentId: "main",
            sessionKey: f.target.sessionKey,
            storageSessionKey: f.target.sessionKey,
            entry: {
              sessionId: "cancellation-session",
              lifecycleRevision: "cancellation-lifecycle",
              updatedAt: 100,
            },
            decision: { kind: "clear" },
          }),
        { env: f.state.env },
      );
      ensureGate.open();
      await result;
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    } finally {
      ensureGate.open();
      await result;
    }
  });
});

it("joins a failing accepted sibling while another terminal signal remains active", async () => {
  await withAcpCancellationFixture(async (f) => {
    const actorGate = createGate();
    f.getStatus.mockImplementationOnce(async () => {
      await actorGate.wait();
      return { summary: "ready" };
    });
    const actor = f.manager.getSessionStatus(f.target);
    const actorResult = Promise.allSettled([actor]);
    await actorGate.reached(actorResult);
    const secondGate = createGate("Sibling signal was never admitted.");
    const original = terminalSignals.recordSubagentTerminalState;
    const intercepted = vi
      .spyOn(terminalSignals, "recordSubagentTerminalState")
      .mockImplementation(async (...args) => {
        if (args[0].runId === "sibling-second") {
          await secondGate.wait();
        }
        return original(...args);
      });
    const turns = ["sibling-first", "sibling-second"].map((requestId) =>
      startTurn(f, requestId, {
        text: "queued",
        onEvent:
          requestId === "sibling-first"
            ? async () => {
                throw new Error("First cancellation delivery failed.");
              }
            : undefined,
      }),
    );
    const turnResults = Promise.allSettled(turns);
    let settled = false;
    const sql = observeHostDataSql();
    const cancellation = stopAcpControllerTurns(f.target);
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    try {
      await secondGate.reached(turnResults);
      await nextTurn();
      expect(settled).toBe(false);
      secondGate.open();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(await turnResults).toMatchObject([{ status: "rejected" }, { status: "fulfilled" }]);
      sql.restore();
      expect(sql.queries).toEqual([]);
      expect(readDurableAcpSignals(f, "sibling-second")).toMatchObject([{ kind: "run_failed" }]);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      secondGate.open();
      actorGate.open();
      intercepted.mockRestore();
      await Promise.allSettled([result, turnResults, actorResult]);
    }
  });
});

it.each(["metadata", "lifecycle"] as const)(
  "refuses late idle runtime effects after %s replacement",
  async (replacement) => {
    await withAcpCancellationFixture(async (f) => {
      const close = vi.spyOn(f.runtime, "close");
      const ensureGate = createGate("Cancellation ended before setup.");
      holdEnsure(f, ensureGate, "late-runtime");
      const cancellation = f.manager.cancelSession(f.target);
      const result = Promise.allSettled([cancellation]);
      await ensureGate.reached(result);
      try {
        if (replacement === "metadata") {
          await upsertAcpSessionMeta({ ...f.target, skipMaintenance: true, mutate: () => null });
        } else {
          await replaceSessionEntry(f.target, {
            sessionId: "cancellation-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 200,
            spawnedBy: "agent:main:main",
          });
        }
      } finally {
        ensureGate.open();
      }
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    });
  },
);

it("joins reentrant cancellation without issuing a second backend effect", async () => {
  await withAcpCancellationFixture(async (f) => {
    const turnEntered = createDeferred();
    const cancelGate = createGate();
    f.runTurn.mockImplementationOnce(async function* (input) {
      turnEntered.resolve();
      await untilAborted(input.signal);
      yield { type: "done", stopReason: "cancel" };
    });
    const turn = startTurn(f, "reentrant-cancel", { text: "running" });
    const turnResult = Promise.allSettled([turn]);
    await turnEntered.promise;
    let nested: Promise<void> | undefined;
    let nestedSettled = false;
    let outerSettled = false;
    f.cancel.mockImplementationOnce(async () => {
      // Launch the reentry without making the backend wait on its own cancellation.
      nested = stopAcpControllerTurns({ ...f.target, reason: "nested" }).then(() => {
        nestedSettled = true;
      });
      void nested.catch(() => {});
      await cancelGate.wait();
    });
    const outer = stopAcpControllerTurns({ ...f.target, reason: "outer" }).then(() => {
      outerSettled = true;
    });
    const outerResult = Promise.allSettled([outer]);
    try {
      await cancelGate.reached(outerResult);
      await nextTurn();
      expect(f.cancel).toHaveBeenCalledOnce();
      expect([nestedSettled, outerSettled]).toEqual([false, false]);
      cancelGate.open();
      expect(await Promise.allSettled([outer, nested, turn])).toMatchObject([
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "fulfilled" },
      ]);
      expect(readDurableAcpSignals(f, "reentrant-cancel")).toMatchObject([{ kind: "run_failed" }]);
    } finally {
      cancelGate.open();
      await Promise.allSettled([outerResult, nested, turnResult]);
    }
  });
});

it.each(["acknowledged", "failed"] as const)(
  "retains %s late-handle cleanup after caller revocation without host data SQL",
  async (outcome) => {
    await withAcpCancellationFixture(async (f) => {
      const ensureGate = createGate("Turn ended before setup gate.");
      const cancelGate = createGate("Cancellation ended before runtime cleanup.");
      holdEnsure(f, ensureGate, "late-runtime");
      f.cancel.mockImplementationOnce(async () => {
        await cancelGate.wait();
        if (outcome === "failed") {
          throw new Error("Late cancellation failed.");
        }
      });
      const events: unknown[] = [];
      const turn = startTurn(f, "late-worker", {
        text: "late",
        onEvent: (event) => {
          events.push(event);
        },
      });
      const turnResult = Promise.allSettled([turn]);
      await ensureGate.reached(turnResult);
      let callerCurrent = true;
      let settled = false;
      const sql = observeHostDataSql();
      const stop = startAcpControllerStop({
        ...f.target,
        assertActive: () => {
          if (!callerCurrent) {
            throw new Error("Caller was revoked.");
          }
        },
      });
      const cancellation = stop.settled;
      const result = Promise.allSettled([cancellation, turn]).then((value) => {
        settled = true;
        return value;
      });
      try {
        await awaitGateBeforeSettlement(
          stop.completed,
          result,
          "Cancellation ended before admission.",
        );
        callerCurrent = false;
        ensureGate.open();
        await cancelGate.reached(result);
        expect(settled).toBe(false);
        expect(f.runTurn).not.toHaveBeenCalled();
        cancelGate.open();
        expect(await result).toMatchObject(
          outcome === "failed"
            ? [
                {
                  status: "rejected",
                  reason: {
                    message: "Session source cleanup failed",
                    errors: [{ message: "Late cancellation failed." }],
                  },
                },
                { status: "rejected", reason: { message: "Late cancellation failed." } },
              ]
            : [{ status: "fulfilled" }, { status: "fulfilled" }],
        );
        sql.restore();
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(readDurableAcpSignals(f, "late-worker")).toMatchObject([{ kind: "run_failed" }]);
        expect(events).toEqual(
          outcome === "failed" ? [] : [{ type: "done", status: "cancelled", stopReason: "cancel" }],
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        ensureGate.open();
        cancelGate.open();
        await Promise.allSettled([result, turnResult]);
      }
    });
  },
);
