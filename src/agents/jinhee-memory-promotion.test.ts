/**
 * jinhee-memory-promotion.test.ts — MEMORY-PROMOTION-004 tests
 *
 * Tests the promotion pipeline: validation, dry-run, actual insert, guard, rollback.
 * Uses a temp in-memory SQLite DB for write tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, writeFileSync } from "fs";
import {
  ApprovedMemoryPromotion,
  promoteApprovedCanonicalMemories,
  hasSensitiveContent,
  isValidPromotionItem,
  isAllowedPromotionSql,
  assertAllowedPromotionSql,
  parseBatchFile,
} from "./jinhee-memory-promotion";

// --- Helpers ---
function createTempDb(): { db: Database.Database; path: string } {
  const path = join(tmpdir(), `jinhee-promo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE canonical_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT UNIQUE,
      memory_type TEXT,
      truth_confidence INTEGER DEFAULT 0,
      source_count INTEGER DEFAULT 1,
      real_count INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      manual_count INTEGER DEFAULT 0,
      last_confirmed TEXT DEFAULT (datetime('now', 'localtime')),
      source TEXT,
      metadata TEXT
    );
  `);
  db.close();
  return { db, path };
}

function makeValidItem(overrides: Partial<ApprovedMemoryPromotion> = {}): ApprovedMemoryPromotion {
  return {
    sourceCandidateId: "CAND-TEST-001",
    kind: "operational_rule",
    canonicalText: "Test canonical memory content for testing purposes.",
    confidence: 0.95,
    importance: 0.90,
    sourceLogIds: [1, 2, 3],
    reason: "Test reason",
    ...overrides,
  };
}

// --- Tests ---

describe("MEMORY-PROMOTION-004", () => {
  describe("isAllowedPromotionSql", () => {
    it("allows INSERT INTO canonical_memories", () => {
      expect(isAllowedPromotionSql("INSERT INTO canonical_memories (content) VALUES ('test')")).toBe(true);
    });

    it("denies INSERT INTO memories", () => {
      expect(isAllowedPromotionSql("INSERT INTO memories (content) VALUES ('test')")).toBe(false);
    });

    it("denies INSERT INTO conversation_logs", () => {
      expect(isAllowedPromotionSql("INSERT INTO conversation_logs (text) VALUES ('test')")).toBe(false);
    });

    it("denies UPDATE canonical_memories", () => {
      expect(isAllowedPromotionSql("UPDATE canonical_memories SET content='x' WHERE id=1")).toBe(false);
    });

    it("denies DELETE canonical_memories", () => {
      expect(isAllowedPromotionSql("DELETE FROM canonical_memories WHERE id=1")).toBe(false);
    });

    it("denies ALTER TABLE", () => {
      expect(isAllowedPromotionSql("ALTER TABLE canonical_memories ADD COLUMN x TEXT")).toBe(false);
    });

    it("denies DROP TABLE", () => {
      expect(isAllowedPromotionSql("DROP TABLE canonical_memories")).toBe(false);
    });

    it("denies VACUUM", () => {
      expect(isAllowedPromotionSql("VACUUM")).toBe(false);
    });

    it("denies multiple statements", () => {
      expect(
        isAllowedPromotionSql(
          "INSERT INTO canonical_memories (content) VALUES ('test'); INSERT INTO memories (content) VALUES ('x')",
        ),
      ).toBe(false);
    });

    it("allows trailing semicolon", () => {
      expect(isAllowedPromotionSql("INSERT INTO canonical_memories (content) VALUES ('test');")).toBe(true);
    });

    it("denies empty SQL", () => {
      expect(isAllowedPromotionSql("")).toBe(false);
    });
  });

  describe("assertAllowedPromotionSql", () => {
    it("throws on denied SQL", () => {
      expect(() => assertAllowedPromotionSql("DELETE FROM canonical_memories")).toThrow();
    });

    it("does not throw on allowed SQL", () => {
      expect(() =>
        assertAllowedPromotionSql("INSERT INTO canonical_memories (content) VALUES ('test')"),
      ).not.toThrow();
    });
  });

  describe("hasSensitiveContent", () => {
    it("detects 'token'", () => {
      expect(hasSensitiveContent("my api_token is 12345")).toBe(true);
    });

    it("detects 'api_key'", () => {
      expect(hasSensitiveContent("api_key=sk-12345")).toBe(true);
    });

    it("detects 'secret'", () => {
      expect(hasSensitiveContent("client_secret is hidden")).toBe(true);
    });

    it("detects 'password'", () => {
      expect(hasSensitiveContent("password=12345")).toBe(true);
    });

    it("allows clean text", () => {
      expect(hasSensitiveContent("Plugin system is complete.")).toBe(false);
    });
  });

  describe("isValidPromotionItem", () => {
    it("accepts valid item", () => {
      expect(isValidPromotionItem(makeValidItem(), 0)).toBeNull();
    });

    it("rejects empty canonicalText", () => {
      const err = isValidPromotionItem(makeValidItem({ canonicalText: "" }), 0);
      expect(err).toContain("empty canonicalText");
    });

    it("rejects sensitive canonicalText", () => {
      const err = isValidPromotionItem(makeValidItem({ canonicalText: "my token is abc" }), 0);
      expect(err).toContain("sensitive content");
    });

    it("rejects invalid confidence", () => {
      const err = isValidPromotionItem(makeValidItem({ confidence: 1.5 }), 0);
      expect(err).toContain("invalid confidence");
    });

    it("rejects invalid importance", () => {
      const err = isValidPromotionItem(makeValidItem({ importance: -0.5 }), 0);
      expect(err).toContain("invalid importance");
    });

    it("rejects missing kind", () => {
      const err = isValidPromotionItem(makeValidItem({ kind: "" }), 0);
      expect(err).toContain("invalid kind");
    });
  });

  describe("promoteApprovedCanonicalMemories", () => {
    it("rejects empty batch", async () => {
      const result = await promoteApprovedCanonicalMemories([], { dryRun: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("empty");
      }
    });

    it("dryRun=true does not write to DB", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories([makeValidItem()], {
          dbPath: path,
          dryRun: true,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dryRun).toBe(true);
          expect(result.insertedIds).toHaveLength(0);
          expect(result.beforeCount).toBe(result.afterCount);
          expect(result.rollbackSql).toContain("DRY RUN");
        }

        // Verify no write
        const db = new Database(path, { readonly: true });
        const count = (db.prepare("SELECT COUNT(*) AS cnt FROM canonical_memories").get() as { cnt: number }).cnt;
        expect(count).toBe(0);
        db.close();
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("dryRun=false inserts and returns IDs", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories(
          [makeValidItem({ sourceCandidateId: "CAND-A" }), makeValidItem({ sourceCandidateId: "CAND-B" })],
          { dbPath: path, dryRun: false },
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dryRun).toBe(false);
          expect(result.insertedIds).toHaveLength(2);
          expect(result.beforeCount).toBe(0);
          expect(result.afterCount).toBe(2);
        }

        // Verify DB
        const db = new Database(path, { readonly: true });
        const rows = db.prepare("SELECT id, content, source FROM canonical_memories ORDER BY id").all();
        expect(rows).toHaveLength(2);
        expect((rows[0] as any).source).toBe("memory_candidate_003");
        db.close();
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("respects maxBatch limit", async () => {
      const { path } = createTempDb();
      try {
        const items = Array.from({ length: 50 }, (_, i) =>
          makeValidItem({
            sourceCandidateId: `CAND-${i}`,
            canonicalText: `Test item ${i}`,
          }),
        );
        const result = await promoteApprovedCanonicalMemories(items, {
          dbPath: path,
          dryRun: false,
          maxBatch: 10,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insertedIds).toHaveLength(10);
          expect(result.afterCount - result.beforeCount).toBe(10);
        }

        const db = new Database(path, { readonly: true });
        const count = (db.prepare("SELECT COUNT(*) AS cnt FROM canonical_memories").get() as { cnt: number }).cnt;
        expect(count).toBe(10);
        db.close();
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("skips items with empty canonicalText", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories(
          [
            makeValidItem({ sourceCandidateId: "CAND-VALID", canonicalText: "Valid text" }),
            makeValidItem({ sourceCandidateId: "CAND-EMPTY", canonicalText: "" }),
          ],
          { dbPath: path, dryRun: false },
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insertedIds).toHaveLength(1);
          expect(result.skipped).toHaveLength(1);
          expect(result.skipped[0].sourceCandidateId).toBe("CAND-EMPTY");
        }
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("skips items with sensitive content", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories(
          [
            makeValidItem({ sourceCandidateId: "CAND-CLEAN", canonicalText: "Clean text" }),
            makeValidItem({ sourceCandidateId: "CAND-SECRET", canonicalText: "my api_token is 123" }),
          ],
          { dbPath: path, dryRun: false },
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insertedIds).toHaveLength(1);
          expect(result.skipped).toHaveLength(1);
          expect(result.skipped[0].sourceCandidateId).toBe("CAND-SECRET");
        }
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("generates rollback SQL", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories([makeValidItem()], {
          dbPath: path,
          dryRun: false,
        });
        expect(result.ok).toBe(true);
        if (result.ok && !result.dryRun) {
          expect(result.rollbackSql).toContain("DELETE FROM canonical_memories");
          expect(result.rollbackSql).toContain("DO NOT RUN WITHOUT APPROVAL");
          expect(result.insertedIds.length).toBeGreaterThan(0);
          for (const id of result.insertedIds) {
            expect(result.rollbackSql).toContain(String(id));
          }
        }
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });

    it("errors when all items are skipped", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories(
          [makeValidItem({ canonicalText: "" })],
          { dbPath: path, dryRun: false },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("skipped");
        }
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });
  });

  describe("parseBatchFile", () => {
    it("parses a valid batch markdown file", () => {
      const markdown = `# MEMORY-PROMOTION-004 — Approved Promotion Batch

## Approved Candidates

### PROMOTE-001
- sourceCandidateId: CAND-TEST-001
- kind: operational_rule
- canonicalText: Test canonical memory.
- confidence: 0.95
- importance: 0.90
- sourceLogIds: [1, 2, 3]
- reason: Test reason
- duplicateRisk: low

### PROMOTE-002
- sourceCandidateId: CAND-TEST-002
- kind: identity
- canonicalText: Another test.
- confidence: 0.85
- importance: 0.80
- sourceLogIds: [4, 5]
- reason: Test reason 2
- duplicateRisk: low
`;
      const items = parseBatchFile(markdown);
      expect(items).toHaveLength(2);
      expect(items[0].sourceCandidateId).toBe("CAND-TEST-001");
      expect(items[0].canonicalText).toBe("Test canonical memory.");
      expect(items[1].sourceCandidateId).toBe("CAND-TEST-002");
      expect(items[1].kind).toBe("identity");
    });

    it("returns empty array for text with no candidates", () => {
      expect(parseBatchFile("# No candidates here")).toEqual([]);
    });
  });

  describe("rollback SQL is generated but not executed", () => {
    it("rollbackSql contains DELETE but only as string", async () => {
      const { path } = createTempDb();
      try {
        const result = await promoteApprovedCanonicalMemories(
          [makeValidItem({ canonicalText: "rollback test" })],
          { dbPath: path, dryRun: false },
        );
        expect(result.ok).toBe(true);
        if (result.ok && !result.dryRun) {
          expect(result.rollbackSql).toContain("DELETE");
          expect(result.rollbackSql).toContain("DO NOT RUN");

          // Verify DB still has the data (rollback SQL was NOT executed)
          const db = new Database(path, { readonly: true });
          const count = (db.prepare("SELECT COUNT(*) AS cnt FROM canonical_memories").get() as { cnt: number }).cnt;
          expect(count).toBe(1);
          db.close();
        }
      } finally {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    });
  });
});
