import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryDB } from "./database.js";
import { MemoryTracer } from "./tracer.js";

describe("Database Stability", () => {
  const dbPath = join(tmpdir(), `memory-stability-${Date.now()}`);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  const tracer = new MemoryTracer();

  beforeEach(async () => {
    try {
      await rm(dbPath, { recursive: true, force: true });
    } catch {}
    await mkdir(dbPath, { recursive: true });
  });

  test("Should maintain stable UUIDs during recall flush", async () => {
    const db = new MemoryDB(dbPath, 3, tracer, logger);
    const entry = await db.store({
      text: "Vova likes pizza",
      vector: [0.1, 0.2, 0.3],
      importance: 0.9,
      category: "preference",
      summary: "User likes pizza",
      happenedAt: null,
      validUntil: null,
      emotionalTone: "neutral",
      emotionScore: 0,
    });

    const originalId = entry.id;
    expect(originalId).toBeDefined();

    // Trigger recall increment
    db.incrementRecallCount([originalId]);
    expect(db.pendingRecallFlushCount).toBe(1);

    // Flush
    const flushed = await db.flushRecallCounts();
    expect(flushed).toBe(1);

    // Reload from DB and check ID
    const updated = await db.getById(originalId);
    expect(updated, "Memory should still be accessible by original ID").not.toBeNull();
    expect(updated?.id).toBe(originalId);
    expect(updated?.recallCount).toBe(1);

    // Ensure no duplicates exist (since the old one should be gone or updated)
    const all = await db.listAll();
    const matches = all.filter((e) => e.text === "Vova likes pizza");
    expect(matches.length).toBe(1);
  });
});
