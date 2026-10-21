import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareRestartRecoveryDeliveryCurrent } from "./main-session-restart-recovery-delivery.js";

it("revokes a retained recovery notice when the session writer denies delivery", async () => {
  await withOpenClawTestState({ label: "recovery-delivery-current" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    const deliveryContext = { channel: "telegram", to: "123" };
    const entry = {
      sessionId: "session",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "recovery",
      restartRecoveryDeliveryContext: deliveryContext,
    };
    await replaceSessionEntry(scope, entry);
    const prepared = await prepareRestartRecoveryDeliveryCurrent({
      ...scope,
      sessionId: entry.sessionId,
      recoveryRunId: "recovery",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      deliveryContext,
      cfg: {},
    });
    try {
      expect(prepared.isCurrent()).toBe(true);
      await replaceSessionEntry(scope, { ...entry, sendPolicy: "deny", updatedAt: 2 });
      const sql = observeHostDataSql();
      try {
        expect(prepared.isCurrent()).toBe(false);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    } finally {
      prepared.release();
    }
  });
});
