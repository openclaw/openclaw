import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const memoryIndex = await import("./index.js");

type IndexedRow = {
  id: string;
  chunkRowid: number;
  startLine: number;
  endLine: number;
  updatedAt: number;
  embedded: number;
  observedAt: number;
};

describe("memory file delta publication", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  const notesPath = "memory/delta-notes.md";
  const line = (index: number) =>
    `Entry ${index} marker${index} ${"lorem ipsum dolor sit amet ".repeat(3)}`.trim();
  const body = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, offset) => line(from + offset));

  async function writeNotes(lines: string[], mtimeMs: number) {
    const file = path.join(fixture.paths.workspace, notesPath);
    await fs.writeFile(file, lines.join("\n"));
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  function readIndex(database: DatabaseSync) {
    return {
      chunks: database
        .prepare(
          `SELECT chunk.id, chunk.chunk_rowid AS chunkRowid, chunk.start_line AS startLine,
                  chunk.end_line AS endLine, chunk.updated_at AS updatedAt,
                  length(chunk.embedding) > 0 AS embedded,
                  provenance.observed_at AS observedAt
           FROM memory_index_chunks AS chunk
           JOIN memory_index_chunk_provenance AS provenance ON provenance.chunk_id = chunk.id
           WHERE chunk.path = ? AND chunk.source = 'memory'
           ORDER BY chunk.start_line, chunk.id`,
        )
        .all(notesPath) as IndexedRow[],
      fts: (
        database
          .prepare("SELECT id FROM memory_index_chunks_fts WHERE path = ? ORDER BY id")
          .all(notesPath) as Array<{ id: string }>
      ).map((row) => row.id),
    };
  }

  it.each([
    { mode: "keyword-only", semantic: false },
    { mode: "semantic with rebuild debt", semantic: true },
  ])("publishes appends as a delta and replaces shifted files ($mode)", async ({ semantic }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mtimes = [1_700_000_000_000, 1_700_000_100_000, 1_700_000_200_000];
    const initial = body(1, 12);
    await writeNotes(["# Notes", ...initial], mtimes[0] ?? 0);
    const manager = await fixture.getFreshManager(
      fixture.createConfig(
        semantic
          ? { sources: ["memory"], cacheEnabled: false }
          : { provider: "none", sources: ["memory"], vectorEnabled: false },
      ),
    );
    onTestFinished(() => manager.close());
    Reflect.get(manager, "settings").chunking = { tokens: 64, overlap: 0 };
    const database = Reflect.get(manager, "db") as DatabaseSync;
    vi.setSystemTime(1_800_000_000_000);
    await manager.sync({ reason: "initial", force: true });
    if (semantic) {
      memoryIndexFixtureWriter(manager)
        .prepare(
          `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run();
    }
    const before = readIndex(database);
    expect(before.chunks.length).toBeGreaterThan(3);
    expect(before.chunks.every((row) => row.embedded === Number(semantic))).toBe(true);
    expect(before.fts).toEqual(before.chunks.map((row) => row.id).toSorted());

    const appended = body(13, 18);
    await writeNotes(["# Notes", ...initial, ...appended], mtimes[1] ?? 0);
    vi.setSystemTime(1_800_000_100_000);
    Reflect.set(manager, "dirty", true);
    await manager.sync({ reason: "append" });
    const after = readIndex(database);

    // Only the trailing chunk may change; every earlier row keeps its identity.
    const stable = before.chunks.slice(0, -1);
    for (const row of stable) {
      const next = after.chunks.find((candidate) => candidate.id === row.id);
      expect(next).toEqual({ ...row, observedAt: mtimes[1] });
    }
    expect(after.chunks.length).toBeGreaterThan(before.chunks.length);
    expect(after.chunks.every((row) => row.embedded === Number(semantic))).toBe(true);
    expect(Math.max(...after.chunks.map((row) => row.endLine))).toBe(initial.length + 1 + 6);
    expect(after.chunks.every((row) => row.observedAt === mtimes[1])).toBe(true);
    expect(after.fts).toEqual(after.chunks.map((row) => row.id).toSorted());

    const search = async (query: string) =>
      (await manager.search(query, { lexicalOnly: true, sources: ["memory"] })).map(
        ({ path: resultPath, startLine, endLine, score, snippet }) => ({
          path: resultPath,
          startLine,
          endLine,
          score,
          snippet,
        }),
      );
    const queries = ["marker3", "marker12", "marker16"];
    const incremental = await Promise.all(queries.map(search));
    expect(incremental.every((results) => results.length > 0)).toBe(true);
    await manager.sync({ reason: "full-comparison", force: true });
    expect(await Promise.all(queries.map(search))).toEqual(incremental);
    expect(readIndex(database).chunks.map((row) => row.id)).toEqual(
      after.chunks.map((row) => row.id),
    );

    // A new first line moves every later line range, so no chunk id survives.
    await writeNotes(
      ["Inserted preface line.", "# Notes", ...initial, ...appended],
      mtimes[2] ?? 0,
    );
    vi.setSystemTime(1_800_000_200_000);
    Reflect.set(manager, "dirty", true);
    await manager.sync({ reason: "insert-first-line" });
    const shifted = readIndex(database);

    const appendedIds = new Set(after.chunks.map((row) => row.id));
    expect(shifted.chunks.length).toBeGreaterThan(0);
    expect(shifted.chunks.some((row) => appendedIds.has(row.id))).toBe(false);
    expect(shifted.chunks.every((row) => row.updatedAt === 1_800_000_200_000)).toBe(true);
    expect(shifted.fts).toEqual(shifted.chunks.map((row) => row.id).toSorted());
  });
});
