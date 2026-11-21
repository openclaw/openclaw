import path from "node:path";
import { expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../../test/helpers/sqlite-worker-fault.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  armRequesterWake,
  currentCompletionRun,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
} from "../completion/subagent-completion-admission.test-helpers.js";

vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));
const fault = useSqliteWorkerFault([
  {
    name: "reject_requester_retry_notice",
    match: /^insert into transcript_events\b/iu,
    sql: `CREATE TEMP TRIGGER reject_requester_retry_notice BEFORE INSERT ON main.transcript_events
    BEGIN SELECT RAISE(ABORT, 'transient notice write'); END`,
  },
]);

it("retains the observed requester outcome through a notice write failure without redelivery", async () => {
  await withSubagentCompletionWorkerState(async (database) => {
    const input = armRequesterWake(records());
    const storePath = path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.json");
    const scope = {
      agentId: "main",
      sessionKey: input.subagent.requesterSessionKey,
      sessionId: "notice-receipt-requester",
      storePath,
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
    });
    input.subagent.requesterStorePath = storePath;
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    const driver = requesterWakeDriver([input]);
    const transport = vi.fn();
    driver.wake.mockImplementation(async (params) => {
      transport();
      await params.completeBatch([params.settledEntry], 1, {
        delivered: false,
        path: "none",
        disposition: "permanent_failure",
        error: "external failed",
      });
      return true;
    });
    const notices = async () =>
      (await loadTranscriptEvents(scope)).filter(
        (event) =>
          event.type === "custom_message" && event.customType === "run-failed-before-reply",
      );
    try {
      fault.enable();
      await driver.run();
      expect(transport).toHaveBeenCalledOnce();
      expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
      expect(await notices()).toHaveLength(0);
      fault.disable();
      await driver.sweep();
      await driver.sweep();
      expect(transport).toHaveBeenCalledOnce();
      const reports = await notices();
      expect(reports).toHaveLength(1);
      expect(JSON.stringify(reports[0])).toContain("canonical result");
    } finally {
      fault.disable();
      driver.controller.clearRuntimeState();
    }
  });
});
