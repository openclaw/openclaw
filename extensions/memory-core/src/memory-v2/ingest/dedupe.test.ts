import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryRefId } from "../ref.js";
import { upsertRecord } from "../sidecar-repo.js";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import { DEFAULT_JACCARD_THRESHOLD, findLexicalDuplicate, upsertIngestText } from "./dedupe.js";
import { ensureIngestSchema } from "./ingest-schema.js";
import { normalizeForMatch } from "./normalize.js";
import { synthesizeConversationRef } from "./synthetic-ref.js";

function seed(
  db: DatabaseSync,
  text: string,
  opts: { memoryType?: string; sessionId?: string; messageIndex?: number; now?: number } = {},
): string {
  const memoryType = opts.memoryType ?? "preference";
  const sessionId = opts.sessionId ?? "s";
  const messageIndex = opts.messageIndex ?? 0;
  const now = opts.now ?? 1000;
  const ref = synthesizeConversationRef({
    sessionId,
    messageIndex,
    candidateText: text,
  });
  upsertRecord(
    db,
    ref,
    {
      memoryType,
      importance: 0.5,
      salience: 0.5,
      confidence: 0.6,
      status: "active",
      sourceKind: "conversation",
      sourceRef: `${sessionId}:${messageIndex}`,
      lastSeenAt: now,
    },
    now,
  );
  const refId = memoryRefId(ref);
  upsertIngestText(db, refId, normalizeForMatch(text));
  return refId;
}

describe("findLexicalDuplicate", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
    ensureIngestSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when no rows of that type exist", () => {
    expect(
      findLexicalDuplicate({
        db,
        memoryType: "preference",
        candidateText: "i prefer dark mode",
        now: 2000,
      }),
    ).toBeNull();
  });

  it("matches a near-paraphrase above threshold", () => {
    const seeded = seed(db, "i prefer dark mode in the editor", { now: 2000 });
    const match = findLexicalDuplicate({
      db,
      memoryType: "preference",
      candidateText: "i prefer dark mode in editor",
      now: 2000,
    });
    expect(match?.refId).toBe(seeded);
    expect(match?.similarity ?? 0).toBeGreaterThanOrEqual(DEFAULT_JACCARD_THRESHOLD);
  });

  it("does not match a semantically distinct sentence", () => {
    seed(db, "i prefer dark mode in the editor", { now: 2000 });
    const match = findLexicalDuplicate({
      db,
      memoryType: "preference",
      candidateText: "i hate the new build pipeline",
      now: 2000,
    });
    expect(match).toBeNull();
  });

  it("ignores rows of a different memory_type", () => {
    seed(db, "i prefer dark mode", { memoryType: "preference", now: 2000 });
    const match = findLexicalDuplicate({
      db,
      memoryType: "todo",
      candidateText: "i prefer dark mode",
      now: 2000,
    });
    expect(match).toBeNull();
  });

  it("ignores rows outside the lookback window", () => {
    seed(db, "i prefer dark mode", { now: 1000 });
    const match = findLexicalDuplicate({
      db,
      memoryType: "preference",
      candidateText: "i prefer dark mode",
      now: 1000 + 30 * 24 * 60 * 60 * 1000,
    });
    expect(match).toBeNull();
  });

  it("falls back to no match when the candidate pool overflows the scan cap", () => {
    for (let i = 0; i < 10; i++) {
      seed(db, `i prefer thing number ${i}`, { messageIndex: i, now: 2000 + i });
    }
    const match = findLexicalDuplicate({
      db,
      memoryType: "preference",
      candidateText: "i prefer thing number 3",
      now: 3000,
      options: { scanCap: 5 },
    });
    expect(match).toBeNull();
  });

  it("picks the highest-similarity match among multiple candidates", () => {
    const closer = seed(db, "i prefer dark mode in the editor", {
      messageIndex: 0,
      now: 2000,
    });
    seed(db, "i prefer something completely different", { messageIndex: 1, now: 2001 });
    const match = findLexicalDuplicate({
      db,
      memoryType: "preference",
      candidateText: "i prefer dark mode in editor",
      now: 2002,
    });
    expect(match?.refId).toBe(closer);
  });
});
