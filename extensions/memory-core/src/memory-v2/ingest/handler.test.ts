import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import { findLastUserText, runIngest } from "./handler.js";

const userMessage = (text: string) => ({ role: "user", content: text });
const assistantMessage = (text: string) => ({ role: "assistant", content: text });

function fixedClock(t: number) {
  return () => t;
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureSidecarSchema(db);
  return db;
}

function countRows(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_v2_records`).get() as { n: number }).n;
}

describe("findLastUserText", () => {
  it("returns the last user message text", () => {
    const out = findLastUserText([
      userMessage("hello"),
      assistantMessage("hi"),
      userMessage("my name is Alex"),
    ]);
    expect(out?.text).toBe("my name is Alex");
    expect(out?.index).toBe(2);
  });

  it("returns null when there is no user message", () => {
    expect(findLastUserText([assistantMessage("hi")])).toBeNull();
  });

  it("ignores non-user trailing messages", () => {
    const out = findLastUserText([userMessage("first"), assistantMessage("reply")]);
    expect(out?.text).toBe("first");
    expect(out?.index).toBe(0);
  });

  it("handles content blocks of {type:'text', text}", () => {
    const out = findLastUserText([
      {
        role: "user",
        content: [
          { type: "image", source: {} },
          { type: "text", text: "I prefer dark mode" },
        ],
      },
    ]);
    expect(out?.text).toBe("I prefer dark mode");
  });

  it("tolerates malformed entries silently", () => {
    expect(findLastUserText([null, undefined, 42, "string", {}])).toBeNull();
  });
});

describe("runIngest", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("short-circuits on a failed turn", () => {
    const out = runIngest(
      { messages: [userMessage("my name is Alex")], success: false },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    expect(out.skippedReason).toBe("turn_failed");
    expect(countRows(db)).toBe(0);
  });

  it("short-circuits when sessionId is missing", () => {
    const out = runIngest(
      { messages: [userMessage("my name is Alex")], success: true },
      {},
      { db, now: fixedClock(1000) },
    );
    expect(out.skippedReason).toBe("no_session_id");
    expect(countRows(db)).toBe(0);
  });

  it("short-circuits when there is no user text", () => {
    const out = runIngest(
      { messages: [assistantMessage("hi")], success: true },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    expect(out.skippedReason).toBe("no_user_text");
    expect(countRows(db)).toBe(0);
  });

  it("inserts an identity candidate from a single user message", () => {
    const out = runIngest(
      { messages: [userMessage("Hi, my name is Alex.")], success: true },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    expect(out.inserted).toBe(1);
    expect(out.deduped).toBe(0);
    expect(countRows(db)).toBe(1);
    const row = db
      .prepare(
        `SELECT memory_type, source_kind, source_ref, status, location_id FROM memory_v2_records`,
      )
      .get() as {
      memory_type: string;
      source_kind: string;
      source_ref: string;
      status: string;
      location_id: string | null;
    };
    expect(row.memory_type).toBe("identity");
    expect(row.source_kind).toBe("conversation");
    expect(row.source_ref).toBe("s:0");
    expect(row.status).toBe("active");
    expect(row.location_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not extract from assistant text", () => {
    const out = runIngest(
      {
        messages: [
          userMessage("hello"),
          assistantMessage("My name is Claude. I prefer dark mode."),
        ],
        success: true,
      },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    // 'hello' yields no candidates.
    expect(out.candidatesConsidered).toBe(0);
    expect(countRows(db)).toBe(0);
  });

  it("dedupes a repeated identical turn (Stage A: same synthetic ref)", () => {
    const event = { messages: [userMessage("My name is Alex")], success: true };
    runIngest(event, { sessionId: "s" }, { db, now: fixedClock(1000) });
    const second = runIngest(event, { sessionId: "s" }, { db, now: fixedClock(2000) });
    expect(second.inserted).toBe(0);
    expect(second.deduped).toBe(1);
    expect(countRows(db)).toBe(1);
    const row = db.prepare(`SELECT last_seen_at FROM memory_v2_records`).get() as {
      last_seen_at: number;
    };
    expect(row.last_seen_at).toBe(2000);
  });

  it("dedupes a paraphrase from a different turn (Stage B: lexical)", () => {
    runIngest(
      { messages: [userMessage("I prefer dark mode in the editor.")], success: true },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    const second = runIngest(
      { messages: [userMessage("I prefer dark mode in editor.")], success: true },
      { sessionId: "s2" },
      { db, now: fixedClock(2000) },
    );
    expect(second.inserted).toBe(0);
    expect(second.deduped).toBe(1);
    expect(countRows(db)).toBe(1);
  });

  it("filters secret-shaped candidate text", () => {
    const out = runIngest(
      {
        messages: [userMessage("I prefer this token: sk-AbCdEfGhIjKlMnOp1234 for testing")],
        success: true,
      },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    expect(out.filteredAsSecret).toBeGreaterThan(0);
    expect(out.inserted).toBe(0);
    expect(countRows(db)).toBe(0);
  });

  it("inserts multiple distinct candidates from one turn", () => {
    const out = runIngest(
      {
        messages: [
          userMessage("My name is Alex. I prefer dark mode. Remind me to ship the release."),
        ],
        success: true,
      },
      { sessionId: "s" },
      { db, now: fixedClock(1000) },
    );
    expect(out.inserted).toBe(3);
    expect(countRows(db)).toBe(3);
    const types = (
      db.prepare(`SELECT memory_type FROM memory_v2_records ORDER BY memory_type`).all() as Array<{
        memory_type: string;
      }>
    ).map((r) => r.memory_type);
    expect(types).toEqual(["identity", "preference", "todo"]);
  });

  it("tolerates malformed messages without throwing", () => {
    expect(() =>
      runIngest(
        { messages: [null, 42, { role: "user", content: 123 }, {}], success: true },
        { sessionId: "s" },
        { db, now: fixedClock(1000) },
      ),
    ).not.toThrow();
    expect(countRows(db)).toBe(0);
  });
});
