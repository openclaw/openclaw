import { expect, it, vi } from "vitest";
import { applySessionEntryLifecycleMutation } from "../../../config/sessions/session-accessor.lifecycle.js";
import { readExactSessionEntryRow } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../../config/sessions/session-entry-current-check.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import "./subagent-registry-maintenance.js";

// mock-isolation: The explicit cap pass owns this test; background sweeps must not race it.
vi.mock(
  "../../../config/sessions/session-accessor.sqlite-maintenance-kick.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../config/sessions/session-accessor.sqlite-maintenance-kick.js")
    >()),
    kickSessionEntryMaintenanceAfterWrite() {},
  }),
);
vi.mock("../../../config/sessions/session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../config/sessions/session-history-eviction.js")
  >()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

it("retains completion policy through maintenance until requester settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const child = "agent:main:subagent:completion-source";
    const parent = "agent:main:main";
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = { agentId: "main", sessionKey: child, storePath: database.path };
    replaceSessionEntrySync(
      { ...scope, sessionKey: parent },
      { sessionId: "requester", updatedAt: Date.now() },
    );
    replaceSessionEntrySync(scope, {
      sessionId: "completion-source",
      lifecycleRevision: "child-revision",
      updatedAt: Date.now(),
      createdVia: "spawn",
      spawnedBy: parent,
      completionOwnerSessionKey: parent,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: [],
      inheritedToolDeny: ["exec"],
    });
    const run: SubagentRunRecord = {
      runId: "completion-run",
      childSessionKey: child,
      requesterSessionKey: parent,
      requesterDisplayKey: parent,
      createdAt: 1,
      task: "fixture",
      cleanup: "keep",
      expectsCompletionMessage: true,
      execution: { status: "terminal", endedAt: 2 },
      cleanupCompletedAt: 3,
      completion: { required: true },
      delivery: { status: "pending" },
      requesterSettleWake: { status: "dispatching", attemptCount: 1 },
    };
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    subagentRuns.set(run.runId, run);
    clearSubagentRunsReadCacheForTest();
    const policy = await captureSessionEntryCurrentCheckAsyncInternal({
      ...scope,
      fields: ["sessionId", "lifecycleRevision", "spawnedBy", "inheritedToolDeny"],
      errorMessage: "completion requester policy changed",
    });
    const maintain = () =>
      applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: scope.storePath,
        activeSessionKey: parent,
        upserts: [{ sessionKey: parent, entry: { sessionId: "requester", updatedAt: Date.now() } }],
        maintenanceOverride: { mode: "enforce", maxEntries: 1, preserveRecentMs: 14 * 86_400_000 },
      });
    try {
      await maintain();
      await expect(policy.assertCurrent()).resolves.toBeUndefined();
      expect(readExactSessionEntryRow(database, child)?.entry).toMatchObject({
        sessionId: "completion-source",
      });
      subagentRuns.set(run.runId, {
        ...run,
        requesterSettleWake: undefined,
        delivery: { status: "delivered" },
      });
      await maintain();
      expect(readExactSessionEntryRow(database, child)?.entry).toBeUndefined();
      await expect(policy.assertCurrent()).rejects.toThrow("completion requester policy changed");
    } finally {
      policy.release();
      subagentRuns.clear();
      clearSubagentRunsReadCacheForTest();
    }
  });
});
