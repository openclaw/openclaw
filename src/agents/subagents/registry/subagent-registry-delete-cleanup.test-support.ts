import { expect, it, vi } from "vitest";
import {
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeKilledRun } from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerStableCancellationRetentionTests({
  getRegistry,
  mocks,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "callGateway" | "runSubagentAnnounceFlow"
  >;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}) {
  it.each(["late completion", "earlier deadline"] as const)(
    "reconciles stable operator cancellation against %s",
    async (source) => {
      const mod = getRegistry();
      const now = Date.now();
      const startedAt = now - 10_000;
      const killedAt = now - 1_000;
      const runId = "run-stable-cancellation";
      const childSessionKey = "agent:main:subagent:stable-cancellation";
      const earlierDeadline = source === "earlier deadline";
      mocks.entries = {
        [childSessionKey]: {
          ...(earlierDeadline ? {} : { lifecycleRevision: "revision-stable-cancellation" }),
          sessionId: "sess-stable-cancellation",
          updatedAt: now,
          status: earlierDeadline ? "killed" : "done",
          startedAt,
          endedAt: now,
        },
      };
      await mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve authoritative cancellation outcome",
          killReconciliation: { killedAt, taskCancellationAccepted: true },
          expectsCompletionMessage: !earlierDeadline,
          createdAt: startedAt,
          startedAt,
          ...(earlierDeadline ? { runTimeoutSeconds: 8 } : { cleanup: "delete", archiveAtMs: now }),
        }),
      );
      if (!earlierDeadline) {
        expect(killedAt + 5 * 60_000).toBeGreaterThan(Date.now());
      }
      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        if (earlierDeadline) {
          const timeoutAt = now - 2_000;
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            execution: {
              status: "terminal",
              endedAt: timeoutAt,
              outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
            },
          });
          expect(run?.execution.outcome?.error).toBeUndefined();
        } else {
          expect(run).toMatchObject({ cleanupCompletedAt: expect.any(Number) });
          expect(mocks.callGateway).toHaveBeenCalledWith({
            method: "sessions.delete",
            params: {
              key: childSessionKey,
              deleteTranscript: true,
              emitLifecycleHooks: false,
              expectedLifecycleRevision: "revision-stable-cancellation",
              expectedSessionId: "sess-stable-cancellation",
            },
            timeoutMs: 10_000,
            assertDispatchCurrent: expect.any(Function),
            prepareDispatchCurrent: expect.any(Function),
          });
        }
      });
      if (!earlierDeadline) {
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
        await mod.testing.sweepOnceForTests();
        expect(findRequesterRun(runId)).toBeUndefined();
      }
    },
  );
}
