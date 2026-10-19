import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
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
    const entered = createDeferred();
    const release = createDeferred();
    f.ensureSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "retained-runtime",
      };
    });
    const cancellation = withOpenClawStateDatabaseReadSnapshot(
      () => f.manager.cancelSession(f.target),
      { env: f.state.env },
    );
    const result = Promise.allSettled([cancellation]);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        result,
        "Cancellation ended before runtime preparation.",
      );
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
      release.resolve();
      await result;
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    } finally {
      release.resolve();
      await result;
    }
  });
});

it("joins a failing accepted sibling while another terminal signal remains active", async () => {
  await withAcpCancellationFixture(async (f) => {
    const actorEntered = createDeferred();
    const releaseActor = createDeferred();
    f.getStatus.mockImplementationOnce(async () => {
      actorEntered.resolve();
      await releaseActor.promise;
      return { summary: "ready" };
    });
    const actor = f.manager.getSessionStatus(f.target);
    const actorResult = Promise.allSettled([actor]);
    await actorEntered.promise;
    const secondEntered = createDeferred();
    const releaseSecond = createDeferred();
    const original = terminalSignals.recordSubagentTerminalState;
    const intercepted = vi
      .spyOn(terminalSignals, "recordSubagentTerminalState")
      .mockImplementation(async (...args) => {
        if (args[0].runId === "sibling-second") {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return original(...args);
      });
    const turns = ["sibling-first", "sibling-second"].map((requestId) =>
      f.manager.runTurn({
        ...f.target,
        admittedRunContext: createTestAdmittedRunContext(requestId),
        provenance: "system",
        mode: "prompt",
        text: "queued",
        requestId,
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
    const cancellation = stopAcpControllerTurns({
      ...f.target,
    });
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    try {
      await awaitGateBeforeSettlement(
        secondEntered.promise,
        turnResults,
        "Sibling signal was never admitted.",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      releaseSecond.resolve();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(await turnResults).toMatchObject([{ status: "rejected" }, { status: "fulfilled" }]);
      sql.restore();
      expect(sql.queries).toEqual([]);
      expect(readDurableAcpSignals(f, "sibling-second")).toMatchObject([{ kind: "run_failed" }]);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      releaseSecond.resolve();
      releaseActor.resolve();
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
      const entered = createDeferred();
      const release = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return {
          sessionKey: f.target.sessionKey,
          backend: "cancellation-proof",
          runtimeSessionName: "late-runtime",
        };
      });
      const cancellation = f.manager.cancelSession({
        ...f.target,
      });
      const result = Promise.allSettled([cancellation]);
      await awaitGateBeforeSettlement(entered.promise, result, "Cancellation ended before setup.");
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
        release.resolve();
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
    const cancelEntered = createDeferred();
    const releaseCancel = createDeferred();
    f.runTurn.mockImplementationOnce(async function* (input) {
      turnEntered.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", stopReason: "cancel" };
    });
    const context = createTestAdmittedRunContext("reentrant-cancel");
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      mode: "prompt",
      text: "running",
      requestId: "reentrant-cancel",
    });
    const turnResult = Promise.allSettled([turn]);
    await turnEntered.promise;
    const request = {
      ...f.target,
    };
    let nested: Promise<void> | undefined;
    let nestedSettled = false;
    let outerSettled = false;
    f.cancel.mockImplementationOnce(async () => {
      // Launch the reentry without making the backend wait on its own cancellation.
      nested = stopAcpControllerTurns({ ...request, reason: "nested" }).then(() => {
        nestedSettled = true;
      });
      void nested.catch(() => {});
      cancelEntered.resolve();
      await releaseCancel.promise;
    });
    const outer = stopAcpControllerTurns({ ...request, reason: "outer" }).then(() => {
      outerSettled = true;
    });
    const outerResult = Promise.allSettled([outer]);
    try {
      await cancelEntered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(nestedSettled).toBe(false);
      expect(outerSettled).toBe(false);
      releaseCancel.resolve();
      expect(await Promise.allSettled([outer, nested, turn])).toMatchObject([
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "fulfilled" },
      ]);
      expect(readDurableAcpSignals(f, "reentrant-cancel")).toMatchObject([{ kind: "run_failed" }]);
    } finally {
      releaseCancel.resolve();
      await Promise.allSettled([outerResult, nested, turnResult]);
    }
  });
});

it.each(["acknowledged", "failed"] as const)(
  "retains %s late-handle cleanup after caller revocation without host data SQL",
  async (outcome) => {
    await withAcpCancellationFixture(async (f) => {
      const ensureEntered = createDeferred();
      const ensureRelease = createDeferred();
      const cancelEntered = createDeferred();
      const cancelRelease = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        ensureEntered.resolve();
        await ensureRelease.promise;
        return {
          sessionKey: f.target.sessionKey,
          backend: "cancellation-proof",
          runtimeSessionName: "late-runtime",
        };
      });
      f.cancel.mockImplementationOnce(async () => {
        cancelEntered.resolve();
        await cancelRelease.promise;
        if (outcome === "failed") {
          throw new Error("Late cancellation failed.");
        }
      });
      const context = createTestAdmittedRunContext("late-worker");
      const events: unknown[] = [];
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        mode: "prompt",
        text: "late",
        requestId: "late-worker",
        onEvent: (event) => {
          events.push(event);
        },
      });
      const turnResult = Promise.allSettled([turn]);
      await awaitGateBeforeSettlement(
        ensureEntered.promise,
        turnResult,
        "Turn ended before setup gate.",
      );
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
        ensureRelease.resolve();
        await awaitGateBeforeSettlement(
          cancelEntered.promise,
          result,
          "Cancellation ended before runtime cleanup.",
        );
        expect(settled).toBe(false);
        expect(f.runTurn).not.toHaveBeenCalled();
        cancelRelease.resolve();
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
        ensureRelease.resolve();
        cancelRelease.resolve();
        await Promise.allSettled([result, turnResult]);
      }
    });
  },
);
