// Durable conversational-memory store tests (STORE-01/02): immutable turns with
// gapless idempotent seq, span/box metadata, and durability across transcript GC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupArchivedSessionTranscripts } from "../../gateway/session-transcript-files.fs.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  appendTurns,
  getTurns,
  listBoxes,
  listSpans,
  setBoxState,
  upsertBox,
  upsertSpan,
  type NewTurn,
} from "./turns-store.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-turns-store-"));
}

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(idempotencyKey: string, content: string, overrides: Partial<NewTurn> = {}): NewTurn {
  return {
    role: "user",
    content,
    contentHash: `hash-${idempotencyKey}`,
    idempotencyKey,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("turns-store", () => {
  it("assigns gapless monotonic seq and reads turns in order (STORE-01)", () => {
    const s = scope(createTempStateDir());
    const inserted = appendTurns({
      ...s,
      turns: [turn("k1", "first"), turn("k2", "second", { role: "assistant" })],
    });
    expect(inserted).toBe(2);

    const rows = getTurns(s);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.map((r) => r.content)).toEqual(["first", "second"]);
    expect(rows[1]?.role).toBe("assistant");
  });

  it("is idempotent by idempotency_key and never leaves seq gaps on replay (STORE-01)", () => {
    const s = scope(createTempStateDir());
    appendTurns({ ...s, turns: [turn("k1", "first"), turn("k2", "second")] });

    // Replay the same turn plus one genuinely new turn.
    const inserted = appendTurns({
      ...s,
      turns: [turn("k1", "first"), turn("k2", "second"), turn("k3", "third")],
    });
    expect(inserted).toBe(1);

    const rows = getTurns(s);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.idempotency_key)).toEqual(["k1", "k2", "k3"]);
  });

  it("bounds reads by seq range", () => {
    const s = scope(createTempStateDir());
    appendTurns({ ...s, turns: [turn("k1", "a"), turn("k2", "b"), turn("k3", "c")] });
    expect(getTurns({ ...s, startSeq: 2, endSeq: 2 }).map((r) => r.content)).toEqual(["b"]);
  });

  it("flips box state without touching turns (STORE-02)", () => {
    const s = scope(createTempStateDir());
    appendTurns({ ...s, turns: [turn("k1", "a")] });
    upsertBox({ ...s, box: { boxId: "box-1", sessionKey: s.sessionKey, label: "voice setup" } });

    expect(listBoxes(s)[0]?.state).toBe("live");
    setBoxState({ ...s, boxId: "box-1", state: "collapsed" });
    expect(listBoxes(s)[0]?.state).toBe("collapsed");
    // turns are untouched by the state flip
    expect(getTurns(s).map((r) => r.content)).toEqual(["a"]);
  });

  it("stores spans ordered by start_seq with box assignment", () => {
    const s = scope(createTempStateDir());
    upsertSpan({
      ...s,
      span: { spanId: "span-2", sessionKey: s.sessionKey, startSeq: 5, endSeq: 6 },
    });
    upsertSpan({
      ...s,
      span: { spanId: "span-1", sessionKey: s.sessionKey, startSeq: 1, endSeq: 3, boxId: "box-1" },
    });
    const spans = listSpans(s);
    expect(spans.map((sp) => sp.span_id)).toEqual(["span-1", "span-2"]);
    expect(spans[0]?.box_id).toBe("box-1");
  });

  it("keeps turns after archived transcript GC runs (STORE-01 durability)", async () => {
    const stateDir = createTempStateDir();
    const s = scope(stateDir);
    appendTurns({ ...s, turns: [turn("k1", "durable")] });

    // A stale archived transcript in a separate transcript dir, eligible for GC.
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcripts-"));
    const archived = path.join(transcriptDir, "session.jsonl.deleted.2020-01-01T00-00-00.000Z");
    fs.writeFileSync(archived, "{}\n");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [transcriptDir],
      olderThanMs: 1,
      reason: "deleted",
      nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(archived)).toBe(false);

    // Turns live in the per-agent DB, untouched by transcript GC.
    expect(getTurns(s).map((r) => r.content)).toEqual(["durable"]);
  });
});
