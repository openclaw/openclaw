import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
  sqliteMethods,
} from "../../../../test/helpers/sqlite-parent-observer.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { openNodeSqliteDatabase } from "../../../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { applyEmbeddedAttemptSessionIdentity } from "./attempt-session-identity.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";

let testState: OpenClawTestState;
beforeAll(async () => {
  testState = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await testState.cleanup();
});

it("loads attempt entries and adopts successors without SQLite on the calling thread", async () => {
  const storePath = testState.sessionsDir("main") + "/sessions.json";
  const target = { agentId: "main", storePath, sessionKey: "agent:main:identity" };
  replaceSessionEntrySync(target, { sessionId: "session-after", updatedAt: 2 });
  await closeOpenClawAgentDatabasesAsync();
  const observer = observeParentSqlite();
  try {
    const calibration = openNodeSqliteDatabase(":memory:");
    calibration.exec("CREATE TABLE calibration (value INTEGER)");
    calibration.prepare("INSERT INTO calibration VALUES (?)").run(7);
    const query = calibration.prepare("SELECT value FROM calibration");
    expect(query.get()).toEqual({ value: 7 });
    expect(query.all()).toEqual([{ value: 7 }]);
    expect([...query.iterate()]).toEqual([{ value: 7 }]);
    calibration.close();
    sqliteMethods.forEach((method) => expect(observer.counts[method], method).toBeGreaterThan(0));
    observer.reset();
    expect(await loadAttemptSessionEntryAfterQuotaMaintenance(target, () => {})).toMatchObject({
      sessionId: "session-after",
    });
    expect(observer.counts).toEqual(emptySqliteCounts());

    for (const kind of ["marker", "key"] as const) {
      const previousMarker = formatSqliteSessionFileMarker({
        ...target,
        sessionId: "session-before",
      });
      const nextMarker = formatSqliteSessionFileMarker({ ...target, sessionId: "session-after" });
      const sessionPromptState = {
        sessionId: "session-before",
        sessionFile: kind === "marker" ? target.sessionKey : previousMarker,
        sessionTarget: { ...target, sessionId: "session-before" },
        adoptSessionId: vi.fn(),
      };
      await applyEmbeddedAttemptSessionIdentity({
        sessionPromptState,
        sessionIdUsed: "session-after",
        sessionFileUsed: kind === "marker" ? nextMarker : target.sessionKey,
        assertCurrent: () => {},
      });
      expect(sessionPromptState.adoptSessionId).toHaveBeenCalledWith("session-after");
      expect(sessionPromptState.sessionTarget).toEqual({ ...target, sessionId: "session-after" });
      expect(observer.counts).toEqual(emptySqliteCounts());
    }
  } finally {
    observer.restore();
  }
});
