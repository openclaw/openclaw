import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { mutateSubagentCompletionInDatabase } from "../completion/subagent-completion-mutation.kernel.js";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { readSubagentRun } from "./subagent-registry.store.sqlite.js";

const fixture = useTempSessionsFixture("requester-consumption-");
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.resolve(fixture.sessionsDir(), "../../.."));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "settles a persisted consumed input after restart (answered=%s)",
  (answered) => {
    const entry = createSubagentStoreRunFixture({
      requesterSettleWake: { status: "dispatching", attemptCount: 1, batchRunIds: ["run-one"] },
    });
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    let database = openOpenClawStateDatabase();
    runOpenClawStateWriteTransaction(
      () =>
        mutateSubagentCompletionInDatabase(database, {
          kind: "requesterWake",
          entries: [{ subagent: entry }],
          operation: {
            kind: "requesterDelivery",
            fact: { state: "consumed", runId: "requester-turn", at: 50 },
          },
        }),
      { database },
    );
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase();
    const restored = readSubagentRun(database, entry.runId)!;
    expect(restored.delivery?.requesterDelivery).toEqual({
      state: "consumed",
      runId: "requester-turn",
      at: 50,
    });
    runOpenClawStateWriteTransaction(
      () =>
        mutateSubagentCompletionInDatabase(database, {
          kind: "requesterBatch",
          entries: [{ subagent: restored }],
          now: 100,
          outcome: answered
            ? {
                delivered: false,
                path: "direct",
                finalAssistantVisibleText: "answer",
                reason: "message_tool_delivery_missing",
                disposition: "permanent_failure",
              }
            : { delivered: false, path: "direct", error: "provider unavailable" },
        }),
      { database },
    );
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase();
    const settled = readSubagentRun(database, entry.runId)!;
    expect(settled.delivery?.requesterDelivery?.state).toBe("consumed");
    expect(settled.delivery?.status).toBe(answered ? "failed" : "delivered");
    expect(settled.requesterSettleWake).toBeUndefined();
    expect(settled.delivery?.lastDropReason).toBe(
      answered ? "message_tool_delivery_missing" : undefined,
    );
  },
);
