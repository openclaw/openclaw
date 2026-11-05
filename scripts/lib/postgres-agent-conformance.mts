import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Kysely } from "kysely";
import type { Client } from "pg";
import { OpenClawPostgresDialect } from "../../src/infra/sql-query-compiler.js";
import type { DB as AgentSchema } from "../../src/state/openclaw-agent-db.generated.js";

/** Exercise generated DDL, including its triggers, against the canonical SQLite owner. */
export async function checkAgentPostgresBehavior(client: Client): Promise<void> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(
    readFileSync(new URL("../../src/state/openclaw-agent-schema.sql", import.meta.url), "utf8"),
  );
  const pgSql = (sql: string) => {
    let n = 0;
    return sql.replaceAll("?", () => `$${++n}`);
  };
  const execute = async (sql: string, values: SQLInputValue[] = []) => {
    sqlite.prepare(sql).run(...values);
    await client.query(pgSql(sql), values);
  };
  const insert = (table: string, row: Record<string, SQLInputValue>) =>
    execute(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(", ")})`,
      Object.values(row),
    );
  const rows = async (
    label: string,
    sql: string,
    expected: Record<string, unknown>[],
    postgresSql = pgSql(sql),
    parameters: readonly unknown[] = [],
  ) => {
    const canonical = sqlite
      .prepare(sql)
      .all()
      .map((row) => Object.fromEntries(Object.entries(row)));
    const result = await client.query(postgresSql, [...parameters]);
    const actual = result.rows.map((row) =>
      Object.fromEntries(
        result.fields.map((field) => [
          field.name,
          field.dataTypeID === 20 && row[field.name] !== null
            ? Number(row[field.name])
            : row[field.name],
        ]),
      ),
    );
    assert.deepEqual(canonical, expected, `${label}: canonical SQLite behavior`);
    assert.deepEqual(actual, expected, `${label}: generated PostgreSQL behavior`);
  };
  const reject = async (
    label: string,
    sql: string,
    values: SQLInputValue[],
    postgresError = /check constraint|unique constraint/i,
  ) => {
    assert.throws(
      () => sqlite.prepare(sql).run(...values),
      /CHECK|UNIQUE constraint/i,
      `${label}: SQLite accepted row`,
    );
    await assert.rejects(
      client.query(pgSql(sql), values),
      postgresError,
      `${label}: PostgreSQL accepted row`,
    );
  };
  const transaction = async (action: "BEGIN" | "COMMIT" | "ROLLBACK") => {
    sqlite.exec(action);
    await client.query(action);
  };
  try {
    const queue = new Kysely<Pick<AgentSchema, "context_engine_turn_outbox">>({
      dialect: new OpenClawPostgresDialect({
        pool: async () => {
          throw new Error("Compile-only conformance query");
        },
      }),
    });
    const pending = queue
      .selectFrom("context_engine_turn_outbox")
      .where("engine_id", "=", "fifo")
      .where("owner_plugin_id", "is", null)
      .where("payload_state", "is distinct from", "blocked");
    const recovery = pending
      .where("session_id", "=", "session-a")
      .select(["advancement_key", "payload_json"])
      .orderBy("enqueue_sequence", "asc")
      .compile();
    const sessions = pending
      .select("session_id")
      .select((eb) => eb.fn.min("enqueue_sequence").as("oldest_enqueue_sequence"))
      .groupBy("session_id")
      .orderBy("oldest_enqueue_sequence", "asc")
      .limit(2)
      .compile();
    const next = pending
      .where("session_id", "=", "session-a")
      .select(["advancement_key", "payload_json", "session_id"])
      .orderBy("enqueue_sequence", "asc")
      .limit(1)
      .compile();
    for (const [key, session, state, timestamp] of [
      ["session-a:z-first", "session-a", "ready", 90],
      ["session-a:m-blocked", "session-a", "blocked", 1],
      ["session-a:a-second", "session-a", "accepted", 90],
      ["session-b:first", "session-b", "ready", 0],
    ] as const) {
      await insert("context_engine_turn_outbox", {
        advancement_key: key,
        engine_id: "fifo",
        session_id: session,
        payload_json: JSON.stringify({ state }),
        payload_state: state,
        created_at: timestamp,
      });
    }
    const fifo =
      "FROM context_engine_turn_outbox WHERE engine_id = 'fifo' AND owner_plugin_id IS NULL AND payload_state IS DISTINCT FROM 'blocked'";
    await rows(
      "outbox recovery FIFO",
      `SELECT advancement_key, payload_json ${fifo} AND session_id = 'session-a' ORDER BY enqueue_sequence`,
      [
        { advancement_key: "session-a:z-first", payload_json: '{"state":"ready"}' },
        { advancement_key: "session-a:a-second", payload_json: '{"state":"accepted"}' },
      ],
      recovery.sql,
      recovery.parameters,
    );
    await rows(
      "pending session FIFO",
      `SELECT session_id, MIN(enqueue_sequence) AS oldest_enqueue_sequence ${fifo} GROUP BY session_id ORDER BY oldest_enqueue_sequence LIMIT 2`,
      [
        { session_id: "session-a", oldest_enqueue_sequence: 1 },
        { session_id: "session-b", oldest_enqueue_sequence: 4 },
      ],
      sessions.sql,
      sessions.parameters,
    );
    await execute(
      "UPDATE context_engine_turn_outbox SET attempt_count = attempt_count + 1, last_error = 'retry' WHERE advancement_key = 'session-a:z-first'",
    );
    await execute(
      "UPDATE context_engine_turn_outbox SET payload_json = '{\"state\":\"ready\"}', payload_state = 'ready' WHERE advancement_key = 'session-a:a-second'",
    );
    await execute(
      "INSERT INTO context_engine_turn_outbox (advancement_key, engine_id, session_id, payload_json, created_at) VALUES ('session-a:z-first', 'fifo', 'session-a', '{}', 0) ON CONFLICT (advancement_key) DO NOTHING",
    );
    await rows(
      "retry remains the head",
      `SELECT advancement_key, payload_json, session_id ${fifo} AND session_id = 'session-a' ORDER BY enqueue_sequence LIMIT 1`,
      [
        {
          advancement_key: "session-a:z-first",
          payload_json: '{"state":"ready"}',
          session_id: "session-a",
        },
      ],
      next.sql,
      next.parameters,
    );
    await rows(
      "payload and attempt updates retain sequence",
      "SELECT advancement_key, enqueue_sequence, attempt_count FROM context_engine_turn_outbox ORDER BY enqueue_sequence",
      [
        { advancement_key: "session-a:z-first", enqueue_sequence: 1, attempt_count: 1 },
        { advancement_key: "session-a:m-blocked", enqueue_sequence: 2, attempt_count: 0 },
        { advancement_key: "session-a:a-second", enqueue_sequence: 3, attempt_count: 0 },
        { advancement_key: "session-b:first", enqueue_sequence: 4, attempt_count: 0 },
      ],
    );
    await execute(
      "DELETE FROM context_engine_turn_outbox WHERE advancement_key = 'session-a:z-first'",
    );
    await rows(
      "blocked evidence does not hold the next turn",
      `SELECT advancement_key, payload_json, session_id ${fifo} AND session_id = 'session-a' ORDER BY enqueue_sequence LIMIT 1`,
      [
        {
          advancement_key: "session-a:a-second",
          payload_json: '{"state":"ready"}',
          session_id: "session-a",
        },
      ],
      next.sql,
      next.parameters,
    );
    // PostgreSQL runtime DDL leaves bootstrap rows to the runtime owner.
    await client.query("INSERT INTO memory_index_state (id, revision) VALUES (1, 0)");
    for (const key of ["snap-a", "snap-b", "route"]) {
      await insert("session_nodes", {
        session_key: key,
        current_session_id: `${key}-window`,
        entry_json: "{}",
        updated_at: 1,
      });
    }
    const revisions = (a: number, b: number) =>
      rows(
        "snapshot revisions",
        "SELECT session_key, snapshot_revision FROM session_nodes WHERE session_key LIKE 'snap-%' ORDER BY session_key",
        [
          { session_key: "snap-a", snapshot_revision: a },
          { session_key: "snap-b", snapshot_revision: b },
        ],
      );
    await execute(
      "INSERT INTO session_entry_snapshots VALUES ('snap-a', 'skillsSnapshot', '{}'), ('snap-a', 'systemPromptReport', '{}')",
    );
    await revisions(2, 0);
    await execute(
      "UPDATE session_entry_snapshots SET value_json = value_json, field = field, session_key = session_key",
    );
    await revisions(2, 0);
    await execute(
      "UPDATE session_entry_snapshots SET value_json = '{\"changed\":true}' WHERE field = 'skillsSnapshot'",
    );
    await revisions(3, 0);
    await execute(
      "UPDATE session_entry_snapshots SET field = 'sessionDiffBaseline' WHERE field = 'skillsSnapshot'",
    );
    await revisions(4, 0);
    await execute(
      "UPDATE session_entry_snapshots SET session_key = 'snap-b' WHERE field = 'sessionDiffBaseline'",
    );
    await revisions(5, 1);
    await execute("UPDATE session_entry_snapshots SET value_json = 'null'");
    await revisions(6, 2);
    await transaction("BEGIN");
    await execute("INSERT INTO session_entry_snapshots VALUES ('snap-a', 'skillsSnapshot', '{}')");
    await revisions(7, 2);
    await transaction("ROLLBACK");
    await revisions(6, 2);
    await execute("DELETE FROM session_entry_snapshots WHERE session_key = 'snap-b'");
    await revisions(6, 3);
    await execute("DELETE FROM session_nodes WHERE session_key = 'snap-a'");
    await rows("snapshot cascade", "SELECT count(*) AS count FROM session_entry_snapshots", [
      { count: 0 },
    ]);
    await rows(
      "surviving parent revision",
      "SELECT snapshot_revision FROM session_nodes WHERE session_key = 'snap-b'",
      [{ snapshot_revision: 3 }],
    );

    await insert("conversations", {
      conversation_id: "route-conversation",
      channel: "test",
      account_id: "test",
      kind: "direct",
      peer_id: "route-peer",
      delivery_target: "test",
      created_at: 1,
      updated_at: 1,
    });
    await insert("session_windows", {
      session_id: "route-window",
      session_key: "route",
      created_at: 1,
      updated_at: 1,
      primary_conversation_id: "route-conversation",
    });
    await insert("session_conversations", {
      session_id: "route-window",
      conversation_id: "route-conversation",
      role: "primary",
      route_context_json: "old-envelope",
      first_seen_at: 1,
      last_seen_at: 1,
    });
    const envelope = (value: string | null) =>
      rows("route envelope", "SELECT route_context_json FROM session_conversations", [
        { route_context_json: value },
      ]);
    await execute("UPDATE session_conversations SET first_seen_at = 2");
    await envelope("old-envelope");
    // SQLite UPDATE OF tests column presence, so even a watched no-op invalidates.
    await execute("UPDATE session_conversations SET last_seen_at = last_seen_at");
    await envelope(null);
    await execute("UPDATE session_conversations SET role = role");
    await envelope(null);
    await execute("UPDATE session_conversations SET route_context_json = 'old-envelope'");
    await execute("UPDATE session_conversations SET role = 'related'");
    await envelope(null);
    await execute(
      "UPDATE session_conversations SET last_seen_at = 3, route_context_json = 'new-envelope'",
    );
    await envelope("new-envelope");
    await execute(
      "UPDATE session_conversations SET last_seen_at = 4, route_context_json = 'new-envelope'",
    );
    await envelope(null);
    await execute("DELETE FROM conversations WHERE conversation_id = 'route-conversation'");
    await rows("route cascade", "SELECT count(*) AS count FROM session_conversations", [
      { count: 0 },
    ]);
    await rows("conversation SET NULL", "SELECT primary_conversation_id FROM session_windows", [
      { primary_conversation_id: null },
    ]);

    await execute(
      "INSERT INTO memory_index_sources(id, path, hash, mtime, size) VALUES (1, 'a', 'hash', 0, 0), (2, 'b', 'hash', 0, 0)",
    );
    await execute(
      "INSERT INTO memory_index_chunks(chunk_rowid, id, path, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (1, 'chunk-1', 'a', 1, 2, 'hash', 'test', 'synthetic', ?, 1), (2, 'chunk-2', 'a', 1, 2, 'hash', 'test', 'synthetic', ?, 1), (3, 'chunk-3', 'a', 1, 2, 'hash', 'test', 'synthetic', ?, 1)",
      [Buffer.from([1]), Buffer.from([1]), Buffer.from([1])],
    );
    await execute("UPDATE memory_index_sources SET hash = hash");
    await execute("UPDATE memory_index_chunks SET text = text");
    await execute("UPDATE memory_index_sources SET id = 3, path = 'moved' WHERE id = 2");
    await execute("DELETE FROM memory_index_sources WHERE id = 1");
    await insert("memory_index_chunk_recall_metadata", { chunk_id: "chunk-1", importance: 5 });
    await insert("memory_index_chunk_provenance", {
      chunk_id: "chunk-1",
      origin_class: "owner",
      session_kind: "interactive",
      observed_at: 1,
    });
    await execute("DELETE FROM memory_index_chunks WHERE id = 'chunk-1'");
    for (const table of ["memory_index_chunk_recall_metadata", "memory_index_chunk_provenance"]) {
      await rows("chunk child cascade", `SELECT count(*) AS count FROM ${table}`, [{ count: 0 }]);
    }
    await transaction("BEGIN");
    await execute("UPDATE memory_index_sources SET size = 4");
    await execute("DELETE FROM memory_index_chunks");
    await transaction("ROLLBACK");
    await rows(
      "memory rollback restored chunks",
      "SELECT count(*) AS count FROM memory_index_chunks",
      [{ count: 2 }],
    );
    await execute("DELETE FROM memory_index_sources");
    await execute("DELETE FROM memory_index_chunks");
    await rows(
      "memory revisions belong to the batch writer",
      "SELECT revision FROM memory_index_state WHERE id = 1",
      [{ revision: 0 }],
    );

    const conversation = (id: string, parent: SQLInputValue, thread: SQLInputValue) => [
      id,
      parent,
      thread,
    ];
    const conversationSql =
      "INSERT INTO conversations(conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at, parent_conversation_id, thread_id) VALUES (?, 'identity', 'test', 'direct', 'same-peer', 'test', 1, 1, ?, ?)";
    await execute(conversationSql, conversation("identity-null", null, null));
    for (const [parent, thread] of [
      ["", null],
      [null, ""],
      ["", ""],
    ]) {
      await reject(
        "NULL equals empty identity",
        conversationSql,
        conversation("identity-duplicate", parent!, thread!),
      );
    }
    await execute(conversationSql, conversation("identity-parent", "parent", null));
    await execute(conversationSql, conversation("identity-thread", null, "thread"));
    await rows("distinct identity components", "SELECT count(*) AS count FROM conversations", [
      { count: 3 },
    ]);

    const warmSql =
      "INSERT INTO session_transcript_archives(session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES ('archive', ?, 'route', 'deleted', 'identity', ?, ?, ?, 1)";
    const coldSql =
      "INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage) VALUES ('route-window', 'generation', ?, ?, 1, 0, 0, 1, 1, 'file')";
    const digest = "a".repeat(64);
    for (const name of ["archive.deleted", "", ".", "..", "safe_é"]) {
      await execute(warmSql, [name, Buffer.from([1]), digest, name]);
    }
    for (const name of ["../escape", "dir/file", "dir\\file"]) {
      await reject("warm archive path guard", warmSql, [name, Buffer.from([1]), digest, name]);
    }
    for (const name of ["", ".", "..", "../escape", "dir/file", "dir\\file"]) {
      await reject("cold archive path guard", coldSql, [name, digest]);
    }
    await execute(coldSql, ["archive.cold", digest]);

    const navigation = {
      version: 1,
      report: { kind: "canonical" },
      navigation: {},
      reset: {},
      model: {},
      modelBytes: 0,
      modelWithoutCheckpointBytes: 4194304,
      withoutCustomDataBytes: 2,
    };
    const navigationSql =
      "INSERT INTO transcript_events(session_id, seq, event_json, created_at, navigation_json) VALUES ('route-window', ?, '{}', 1, ?)";
    let seq = 0;
    await transaction("BEGIN");
    await client.query("SET LOCAL track_functions = 'all'");
    const navigationCalls = async () =>
      (
        await client.query<{ calls: number }>(
          "SELECT coalesce(sum(calls), 0)::integer AS calls FROM pg_stat_xact_user_functions WHERE funcid = 'openclaw_transcript_navigation_check(text)'::regprocedure",
        )
      ).rows[0]!.calls;
    await execute(navigationSql, [++seq, null]);
    assert.equal(await navigationCalls(), 0, "absent navigation must not invoke JSON validation");
    await execute(navigationSql, [++seq, JSON.stringify(navigation)]);
    assert.equal(
      await navigationCalls(),
      1,
      "present navigation must still invoke JSON validation",
    );
    await transaction("COMMIT");
    for (const value of [
      JSON.stringify({ ...navigation, report: { kind: "leaf" } }),
      JSON.stringify(navigation).replace('"version":1', '"version":1,"version":2'),
      JSON.stringify(navigation).replace(
        '"kind":"canonical"',
        '"kind":"canonical","kind":"invalid"',
      ),
    ]) {
      await execute(navigationSql, [++seq, value]);
    }
    // PostgreSQL 18 can reject malformed JSON before evaluating the CHECK.
    await reject(
      "malformed navigation JSON",
      navigationSql,
      [++seq, "{"],
      /check constraint|invalid input syntax for type json/i,
    );
    const invalidNavigation = [
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...navigation, report: { kind: "invalid" } }),
      JSON.stringify({ ...navigation, version: true }),
      JSON.stringify({ ...navigation, version: "1" }),
      JSON.stringify({ ...navigation, modelBytes: -1 }),
      JSON.stringify({ ...navigation, withoutCustomDataBytes: 4194305 }),
      JSON.stringify({ ...navigation, model: [] }),
      JSON.stringify({ ...navigation, reset: null }),
      JSON.stringify({ ...navigation, navigation: false }),
      JSON.stringify({ ...navigation, modelBytes: "0" }),
      JSON.stringify(navigation).replace('"version":1', '"version":1.0'),
      JSON.stringify(navigation).replace('"version":1', '"version":1e0'),
      JSON.stringify(navigation).replace('"modelBytes":0', '"modelBytes":0.0'),
      JSON.stringify(navigation).replace('"version":1', '"version":2,"version":1'),
      JSON.stringify(navigation).replace(
        '"kind":"canonical"',
        '"kind":"invalid","kind":"canonical"',
      ),
      JSON.stringify({ ...navigation, padding: "é".repeat(8192) }),
      ...Object.keys(navigation).map((omitted) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(navigation).filter(([key]) => key !== omitted)),
        ),
      ),
    ];
    for (const value of invalidNavigation) {
      await reject("navigation CHECK", navigationSql, [++seq, value]);
    }
    await rows("navigation accepted rows", "SELECT count(*) AS count FROM transcript_events", [
      { count: 5 },
    ]);

    const voiceScope = "talk-client-voice-sessions";
    for (const [key, value] of Object.entries({
      client: { agentId: "agent", sessionKey: "session", origin: "client", status: "open" },
      relay: { agentId: "agent", sessionKey: "session", origin: "relay", status: "open" },
      closed: { agentId: "agent", sessionKey: "session", origin: "client", status: "closed" },
      other: { agentId: "other", sessionKey: "session", origin: "client", status: "open" },
    })) {
      await insert("cache_entries", {
        scope: voiceScope,
        key,
        value_json: JSON.stringify(value),
        updated_at: 1,
      });
    }
    for (const [index, status] of [true, 1, "1", null].entries()) {
      await insert("cache_entries", {
        scope: voiceScope,
        key: `wrong-status-${index}`,
        value_json: JSON.stringify({
          agentId: "agent",
          sessionKey: "session",
          origin: "client",
          status,
        }),
        updated_at: 1,
      });
    }
    // Invalid/scalar JSON can exist in other cache scopes; index evaluation must remain safe.
    for (const [key, value] of [
      ["invalid", "{"],
      ["scalar", "true"],
      ["null", null],
    ]) {
      await insert("cache_entries", {
        scope: "other",
        key: key!,
        value_json: value!,
        updated_at: 1,
      });
    }
    for (const index of [
      "idx_agent_voice_session_open_scope",
      "idx_agent_voice_session_open_updated",
    ]) {
      const definition = (
        await client.query(
          "SELECT pg_get_expr(indpred, indrelid) AS predicate FROM pg_index WHERE indexrelid = $1::regclass",
          [index],
        )
      ).rows[0];
      const predicate =
        "scope = 'talk-client-voice-sessions' AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open'";
      await rows(
        "voice open predicate",
        `SELECT key FROM cache_entries WHERE ${predicate} ORDER BY key`,
        [{ key: "client" }, { key: "other" }, { key: "relay" }],
        `SELECT key FROM cache_entries WHERE ${definition.predicate} ORDER BY key`,
      );
    }
    const expressions = [];
    for (let column = 1; column <= 3; column++) {
      expressions.push(
        (
          await client.query(
            "SELECT pg_get_indexdef('idx_agent_voice_session_open_scope'::regclass, $1, true) AS expression",
            [column],
          )
        ).rows[0].expression,
      );
    }
    const sqliteExpressions = ["agentId", "sessionKey", "origin"].map(
      (name) => `CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.${name}') END`,
    );
    await rows(
      "voice indexed keys",
      `SELECT key, ${sqliteExpressions.map((expression, i) => `${expression} AS key${i}`).join(", ")} FROM cache_entries WHERE key IN ('client', 'closed', 'other', 'relay') ORDER BY key`,
      [
        { key: "client", key0: "agent", key1: "session", key2: "client" },
        { key: "closed", key0: "agent", key1: "session", key2: "client" },
        { key: "other", key0: "other", key1: "session", key2: "client" },
        { key: "relay", key0: "agent", key1: "session", key2: "relay" },
      ],
      `SELECT key, ${expressions.map((expression, i) => `${expression} AS key${i}`).join(", ")} FROM cache_entries WHERE key IN ('client', 'closed', 'other', 'relay') ORDER BY key`,
    );
    for (const member of ["agentId", "sessionKey", "origin"]) {
      for (const [index, value] of [true, 1, "1", null, {}, []].entries()) {
        await insert("cache_entries", {
          scope: voiceScope,
          key: `wrong-${member}-${index}`,
          value_json: JSON.stringify({
            agentId: "agent",
            sessionKey: "session",
            origin: "client",
            status: "open",
            [member]: value,
          }),
          updated_at: 1,
        });
      }
    }
    const keyValues = ["agent", "session", "client"];
    await rows(
      "voice consuming string predicates",
      `SELECT key FROM cache_entries WHERE scope = 'talk-client-voice-sessions' AND ${sqliteExpressions.map((expression, i) => `${expression} = '${keyValues[i]}'`).join(" AND ")} AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open' ORDER BY key`,
      [{ key: "client" }],
      `SELECT key FROM cache_entries WHERE scope = 'talk-client-voice-sessions' AND ${expressions.map((expression, i) => `${expression} = '${keyValues[i]}'`).join(" AND ")} AND CASE WHEN value_json IS JSON THEN value_json::json ->> 'status' END = 'open' ORDER BY key`,
    );
    await insert("trajectory_runtime_events", {
      session_id: "route-window",
      seq: 1,
      run_id: "run",
      event_json: JSON.stringify("é🦞"),
      created_at: 1,
    });
    const byteExpression = (
      await client.query(
        "SELECT pg_get_indexdef('idx_agent_trajectory_runtime_run'::regclass, 4, true) AS expression",
      )
    ).rows[0].expression;
    await rows(
      "UTF-8 byte-length index",
      "SELECT octet_length(event_json) AS bytes FROM trajectory_runtime_events",
      [{ bytes: 8 }],
      `SELECT ${byteExpression} AS bytes FROM trajectory_runtime_events`,
    );
    console.log(
      "agent: SQLite/PostgreSQL trigger parity (4 triggers, no-op/key move/bulk/cascade/rollback) and translated index/CHECK behavior verified",
    );
  } finally {
    sqlite.close();
  }
}
