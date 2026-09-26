import { expect, it } from "vitest";
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
