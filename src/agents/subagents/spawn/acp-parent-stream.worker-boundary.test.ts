import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { captureSessionEventTargetForHost } from "../../../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { mintSpawnSessionKey } from "../../spawn-plan.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
  } finally {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
});

it("persists the real relay's ordered batch with zero caller-thread SQL", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("acp-parent-boundary-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  const agent = openOpenClawAgentDatabase({ agentId: "main", env });
  const { db } = agent;
  const childSessionKey = mintSpawnSessionKey({ targetAgentId: "main", backend: "acp" });
  writeSessionEntry(agent, childSessionKey, { sessionId: "child", updatedAt: 1 });
  const parentSessionKey = "agent:main:parent";
  writeSessionEntry(agent, parentSessionKey, { sessionId: "parent", updatedAt: 1 });
  const expectedTarget = await captureSessionEventTargetForHost("main", parentSessionKey, { env });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => {
    throw new Error("ACP diagnostics ran SQL on the caller");
  });
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(() => {
    throw new Error("ACP diagnostics ran SQL on the caller");
  });
  const relay = startAcpSpawnParentStreamRelay({
    runId: "boundary-run",
    parentSessionKey,
    requesterAgentId: "main",
    expectedTarget,
    childSessionKey,
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
