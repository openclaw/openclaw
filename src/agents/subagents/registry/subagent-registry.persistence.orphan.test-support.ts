import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { testing } from "./subagent-registry.test-helpers.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

export function registerSubagentOrphanTaskCases({
  writePersistedRegistry,
  restartRegistry,
  waitForRegistryWork,
}: {
  writePersistedRegistry: (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => Promise<void>;
  restartRegistry: () => void;
  waitForRegistryWork: (predicate: () => boolean | Promise<boolean>) => Promise<void>;
}) {
  it.each(["observation-only", "ordinary"] as const)(
    "handles a missing-session restored %s run without inventing child stop evidence",
    async (representation) => {
      const now = Date.now();
      const runId = `run-missing-session-${representation}`;
      const childSessionKey = `agent:main:subagent:missing-session-${representation}`;
      const observed = representation === "observation-only";
      await writePersistedRegistry(
        {
          runs: {
            [runId]: {
              runId,
              generation: 1,
              childSessionKey,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "restore missing session without stop evidence",
              cleanup: "keep",
              expectsCompletionMessage: false,
              createdAt: now - 10_000,
              execution: { status: "running", startedAt: now - 10_000 },
              ...(observed ? { waitExpiryObservedAt: now - 1_000 } : {}),
            },
          },
        },
        { seedChildSessions: false },
      );
      const childResult = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
      vi.mocked(callGateway).mockImplementation(async (request) =>
        request.method === "agent.wait" ? await childResult.promise : {},
      );
      const hasWait = () =>
        vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "agent.wait");
      try {
        restartRegistry();
        // Reach either the legitimate re-wait or the erroneous terminal path;
        // do not use a sleep to infer absence of asynchronous completion.
        await waitForRegistryWork(
          () => hasWait() || resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
        );
        if (observed) {
          expect(hasWait(), "unconfirmed child is re-waited after restore").toBe(true);
          const retained = subagentRuns.get(runId);
          expect(retained?.waitExpiryObservedAt).toBe(now - 1_000);
          expect(retained?.execution.endedAt).toBeUndefined();
          expect(retained?.execution.outcome).toBeUndefined();
          expect(retained?.cleanupCompletedAt).toBeUndefined();
          childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
          await waitForRegistryWork(
            () => subagentRuns.get(runId)?.execution.outcome?.status === "ok",
          );
        } else {
          expect(hasWait(), "ordinary orphan still reaches canonical completion").toBe(false);
          expect(subagentRuns.get(runId)?.execution.outcome).toMatchObject({
            status: "error",
            error: "subagent run orphaned: missing-session-entry",
          });
          await waitForRegistryWork(() => subagentRuns.get(runId)?.cleanupCompletedAt !== undefined);
        }
      } finally {
        childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
      }
    },
  );

  it("terminalizes a stale restored orphan without replaying its provider", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });

    restartRegistry();
    await testing.sweepOnceForTests();
    await waitForRegistryWork(
      () => resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
    );
    expect(callGateway).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });
}
