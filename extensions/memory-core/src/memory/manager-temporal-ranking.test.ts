import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it } from "vitest";
import { createMemorySearchToolOrThrow } from "../tools.test-helpers.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const managers = await import("./index.js");
const DAY_MS = 24 * 60 * 60 * 1_000;

function replaceFtsWithView() {
  openOpenClawAgentDatabase({ agentId: "main" }).db.exec(`
    DROP TABLE memory_index_chunks_fts;
    CREATE VIEW memory_index_chunks_fts AS
      SELECT text, id, path, source, model, start_line, end_line FROM memory_index_chunks;
  `);
}

describe("memory source temporal ranking", () => {
  const fixture = createManagerIndexFixture(managers);

  it.each(["keyword-only", "hybrid", "vector-only"])(
    "keeps old dated notes above the relevance threshold through %s",
    async (mode) => {
      fixture.provider.forceNoProvider = mode === "keyword-only";
      const cfg = fixture.createConfig({
        provider: mode === "keyword-only" ? "none" : "openai",
        vectorEnabled: false,
        minScore: 0.35,
      });
      const dated = "memory/records/2000-01-01-alpha.md";
      await fs.writeFile(path.join(fixture.paths.memory, "2026-01-12.md"), "Beta unrelated note.");
      await fs.mkdir(path.join(fixture.paths.workspace, "memory/records"), { recursive: true });
      await fs.writeFile(path.join(fixture.paths.workspace, dated), "Alpha cobalt orchid.");
      await fs.writeFile(path.join(fixture.paths.memory, "evergreen.md"), "Alpha cobalt orchid.");
      let manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "test", force: true });
      if (mode === "vector-only") {
        await manager.close();
        replaceFtsWithView();
        manager = await fixture.getFreshManager(cfg, "cli");
        expect(manager.status().fts?.available).toBe(false);
      }

      const results = await manager.search("alpha cobalt orchid", { maxResults: 2 });
      expect(results.map((entry) => entry.path)).toEqual(["memory/evergreen.md", dated]);
      expect(results[1]?.score).toBeLessThan(0.35);
      expect(results[1]?.snippet).toContain("Alpha cobalt orchid.");
      expect(results[1]).not.toHaveProperty("eligibilityScore");
    },
  );

  it.each([
    { name: "keyword-only", provider: "none" },
    { name: "lexical recall", lexicalOnly: true },
    { name: "hybrid" },
    { name: "retained archives", provider: "none", archived: true },
    { name: "FTS unavailable", ftsUnavailable: true },
    { name: "LIKE-only hybrid", zeroScoreLike: true },
  ])(
    "decays SQLite session hits by recorded source activity through $name",
    async ({
      provider = "openai",
      lexicalOnly = false,
      archived = false,
      ftsUnavailable = false,
      zeroScoreLike = false,
    }) => {
      fixture.provider.forceNoProvider = provider === "none";
      const cfg = fixture.createConfig({
        provider,
        sources: ["sessions"],
        sessionMemory: true,
        minScore: 0,
        vectorEnabled: false,
        ftsTokenizer: zeroScoreLike ? "trigram" : "unicode61",
      });
      const now = Date.now();
      const observedAt = now - 60 * DAY_MS;
      const stale = { sessionId: "a-old", updatedAt: now - 15 * DAY_MS, fileName: "a-old.jsonl" };
      const freshSession = { sessionId: "z-fresh", updatedAt: now, fileName: "z-fresh.jsonl" };
      const sessions = [stale, freshSession];
      const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
      const content = zeroScoreLike ? "记忆 彩色 潮池 偏好。" : "Alpha cobalt orchid.";
      for (const session of sessions) {
        const sessionKey = `agent:main:memory:${session.sessionId}`;
        const target = { agentId: "main", sessionKey, storePath };
        await fixture.seedSessionTranscript({
          sessionId: session.sessionId,
          sessionKey,
          messages: [{ role: "user", content, timestamp: observedAt }],
        });
        await upsertSessionEntry({
          ...target,
          entry: { sessionId: session.sessionId, updatedAt: session.updatedAt },
        });
        if (archived) {
          await deleteSessionEntry({ ...target, archiveTranscript: true });
          const files = await fs.readdir(path.dirname(storePath));
          const archiveName = files.find((name) =>
            name.startsWith(`${session.sessionId}.jsonl.deleted.`),
          );
          if (!archiveName) {
            throw new Error("Expected retained session archive");
          }
          const archivePath = path.join(path.dirname(storePath), archiveName);
          const activity = new Date(session.updatedAt);
          await fs.utimes(archivePath, activity, activity);
          session.fileName = archiveName;
          session.updatedAt = (await fs.stat(archivePath)).mtimeMs;
        }
      }
      let manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "test", force: true });
      const sourceRows = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "SELECT path, mtime FROM memory_index_sources WHERE source = 'sessions' ORDER BY path",
        )
        .all();
      expect(sourceRows).toEqual(
        sessions.map((session) => ({
          path: `sessions/main/${session.fileName}`,
          mtime: session.updatedAt,
        })),
      );
      await expect(fs.stat(path.join(fixture.paths.workspace, "sessions"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (ftsUnavailable) {
        await manager.close();
        // Matching row counts must not make a non-FTS view look like an available index.
        replaceFtsWithView();
        manager = await fixture.getFreshManager(cfg, "cli");
        expect(manager.status().fts).toMatchObject({
          enabled: true,
          available: false,
          error: expect.stringContaining("view"),
        });
        expect(
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare("SELECT type FROM sqlite_schema WHERE name = ?")
            .get("memory_index_chunks_fts"),
        ).toEqual({ type: "view" });
      }

      const query = zeroScoreLike ? "记忆" : "alpha cobalt orchid";
      const search = (maxResults = 2) =>
        manager.search(query, { maxResults, minScore: 0, lexicalOnly, sources: ["sessions"] });
      const sourcePath = (session: typeof stale) => `sessions/main/${session.fileName}`;
      const expectSourceRecency = (results: MemorySearchResult[]) => {
        const old = results.find((entry) => entry.path === sourcePath(stale));
        const fresh = results.find((entry) => entry.path === sourcePath(freshSession));
        if (!old || !fresh) {
          throw new Error("Expected both indexed session sources");
        }
        if (zeroScoreLike) {
          const zero = expect.objectContaining({ score: 0, vectorScore: 0, textScore: 0 });
          expect(results).toEqual([zero, zero]);
        } else {
          expect(old.score / fresh.score).toBeCloseTo(Math.SQRT1_2, 5);
        }
        expect(results[0]?.path).toBe(fresh.path);
        expect(results.every((entry) => entry.provenance?.observedAt === observedAt)).toBe(true);
      };
      expectSourceRecency(await search());
      expect(fixture.provider.embedQueryCalls).toBe(provider === "none" || lexicalOnly ? 0 : 1);
      expect((await search(1))[0]?.path).toBe(sourcePath(freshSession));

      if (!lexicalOnly && !archived) {
        const tool = createMemorySearchToolOrThrow({
          config: cfg,
          agentId: "main",
          agentSessionKey: "agent:main:memory:z-fresh",
        });
        const result = await tool.execute("source-recency", {
          query,
          corpus: "sessions",
          maxResults: 2,
          minScore: 0,
        });
        expectSourceRecency((result.details as { results: MemorySearchResult[] }).results);
      }

      // A decoy is deliberately outside the canonical source; it must not become its timestamp owner.
      const decoyPath = path.join(fixture.paths.workspace, "sessions", "main", stale.fileName);
      await fs.mkdir(path.dirname(decoyPath), { recursive: true });
      await fs.writeFile(decoyPath, "not the indexed transcript");
      expectSourceRecency(await search());
    },
  );
});
