import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  readLatestSessionTranscriptReport,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
} from "./subagent-completion-admission.test-helpers.js";

// mock-isolation: Keep the live registry and its process-wide run owners out of this durable-settlement fixture.
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("requester parent-delivery failure reports", () => {
  it.each(["current", "reset", "replaced", "new writer", "pause", "retry", "rollback"] as const)(
    "reports permanent parent-delivery failure only after current durable settlement (%s)",
    async (scenario) => {
      await withSubagentCompletionWorkerState(async (database) => {
        const input = armRequesterWake(records());
        const child = input.subagent;
        const scope = {
          agentId: "main",
          sessionKey: child.requesterSessionKey,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        };
        const parent = {
          sessionId: "report-parent",
          lifecycleRevision: "report-parent-revision",
          updatedAt: Date.now(),
        };
        const current = {
          ...parent,
          ...(scenario === "reset" ? { lifecycleRevision: "reset-revision" } : {}),
          ...(scenario === "replaced" ? { sessionId: "replacement-parent" } : {}),
          ...(scenario === "new writer" ? { activeWriterRunId: "new-requester-writer" } : {}),
        };
        await replaceSessionEntry(scope, current);
        child.requesterStorePath = scope.storePath;
        child.completionTarget = "parent";
        child.completionRequesterSessionId = parent.sessionId;
        child.completionRequesterLifecycleRevision = parent.lifecycleRevision;
        if (scenario === "pause") {
          child.pauseReason = "sessions_yield";
          child.requesterSettleWake!.pauseNotice = { acknowledgment: "Paused for a child" };
        }
        seedSubagentCompletionOwner({ subagent: child, databaseOptions: { database } });
        const driver = requesterWakeDriver([input]);
        driver.wake.mockImplementation(async (params) => {
          if (scenario === "retry") {
            await params.transitionBatch(
              [params.settledEntry],
              { ...child.requesterSettleWake!, nextAttemptAt: Date.now() + 30_000 },
              () => {},
            );
          } else {
            await params.completeBatch([params.settledEntry], 1, {
              delivered: false,
              path: "none",
              disposition: "permanent_failure",
              error: "Synthetic requester delivery failure",
            });
          }
          return false;
        });
        if (scenario === "rollback") {
          database.db.exec(
            "CREATE TRIGGER reject_parent_settlement AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'cut:parent settlement'); END",
          );
        }
        try {
          await driver.run();
          const persisted = loadSubagentRegistryFromSqlite().get(child.runId)!;
          const report = await readLatestSessionTranscriptReport(
            { ...scope, sessionId: current.sessionId },
            ["run-failed-before-reply"],
          );
          if (scenario === "current") {
            expect(persisted.requesterSettleWake).toBeUndefined();
            expect(persisted.delivery?.status).toBe("failed");
            expect(report).toMatchObject({
              ok: true,
              value: {
                customType: "run-failed-before-reply",
                content: "Your request couldn't be completed: Synthetic requester delivery failure",
              },
            });
            expect(
              loadTranscriptEventsSync({ ...scope, sessionId: current.sessionId }).filter(
                (event) => isRecord(event) && event.type === "custom_message",
              ),
            ).toHaveLength(1);
          } else {
            expect(report).toEqual({ ok: true, value: undefined });
            if (scenario === "pause" || scenario === "retry" || scenario === "rollback") {
              expect(persisted.requesterSettleWake).toBeDefined();
            }
          }
        } finally {
          driver.controller.clearScheduledResumeTimers();
          database.db.exec("DROP TRIGGER IF EXISTS reject_parent_settlement");
        }
      });
    },
  );
});
