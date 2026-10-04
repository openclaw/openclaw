import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
});

it("persists the real relay's ordered batch with zero caller-thread SQL", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("acp-parent-boundary-") };
  const { db } = openOpenClawAgentDatabase({ agentId: "main", env });
  db.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:acp:child', 'child', '{}', 1);
    INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at)
    VALUES ('child', 'agent:main:acp:child', 'conversation', 1, 1);`);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => {
    throw new Error("ACP diagnostics ran SQL on the caller");
  });
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(() => {
    throw new Error("ACP diagnostics ran SQL on the caller");
  });
  const relay = startAcpSpawnParentStreamRelay({
    runId: "boundary-run",
    parentSessionKey: "agent:main:parent",
    childSessionKey: "agent:main:acp:child",
    childSessionId: "child",
    agentId: "main",
    env,
    eventRouting: {},
  });
  try {
    for (let ordinal = 0; ordinal < 100; ordinal++) {
      emitAgentEvent({
        runId: "boundary-run",
        stream: "acp",
        data: { phase: "runtime_event", ordinal },
      });
    }
    await relay.dispose();
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
    await relay.dispose();
  }
  const rows = db
    .prepare("SELECT seq, event_json FROM acp_parent_stream_events ORDER BY seq")
    .all();
  expect(rows).toHaveLength(100);
  expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index));
  expect(rows.map((row) => JSON.parse(String(row.event_json)).data.ordinal)).toEqual(
    Array.from({ length: 100 }, (_, index) => index),
  );
});
