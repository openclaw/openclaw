import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { migratePortableIdentityColumnsV22 } from "../../state/openclaw-state-db-schema-v22-columns.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionCommand } from "./session-meta-read.worker.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

function row(sessionKey: string, meta: SessionAcpMeta, agentId = "coder") {
  return bindAcpSessionMeta({
    sessionKey: buildAcpDatabaseSessionKey(sessionKey, agentId),
    lifecycleRevision: "revision",
    updatedAt: 100,
    meta,
  });
}
const resultFields = { session_id: "revision", updated_at: 100, agent: "harness-agent" };
function resume(db: EngineConnection, resumeSessionId: string, backendId?: string) {
  return readAcpSessionCommand(db, {
    type: "acpSessions.resume",
    agentId: "coder",
    resumeSessionId,
    backendId,
  }).rows;
}

it("uses indexes for ordered resume matches while filtering agent and backend identities", () => {
  using db = new DatabaseSync(":memory:");
  const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
    endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
    includeEndMarker: false,
  });
  db.exec(schema);
  const meta = createAcpMeta({ agent: "harness-agent" });
  for (const [suffix, identity, agentId = "coder", backend = " FIXTURE "] of [
    ["1", { agentSessionId: "first", acpxSessionId: "first" }],
    ["0", { agentSessionId: "first", acpxSessionId: "second" }],
    ["2", { agentSessionId: "nul\u0000tail" }],
    ["other-agent", { agentSessionId: "first" }, "other"],
    ["other-backend", { agentSessionId: "first" }, "coder", "other"],
  ] as const) {
    upsertAcpSessionMetaRow(db, {
      ...row(`agent:coder:acp:${suffix}`, { ...meta, backend }, agentId),
      identity_json: JSON.stringify(identity),
    });
  }
  migratePortableIdentityColumnsV22(db, 21);
  db.exec(schema);
  let selectSql = "";
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    if (query.startsWith("select") && query.includes('from "acp_sessions"')) {
      selectSql = query;
    }
    return prepare(query);
  });
  try {
    for (const [id, matches] of [
      ["first", [0, 1]],
      ["second", [0]],
      ["nul\u0000tail", [2]],
      ["absent", []],
    ] as const) {
      expect(resume(db, id, "fixture")).toEqual(
        matches.map((index) =>
          Object.assign({ sessionKey: `agent:coder:acp:${index}` }, resultFields),
        ),
      );
    }
  } finally {
    spy.mockRestore();
  }
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${selectSql}`)
    .all("absent", "absent")
    .map((entry) => entry.detail);
  expect(
    plan.filter((detail) => String(detail).includes("SEARCH acp_sessions USING INDEX")),
  ).toHaveLength(2);
  expect(plan.some((detail) => String(detail).includes("SCAN acp_sessions"))).toBe(false);
});

it("adds resume indexes to populated same-version state without changing canonical rows", () =>
  withOpenClawTestState({ scenario: "minimal", label: "acp-resume-index" }, async (state) => {
    const options = { env: state.env };
    const initial = openOpenClawStateDatabase(options);
    upsertAcpSessionMetaRow(
      initial.db,
      row(
        "agent:coder:acp:existing",
        createAcpMeta({
          agent: "coder",
          identity: {
            state: "resolved",
            source: "ensure",
            lastUpdatedAt: 100,
            agentSessionId: "resume",
            acpxSessionId: "acpx",
          },
        }),
      ),
    );
    const rows = initial.db.prepare("SELECT * FROM acp_sessions").all();
    const version = initial.db.prepare("PRAGMA user_version").get();
    initial.db.exec(
      "DROP INDEX idx_acp_sessions_resume_agent; DROP INDEX idx_acp_sessions_resume_acpx",
    );
    await closeStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("SELECT * FROM acp_sessions").all()).toEqual(rows);
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_acp_sessions_resume_%'",
        )
        .all(),
    ).toHaveLength(2);
    expect(resume(reopened.db, "resume")).toEqual([
      { sessionKey: "agent:coder:acp:existing", ...resultFields, agent: "coder" },
    ]);
  }));
