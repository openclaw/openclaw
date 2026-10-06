import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import { readAcpSessionCommand } from "./session-meta-read.worker.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

it("matches randomized identities using index searches, including malformed and non-string identities", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
        endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
        includeEndMarker: false,
      }),
    );
    let random = 485;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const fixtures = Array.from({ length: 128 }, (_, i) => ({
      sessionKey: `agent:coder:acp:${String(i).padStart(3, "0")}`,
      agentId: next() % 7 === 0 ? "other" : "coder",
      backend: next() % 5 === 0 ? "other" : " FIXTURE ",
      identity:
        i === 0
          ? "malformed"
          : JSON.stringify({
              agentSessionId: i === 1 ? 42 : `\u00a0 id-${next() % 17}\t`,
              acpxSessionId: `id-${next() % 19}`,
            }),
    }));
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
        "absent",
        ...Array.from({ length: 19 }, (_, i) => `id-${i}`),
      ]) {
        const expected = fixtures
          .filter((fixture) => {
            if (fixture.agentId !== "coder" || fixture.backend.trim().toLowerCase() !== "fixture") {
              return false;
            }
            let identity: { agentSessionId?: unknown; acpxSessionId?: unknown };
            try {
              identity = JSON.parse(fixture.identity);
            } catch {
              return false;
            }
            return [identity.agentSessionId, identity.acpxSessionId].some(
              (id) => typeof id === "string" && id.trim() === resumeSessionId,
            );
          })
          .map(({ sessionKey }) => ({ sessionKey, session_id: "revision", updated_at: 100 }));
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
      .all("absent", "text", "absent", "text")
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
      { sessionKey: "agent:coder:acp:existing", session_id: "revision", updated_at: 100 },
    ]);
  });
});
