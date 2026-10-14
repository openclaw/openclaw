import { expect, it } from "vitest";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  withQueuedRegistrationFixture,
  type QueuedRegistrationFixture,
} from "./subagent-registry-queued-registration.test-support.js";

async function prepareCancelled(f: QueuedRegistrationFixture) {
  await f.register();
  await f.change((draft) => {
    draft.execution = {
      ...draft.execution,
      status: "terminal",
      endedAt: 123,
      outcome: { status: "error", error: "manual kill", endedAt: 123 },
    };
    draft.endedReason = SUBAGENT_ENDED_REASON_KILLED;
    draft.killReconciliation = { killedAt: 123, taskCancellationAccepted: true };
    draft.swarmLaunchPending = true;
    draft.structuredOutput = { invalidAttempts: 0, structured: { answer: 42 } };
  });
}

export function registerQueuedCancelledLaunchCases() {
  it("retains cancelled launch output across a known refusal and publishes it exactly once", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await prepareCancelled(f);
      const captured = f.current();
      const refusal = f.holdNextWrite("before");
      const failed = f.track(f.scope.settleFailedLaunch("accepted launch was cancelled"));
      await refusal.entered;
      refusal.reject(new Error("write refused"));
      await expect(failed).rejects.toThrow("write refused");
      expect(f.current()).toEqual(captured);
      expect(f.scope.canCleanupSession()).toBe(false);
      await f.scope.settleFailedLaunch("later failure text");
      expect(f.current()).toMatchObject({
        execution: captured.execution,
        killReconciliation: captured.killReconciliation,
        completion: { resultText: "manual kill", capturedAt: 123 },
        collectorCompletion: { status: "killed", structured: { answer: 42 } },
        queuedLaunch: undefined,
      });
      expect(f.scope.canCleanupSession()).toBe(true);
      const writes = f.writes;
      await f.scope.settleFailedLaunch("duplicate callback");
      expect(f.writes).toBe(writes);
    });
  });

  it("retains unknown cancelled-launch settlement without replay", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await prepareCancelled(f);
      const captured = f.current();
      const ack = f.holdNextWrite();
      const failed = f.track(f.scope.settleFailedLaunch("accepted launch was cancelled"));
      await ack.entered;
      ack.loseReceipt(new SqliteWorkerError("publication lost", "outcome-unknown"));
      const error = await failed.catch((failure: unknown) => failure);
      expect(error).toMatchObject({ outcome: "unknown" });
      await expect(f.scope.settleFailedLaunch("retry")).rejects.toBe(error);
      expect(f.current()).toEqual(captured);
      expect(f.stored()?.collectorCompletion).toMatchObject({
        status: "killed",
        structured: { answer: 42 },
      });
      expect(f.scope.canCleanupSession()).toBe(false);
    });
  });

  it.each(["replacement", "newer sibling"] as const)(
    "refuses cancelled launch settlement after %s takes session ownership",
    async (change) => {
      await withQueuedRegistrationFixture(async (f) => {
        await prepareCancelled(f);
        const original = f.current();
        const successor = {
          ...structuredClone(original),
          runId: change === "replacement" ? original.runId : "newer-run",
          generation: (original.generation ?? 0) + 1,
        };
        await mutateSubagentRuns(
          [successor.runId],
          () => ({ value: undefined, postimages: new Map([[successor.runId, successor]]) }),
          { runs: f.runs },
        );
        const writes = f.writes;
        await f.scope.settleFailedLaunch("late callback");
        expect(f.writes).toBe(writes);
        expect(f.runs.get(successor.runId)).toEqual(successor);
        expect(f.scope.canCleanupSession()).toBe(false);
      });
    },
  );
}
