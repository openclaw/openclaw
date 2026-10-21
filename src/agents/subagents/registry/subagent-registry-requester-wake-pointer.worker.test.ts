import { expect, it, vi } from "vitest";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";

it("publishes a selected requester wake before an overlapping row mutation plans", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const entry = createSubagentRunRecord({
      runId: "selected-wake",
      childSessionKey: "agent:main:subagent:selected-wake",
      requesterSessionKey: "agent:main:requester",
      endedAt: 2,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "Retained result" },
      delivery: { status: "pending" },
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    const context = captureOpenClawStateWorkerContext();
    await mutateSubagentRuns(
      [entry.runId],
      () => ({ value: undefined, postimages: new Map([[entry.runId, entry]]) }),
      { context },
    );
    const selected = await withSubagentRunReadSnapshot(
      subagentRuns,
      (snapshot) => ({ runIds: [...snapshot.keys()], sessionKeys: [] }),
      (_selection, runs) => runs.get(entry.runId),
      { runIds: new Set([entry.runId]) },
    );
    if (!selected) {
      throw new Error("Selected requester wake is unavailable");
    }
    const wakeReached = createDeferredCore();
    const releaseWake = createDeferredCore();
    const ackReached = createDeferredCore();
    const releaseAck = createDeferredCore();
    const held = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "sessionDelivery.mutateSubagentCompletion") {
        wakeReached.resolve();
        await releaseWake.promise;
      }
      const receipt = await scope.execute(command, executeOptions);
      if (command.type === "subagents.persistChanges") {
        ackReached.resolve();
        await releaseAck.promise;
      }
      return receipt;
    });
    const wake = mutateRequesterCompletionBatch({
      entries: [selected],
      operation: {
        kind: "transition",
        state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
      },
      context,
      assertCurrent: () => {},
      onCommitted: () => {},
      onPublished: () => {},
    });
    const wakeResult = wake.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let successor: Promise<void> | undefined;
    const successorPlanned = vi.fn();
    try {
      await Promise.race([wakeReached.promise, wake]);
      successor = mutateSubagentRuns(
        [entry.runId],
        (rows) => {
          successorPlanned();
          const current = rows.get(entry.runId)!;
          expect(current.requesterSettleWake?.status).toBe("dispatching");
          const next = { ...structuredClone(current), cleanupHandled: true };
          return { value: undefined, postimages: new Map([[next.runId, next]]) };
        },
        { context },
      );
      expect(successorPlanned).not.toHaveBeenCalled();
      releaseWake.resolve();
      expect(await wakeResult).toEqual({ value: { applied: true, publication: "published" } });
      await Promise.race([ackReached.promise, successor]);
      expect(subagentRuns.get(entry.runId)?.requesterSettleWake?.status).toBe("dispatching");
      expect(selected.requesterSettleWake?.status).toBe("pending");
      releaseAck.resolve();
      await successor;
      expect(successorPlanned).toHaveBeenCalledOnce();
      expect(subagentRuns.get(entry.runId)?.cleanupHandled).toBe(true);
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.requesterSettleWake?.status).toBe(
        "dispatching",
      );
    } finally {
      releaseWake.resolve();
      releaseAck.resolve();
      await Promise.allSettled([wake, successor]);
      held.mockRestore();
      subagentRuns.delete(entry.runId);
    }
  });
});
