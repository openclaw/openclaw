import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDoltStoreSchema } from "../../../src/context-engine/dolt/store/schema.js";
import { createDoltReadOnlyQueryRuntime } from "./read-only-dolt-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

async function createStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dolt-context-tools-"));
  tempDirs.push(dir);
  return dir;
}

function createWritableDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  ensureDoltStoreSchema(db);
  return db;
}

describe("createDoltReadOnlyQueryRuntime", () => {
  it("returns graceful fallbacks when dolt.db does not exist", async () => {
    const stateDir = await createStateDir();
    const runtime = createDoltReadOnlyQueryRuntime({ resolveStateDir: () => stateDir });
    const queries = runtime.forContext({});

    expect(queries.getAvailability()).toEqual({
      available: false,
      dbPath: path.join(stateDir, "dolt.db"),
      reason: "missing_db",
    });
    expect(queries.getRecord("turn:missing")).toBeNull();
    expect(queries.listDirectChildren("leaf:missing")).toEqual([]);
    expect(queries.listDirectChildRecords("leaf:missing")).toEqual([]);
    expect(queries.listActiveLane("session-1", "turn", true)).toEqual([]);
    expect(queries.getGhostSummary("bindle:missing")).toBeNull();
    expect(
      queries.searchTurnPayloads({
        sessionId: "session-1",
        pattern: "hello",
      }),
    ).toEqual([]);

    runtime.dispose();
  });

  it("reads Dolt tables through the shared helper API", async () => {
    const stateDir = await createStateDir();
    const dbPath = path.join(stateDir, "dolt.db");
    const db = createWritableDb(dbPath);

    db.prepare(
      `
        INSERT INTO dolt_records (
          pointer,
          session_id,
          session_key,
          level,
          event_ts_ms,
          token_count,
          token_count_method,
          payload_json,
          finalized_at_reset,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "bindle:session-1:100:1",
      "session-1",
      null,
      "bindle",
      100,
      42,
      "estimateTokens",
      JSON.stringify({ summary: "bindle summary" }),
      0,
      100,
      100,
    );

    db.prepare(
      `
        INSERT INTO dolt_records (
          pointer,
          session_id,
          session_key,
          level,
          event_ts_ms,
          token_count,
          token_count_method,
          payload_json,
          finalized_at_reset,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "leaf:session-1:100:1",
      "session-1",
      null,
      "leaf",
      110,
      21,
      "estimateTokens",
      JSON.stringify({ summary: "leaf summary" }),
      0,
      110,
      110,
    );

    db.prepare(
      `
        INSERT INTO dolt_records (
          pointer,
          session_id,
          session_key,
          level,
          event_ts_ms,
          token_count,
          token_count_method,
          payload_json,
          finalized_at_reset,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "turn:session-1:100:1",
      "session-1",
      null,
      "turn",
      120,
      12,
      "estimateTokens",
      JSON.stringify({ role: "assistant", content: "hello world" }),
      0,
      120,
      120,
    );

    db.prepare(
      `
        INSERT INTO dolt_lineage (
          parent_pointer,
          child_pointer,
          child_index,
          child_level,
          created_at_ms
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run("bindle:session-1:100:1", "leaf:session-1:100:1", 0, "leaf", 130);

    db.prepare(
      `
        INSERT INTO dolt_lineage (
          parent_pointer,
          child_pointer,
          child_index,
          child_level,
          created_at_ms
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run("leaf:session-1:100:1", "turn:session-1:100:1", 0, "turn", 140);

    db.prepare(
      `
        INSERT INTO dolt_active_lane (
          session_id,
          session_key,
          level,
          pointer,
          is_active,
          last_event_ts_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run("session-1", null, "turn", "turn:session-1:100:1", 1, 120, 140);

    db.close();

    const runtime = createDoltReadOnlyQueryRuntime({ resolveStateDir: () => stateDir });
    runtime.warmup();
    const queries = runtime.forContext({});

    expect(queries.getAvailability().available).toBe(true);

    const leaf = queries.getRecord("leaf:session-1:100:1");
    expect(leaf?.level).toBe("leaf");

    const bindleChildren = queries.listDirectChildren("bindle:session-1:100:1");
    expect(bindleChildren.map((row) => row.childPointer)).toEqual(["leaf:session-1:100:1"]);

    const leafChildren = queries.listDirectChildRecords("leaf:session-1:100:1");
    expect(leafChildren.map((row) => row.pointer)).toEqual(["turn:session-1:100:1"]);

    const lane = queries.listActiveLane("session-1", "turn", true);
    expect(lane.map((row) => row.pointer)).toEqual(["turn:session-1:100:1"]);

    const allMatches = queries.searchTurnPayloads({
      sessionId: "session-1",
      pattern: "hello",
    });
    expect(allMatches.map((row) => row.pointer)).toEqual(["turn:session-1:100:1"]);

    const scopedToLeaf = queries.searchTurnPayloads({
      sessionId: "session-1",
      parentPointer: "leaf:session-1:100:1",
      pattern: "world",
    });
    expect(scopedToLeaf.map((row) => row.pointer)).toEqual(["turn:session-1:100:1"]);

    const scopedToBindle = queries.searchTurnPayloads({
      sessionId: "session-1",
      parentPointer: "bindle:session-1:100:1",
      pattern: "world",
    });
    expect(scopedToBindle.map((row) => row.pointer)).toEqual(["turn:session-1:100:1"]);

    // Optional table in future work; missing table should not throw.
    expect(queries.getGhostSummary("bindle:session-1:100:1")).toBeNull();

    runtime.dispose();
  });

  it("reads ghost summary rows when table exists", async () => {
    const stateDir = await createStateDir();
    const dbPath = path.join(stateDir, "dolt.db");
    const db = createWritableDb(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS dolt_ghost_summaries (
        bindle_pointer TEXT PRIMARY KEY,
        summary_text TEXT,
        token_count INTEGER
      )
    `);
    db.prepare(
      `
        INSERT INTO dolt_ghost_summaries (bindle_pointer, summary_text, token_count)
        VALUES (?, ?, ?)
      `,
    ).run("bindle:session-1:100:1", "ghost summary", 17);
    db.close();

    const runtime = createDoltReadOnlyQueryRuntime({ resolveStateDir: () => stateDir });
    const queries = runtime.forContext({});

    expect(queries.getGhostSummary("bindle:session-1:100:1")).toEqual(
      expect.objectContaining({
        bindlePointer: "bindle:session-1:100:1",
        summaryText: "ghost summary",
        tokenCount: 17,
      }),
    );

    runtime.dispose();
  });
});
