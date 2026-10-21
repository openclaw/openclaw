import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { DatabaseSync } = requireNodeSqlite();
const DAY_MS = 24 * 60 * 60 * 1000;

function readIndex(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      chunks: db
        .prepare(
          "SELECT id, path, source, hash, text, embedding, updated_at FROM memory_index_chunks ORDER BY id",
        )
        .all(),
      sources: db
        .prepare(
          "SELECT path, source, hash, mtime, size FROM memory_index_sources ORDER BY path, source",
        )
        .all(),
      identity: db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get(),
    };
  } finally {
    db.close();
  }
}

// The public engine always enables hybrid search. Set its resolved input only
// to exercise the vector-only fallback; indexing, SQLite and retrieval are real.
function selectRetrieval(manager: MemoryIndexManager, mode: string) {
  const { settings } = manager as unknown as { settings: ResolvedMemorySearchConfig };
  settings.query.hybrid.enabled = mode !== "vector-only";
}

describe("evergreen reference retrieval", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each(["keyword-only", "vector-only", "hybrid"] as const)(
    "toggles persisted reference ranking without reindexing in %s search",
    async (mode) => {
      fixture.provider.forceNoProvider = mode === "keyword-only";
      const referenceDir = path.join(fixture.paths.workspace, "reference");
      await fs.mkdir(referenceDir);
      const files = [
        ["reference/stable.md", "Alpha reference policy.", 60],
        ["reference/decaying.md", "Alpha reference policy.", 60],
        ["reference/recent.md", "Alpha beta reference policy.", 0],
        ["memory/2000-01-01.md", "Alpha reference policy.", 60],
      ] as const;
      const now = Date.now();
      for (const [relativePath, content, ageDays] of files) {
        const file = path.join(fixture.paths.workspace, relativePath);
        await fs.writeFile(file, content);
        const timestamp = new Date(now - ageDays * DAY_MS);
        await fs.utimes(file, timestamp, timestamp);
      }
      const createConfig = (evergreen: boolean) =>
        fixture.createConfig({
          provider: mode === "keyword-only" ? "none" : undefined,
          extraPaths: [
            { path: referenceDir, pattern: "stable.md", evergreen },
            { path: referenceDir, pattern: "decaying.md" },
            { path: referenceDir, pattern: "recent.md" },
            { path: fixture.paths.memory, evergreen: true },
          ],
          minScore: 0,
        });
      let manager = await fixture.getPersistentManager(createConfig(false));
      expect(manager.status().fts?.available).toBe(true);
      selectRetrieval(manager, mode);
      await manager.sync({ reason: "test" });
      const dbPath = manager.status().dbPath;
      if (!dbPath) {
        throw new Error("indexed manager did not report its database path");
      }
      const inode = (await fs.stat(dbPath)).ino;
      const search = async () => manager.search("alpha", { maxResults: 10, minScore: 0 });
      const control = await search();
      const resultFor = (results: typeof control, relativePath: string) => {
        const result = results.find((entry) => entry.path === relativePath);
        expect(result, relativePath).toBeDefined();
        if (!result) {
          throw new Error(`missing indexed result: ${relativePath}`);
        }
        return result;
      };
      const stable = resultFor(control, "reference/stable.md");
      expect(stable.score).toBeGreaterThan(0);
      expect(stable.score).toBeLessThan(resultFor(control, "reference/recent.md").score);
      const indexed = readIndex(dbPath);
      expect(indexed.chunks.length).toBeGreaterThanOrEqual(files.length);
      const embeddedBatches = fixture.provider.embedBatchCalls;
      if (mode === "keyword-only") {
        expect(embeddedBatches).toBe(0);
      } else {
        expect(embeddedBatches).toBeGreaterThan(0);
      }
      const embeddedQueries = fixture.provider.embedQueryCalls;
      await closeAllMemorySearchManagers();

      for (const evergreen of [true, false]) {
        manager = await fixture.getFreshManager(createConfig(evergreen));
        selectRetrieval(manager, mode);
        expect(manager.status().dbPath).toBe(dbPath);
        const results = await search();
        const selected = resultFor(results, "reference/stable.md");
        if (evergreen) {
          expect(selected.score).toBeGreaterThan(stable.score * 3);
          expect(results.indexOf(selected)).toBeLessThan(
            results.indexOf(resultFor(results, "reference/decaying.md")),
          );
          expect(selected.score, JSON.stringify(results)).toBeGreaterThan(
            resultFor(results, "reference/decaying.md").score * 3,
          );
        } else {
          expect(selected.score).toBeCloseTo(stable.score, 4);
        }
        for (const relativePath of [
          "reference/decaying.md",
          "reference/recent.md",
          "memory/2000-01-01.md",
        ]) {
          expect(resultFor(results, relativePath).score).toBeCloseTo(
            resultFor(control, relativePath).score,
            4,
          );
        }
        expect((await fs.stat(dbPath)).ino).toBe(inode);
        expect(readIndex(dbPath)).toEqual(indexed);
        expect(fixture.provider.embedBatchCalls).toBe(embeddedBatches);
        await closeAllMemorySearchManagers();
      }
      expect(fixture.provider.embedQueryCalls).toBe(
        mode === "keyword-only" ? 0 : embeddedQueries + 2,
      );
    },
  );
});
