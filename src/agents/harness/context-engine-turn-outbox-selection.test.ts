import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { ensureContextEngineTurnOutboxSchema } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import { executeContextEngineTurnOutboxCommand } from "./context-engine-turn-outbox.kernel.worker.js";

it("selects ready session heads without overtaking unresolved work or crossing owners", () => {
  const database = openNodeSqliteDatabase(":memory:");
  try {
    ensureContextEngineTurnOutboxSchema(database);
    const insert = database.prepare(`
      INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, owner_plugin_id, session_id, payload_json, payload_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const enqueue = (
      key: string,
      session: string,
      state: string | null,
      engine = "test",
      owner: string | null = "plugin",
    ) => insert.run(key, engine, owner, session, JSON.stringify({ state }), state, 1);
    for (const state of ["admitted", "accepted", null]) {
      const session = `unresolved-${state}`;
      enqueue(`${session}-head`, session, state);
      enqueue(`${session}-tail`, session, "ready");
    }
    enqueue("other-plugin", "ready-first", "admitted", "test", "other");
    enqueue("other-engine", "ready-first", "admitted", "other");
    enqueue("unowned", "ready-first", "admitted", "test", null);
    enqueue("blocked-audit", "ready-first", "blocked");
    enqueue("z-ready-first", "ready-first", "ready");
    enqueue("a-ready-second", "ready-second", "ready");
    enqueue("later-same-session", "ready-first", "ready");
    const list = (limit: number, sessionId?: string, ownerPluginId: string | null = "plugin") =>
      executeContextEngineTurnOutboxCommand(database, {
        type: "listPendingSessions",
        input: { engineId: "test", ownerPluginId: ownerPluginId ?? undefined, limit, sessionId },
      });

    expect(list(16)).toEqual(["ready-first", "ready-second"]);
    expect(list(1)).toEqual(["ready-first"]);
    expect(list(0)).toEqual([]);
    expect(list(16, "ready-second")).toEqual(["ready-second"]);
    expect(list(16, "unresolved-admitted")).toEqual([]);
    expect(list(16, undefined, null)).toEqual([]);
    expect(
      executeContextEngineTurnOutboxCommand(database, {
        type: "hasPending",
        input: { engineId: "test", ownerPluginId: "plugin", sessionId: "unresolved-admitted" },
      }),
    ).toBe(true);
    expect(
      executeContextEngineTurnOutboxCommand(database, {
        type: "readNextPending",
        input: { engineId: "test", ownerPluginId: "plugin", sessionId: "unresolved-admitted" },
      }),
    ).toMatchObject({ advancement_key: "unresolved-admitted-head" });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM context_engine_turn_outbox").get(),
    ).toEqual({ count: 13 });
  } finally {
    database.close();
  }
});
