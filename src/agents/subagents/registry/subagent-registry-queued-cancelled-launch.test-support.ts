import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as structuredOutput from "../../tools/structured-output-tool.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { registerQueuedRegistrationClaimCases } from "./subagent-registry-queued-registration-claims.test-support.js";

export function registerQueuedCancelledLaunchCases(
  params: Parameters<typeof registerQueuedRegistrationClaimCases>[0],
) {
  const prepare = async () => {
    const f = params.fixture();
    const registration = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await registration;
    const entry = expectDefined(f.runs.get(f.registration.runId), "registered collector");
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: 123,
      outcome: { status: "error", error: "manual kill", endedAt: 123 },
    };
    entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
    entry.killReconciliation = { killedAt: 123, taskCancellationAccepted: true };
    entry.swarmLaunchPending = true;
    return { f, entry, killed: structuredClone(entry) };
  };

  it("retains cancelled launch metadata across a known refusal without finalizing the task", async () => {
    const { f, entry, killed } = await prepare();
    vi.spyOn(structuredOutput, "consumeSwarmStructuredOutput")
      .mockReturnValueOnce({ invalidAttempts: 0, structured: { answer: 42 } })
      .mockReturnValue(undefined);
    const refusal = new SubagentRegistryWriteError("not-committed", new Error("write refused"));
    try {
      const settlement = f.scope.settleFailedLaunch("accepted launch was cancelled");
      const rejected = expect(settlement).rejects.toBe(refusal);
      await vi.waitFor(() => expect(f.writes).toHaveLength(3));
      expect(entry).toEqual(killed);
      f.writes[2]!.assertCurrent();
      f.writes[2]!.gate.reject(refusal);
      await rejected;
      expect(f.scope.canCleanupSession()).toBe(false);

      const retry = f.scope.settleFailedLaunch("later failure text");
      await vi.waitFor(() => expect(f.writes).toHaveLength(4));
      expect(f.writes[3]!.snapshot.get(entry.runId)).toMatchObject({
        execution: killed.execution,
        killReconciliation: killed.killReconciliation,
        completion: { resultText: "manual kill", capturedAt: 123 },
        collectorCompletion: { status: "killed", structured: { answer: 42 } },
        swarmLaunchPending: false,
        queuedLaunch: undefined,
      });
      f.writes[3]!.assertCurrent();
      f.writes[3]!.gate.resolve();
      await retry;
      expect(entry.collectorCompletion).toEqual({ status: "killed", structured: { answer: 42 } });
      expect(entry.execution).toEqual(killed.execution);
      expect(entry.killReconciliation).toEqual(killed.killReconciliation);
      expect(f.scope.canCleanupSession()).toBe(true);
      await f.scope.settleFailedLaunch("duplicate callback");
      expect(f.writes).toHaveLength(4);
      expect(params.finalizer()).not.toHaveBeenCalled();
      expect(params.createTask).toHaveBeenCalledOnce();
      expect(f.options.persistOrThrow).not.toHaveBeenCalled();
    } finally {
      f.acknowledgeAllWrites();
    }
  });

  it.each(["unknown", "committed"] as const)(
    "retains cancelled launch metadata failure after %s outcome without replay",
    async (outcome) => {
      const { f, entry, killed } = await prepare();
      const failure = new SubagentRegistryWriteError(outcome, new Error("publication failed"));
      try {
        const settlement = f.scope.settleFailedLaunch("accepted launch was cancelled");
        const rejected = expect(settlement).rejects.toBe(failure);
        await vi.waitFor(() => expect(f.writes).toHaveLength(3));
        if (outcome === "committed") {
          f.writes[2]!.afterPublicationFailure = { error: failure };
          f.writes[2]!.gate.resolve();
        } else {
          f.writes[2]!.gate.reject(failure);
        }
        await rejected;
        await expect(f.scope.settleFailedLaunch("retry callback")).rejects.toBe(failure);
        expect(f.writes).toHaveLength(3);
        expect(entry.execution).toEqual(killed.execution);
        expect(entry.killReconciliation).toEqual(killed.killReconciliation);
        expect(Boolean(entry.collectorCompletion)).toBe(outcome === "committed");
        expect(f.scope.canCleanupSession()).toBe(false);
        expect(params.finalizer()).not.toHaveBeenCalled();
      } finally {
        f.acknowledgeAllWrites();
      }
    },
  );

  it.each(["replacement", "newer sibling"] as const)(
    "refuses cancelled launch metadata when a %s takes ownership before admission",
    async (change) => {
      const { f, entry, killed } = await prepare();
      const refusal = new SubagentRegistryWriteError("not-committed", new Error("owner changed"));
      try {
        const settlement = f.scope.settleFailedLaunch("accepted launch was cancelled");
        const rejected = expect(settlement).rejects.toBe(refusal);
        await vi.waitFor(() => expect(f.writes).toHaveLength(3));
        const successor = {
          ...structuredClone(entry),
          runId: change === "replacement" ? entry.runId : "newer-run",
          generation: (entry.generation ?? 0) + 1,
        };
        const successorSnapshot = structuredClone(successor);
        f.runs.set(successor.runId, successor);
        expect(f.writes[2]!.assertCurrent).toThrow("lost its original owner");
        f.writes[2]!.gate.reject(refusal);
        await rejected;
        await f.scope.settleFailedLaunch("late callback");
        expect(f.writes).toHaveLength(3);
        expect(entry).toEqual(killed);
        expect(successor).toEqual(successorSnapshot);
        expect(f.scope.canCleanupSession()).toBe(false);
        expect(params.finalizer()).not.toHaveBeenCalled();
      } finally {
        f.acknowledgeAllWrites();
      }
    },
  );
}
