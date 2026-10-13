import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { migratePortableIdentityColumnsV22 } from "../../state/openclaw-state-db-schema-v22-columns.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import { readAcpSessionCommand } from "./session-meta-read.worker.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

it("matches migrated string identities using index searches, including malformed and non-string identities", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
      endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
      includeEndMarker: false,
    });
    db.exec(schema);
    let random = 485;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const fixtures = Array.from({ length: 128 }, (_, i) => {
      const agentId = next() % 7 === 0 ? "other" : "coder";
      const backend = next() % 5 === 0 ? "other" : " FIXTURE ";
      const first = `id-${next() % 17}`;
      const second = `id-${next() % 19}`;
      return {
        sessionKey: `agent:coder:acp:${String(i).padStart(3, "0")}`,
        agentId,
        backend,
        identity:
          i === 0
            ? "malformed"
            : JSON.stringify({
                agentSessionId: i === 1 ? 42 : `\u00a0 ${first}\t`,
                acpxSessionId: second,
              }),
        matches: i === 0 ? [] : i === 1 ? [second] : [first, second],
      };
    });
    fixtures.push(
      ...[
        { identity: '{"agentSessionId":" first ","agentSessionId":"last"}', matches: ["first"] },
        { identity: '{"agentSessionId":true,"agentSessionId":"last"}', matches: [] },
        { identity: '{"agentSessionId":42,"acpxSessionId":"42"}', matches: ["42"] },
        { identity: '{"agentSessionId":"nul\\u0000tail"}', matches: ["nul\u0000tail"] },
      ].map((fixture, index) => ({
        identity: fixture.identity,
        matches: fixture.matches,
        sessionKey: `agent:coder:acp:extra-${index}`,
        agentId: "coder",
        backend: "fixture",
      })),
    );
    for (const fixture of fixtures.toReversed()) {
      upsertAcpSessionMetaRow(db, {
        ...bindAcpSessionMeta({
          sessionKey: buildAcpDatabaseSessionKey(fixture.sessionKey, fixture.agentId),
          lifecycleRevision: "revision",
          updatedAt: 100,
          meta: {
            backend: fixture.backend,
            agent: "harness-agent",
            runtimeSessionName: "fixture",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 100,
          },
        }),
        identity_json: fixture.identity,
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
      for (const resumeSessionId of [
        "42",
        "first",
        "last",
        "1",
        "nul\u0000tail",
        "absent",
        ...Array.from({ length: 19 }, (_, i) => `id-${i}`),
      ]) {
        const expected = fixtures
          .filter((fixture) => {
            if (fixture.agentId !== "coder" || fixture.backend.trim().toLowerCase() !== "fixture") {
              return false;
            }
            return fixture.matches.includes(resumeSessionId);
          })
          .map(({ sessionKey }) => ({
            sessionKey,
            session_id: "revision",
            updated_at: 100,
            agent: "harness-agent",
          }));
        expect(
          readAcpSessionCommand(db, {
            type: "acpSessions.resume",
            agentId: "coder",
            backendId: "fixture",
            resumeSessionId,
          }).rows,
        ).toEqual(expected);
      }
    } finally {
      spy.mockRestore();
    }
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${selectSql}`)
      .all("absent", "absent")
      .map((row) => row.detail);
    expect(
      plan.filter((detail) => String(detail).includes("SEARCH acp_sessions USING INDEX")),
    ).toHaveLength(2);
    expect(plan.some((detail) => String(detail).includes("SCAN acp_sessions"))).toBe(false);
  } finally {
    db.close();
  }
});

it("adds resume indexes to populated same-version state without changing canonical rows", async () => {
  await withOpenClawTestState({ scenario: "minimal", label: "acp-resume-index" }, async (state) => {
    const options = { env: state.env };
    const initial = openOpenClawStateDatabase(options);
    upsertAcpSessionMetaRow(
      initial.db,
      bindAcpSessionMeta({
        sessionKey: buildAcpDatabaseSessionKey("agent:coder:acp:existing", "coder"),
        lifecycleRevision: "revision",
        updatedAt: 100,
        meta: {
          backend: "fixture",
          agent: "coder",
          runtimeSessionName: "fixture",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
          identity: {
            state: "resolved",
            source: "ensure",
            lastUpdatedAt: 100,
            agentSessionId: "resume",
            acpxSessionId: "acpx",
          },
        },
      }),
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
    expect(
      readAcpSessionCommand(reopened.db, {
        type: "acpSessions.resume",
        agentId: "coder",
        resumeSessionId: "resume",
      }).rows,
    ).toEqual([
      {
        sessionKey: "agent:coder:acp:existing",
        session_id: "revision",
        updated_at: 100,
        agent: "coder",
      },
    ]);
  });
});
