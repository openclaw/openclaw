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

it("matches migrated string identities using index searches, including malformed and non-string identities", () => {
  using db = new DatabaseSync(":memory:");
  const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
    endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
    includeEndMarker: false,
  });
  db.exec(schema);
  const identities: [string, string[]][] = [
    ["malformed", []],
    ['{"agentSessionId":42,"acpxSessionId":"second"}', ["second"]],
    ['{"agentSessionId":"\u00a0 first\\t","acpxSessionId":"second"}', ["first", "second"]],
    ['{"agentSessionId":" first ","agentSessionId":"last"}', ["first"]],
    ['{"agentSessionId":true,"agentSessionId":"last"}', []],
    ['{"agentSessionId":42,"acpxSessionId":"42"}', ["42"]],
    ['{"agentSessionId":"nul\\u0000tail"}', ["nul\u0000tail"]],
    ['{"agentSessionId":"first","acpxSessionId":"first"}', ["first"]],
  ];
  const meta = createAcpMeta({ agent: "harness-agent" });
  const seed = (id: string, identity: string, agent = "coder", backend = " FIXTURE ") =>
    upsertAcpSessionMetaRow(db, {
      ...row(`agent:coder:acp:${id}`, { ...meta, backend }, agent),
      identity_json: identity,
    });
  seed("other-backend", identities[2]![0], "coder", "other");
  seed("other-agent", identities[2]![0], "other");
  for (const [index, [identity]] of [...identities.entries()].toReversed()) {
    seed(String(index), identity);
  }
  migratePortableIdentityColumnsV22(db, 21);
  db.exec(schema);
  using spy = vi.spyOn(db, "prepare");
  for (const id of ["42", "first", "second", "last", "1", "nul\u0000tail", "absent"]) {
    const expected = identities.flatMap(([, matches], index) =>
      matches.includes(id) ? [{ sessionKey: `agent:coder:acp:${index}`, ...resultFields }] : [],
    );
    expect(resume(db, id, "fixture")).toEqual(expected);
  }
  const selectSql = spy.mock.calls.findLast(
    ([sql]) => sql.startsWith("select") && sql.includes('from "acp_sessions"'),
  )?.[0];
  expect(selectSql).toBeDefined();
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${selectSql}`)
    .all("absent", "absent")
    .map((entry) => entry.detail)
    .join("\n");
  expect(plan.match(/SEARCH acp_sessions USING INDEX/g)).toHaveLength(2);
  expect(plan).not.toContain("SCAN acp_sessions");
});

it("adds resume indexes to populated same-version state without changing canonical rows", () =>
  withOpenClawTestState({ scenario: "minimal", label: "acp-resume-index" }, async (state) => {
    const initial = openOpenClawStateDatabase({ env: state.env });
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
    const reopened = openOpenClawStateDatabase({ env: state.env });
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
