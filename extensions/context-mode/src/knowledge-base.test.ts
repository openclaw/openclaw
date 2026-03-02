import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompressedEntry } from "./types.js";

// node:sqlite may not be available in all environments
let openKnowledgeBase: typeof import("./knowledge-base.js").openKnowledgeBase;
let KnowledgeBase: typeof import("./knowledge-base.js").KnowledgeBase;

let skipSqlite = false;
try {
  const mod = await import("./knowledge-base.js");
  openKnowledgeBase = mod.openKnowledgeBase;
  KnowledgeBase = mod.KnowledgeBase;
} catch {
  skipSqlite = true;
}

function makeEntry(overrides: Partial<CompressedEntry> = {}): CompressedEntry {
  return {
    refId: `test_${Date.now()}`,
    toolName: "test_tool",
    toolCallId: "call_1",
    originalChars: 5000,
    compressedChars: 200,
    fullText: "The quick brown fox jumps over the lazy dog. " + "x".repeat(4000),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe.skipIf(skipSqlite)("KnowledgeBase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-mode-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves an entry by ref ID", () => {
    const kb = openKnowledgeBase(tmpDir);
    const entry = makeEntry({ refId: "ref_abc" });
    kb.store(entry);

    const retrieved = kb.retrieve("ref_abc");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.refId).toBe("ref_abc");
    expect(retrieved!.toolName).toBe("test_tool");
    expect(retrieved!.fullText).toBe(entry.fullText);
    kb.close();
  });

  it("returns null for non-existent ref ID", () => {
    const kb = openKnowledgeBase(tmpDir);
    expect(kb.retrieve("nonexistent")).toBeNull();
    kb.close();
  });

  it("upserts on duplicate ref ID", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry({ refId: "dup", fullText: "version 1" }));
    kb.store(makeEntry({ refId: "dup", fullText: "version 2" }));

    const retrieved = kb.retrieve("dup");
    expect(retrieved!.fullText).toBe("version 2");
    kb.close();
  });

  it("searches by keyword", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry({ refId: "a", fullText: "React component rendering lifecycle" }));
    kb.store(makeEntry({ refId: "b", fullText: "Database migration schema changes" }));
    kb.store(makeEntry({ refId: "c", fullText: "React hooks useState useEffect" }));

    const results = kb.search("React");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const refIds = results.map((r) => r.refId);
    expect(refIds).toContain("a");
    expect(refIds).toContain("c");
    kb.close();
  });

  it("limits search results", () => {
    const kb = openKnowledgeBase(tmpDir);
    for (let i = 0; i < 20; i++) {
      kb.store(makeEntry({ refId: `item_${i}`, fullText: `common keyword item ${i}` }));
    }

    const results = kb.search("common keyword", 3);
    expect(results.length).toBe(3);
    kb.close();
  });

  it("returns empty for blank query", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry());
    expect(kb.search("")).toEqual([]);
    expect(kb.search("   ")).toEqual([]);
    kb.close();
  });

  it("reports stats", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry({ refId: "s1", originalChars: 1000, compressedChars: 100 }));
    kb.store(makeEntry({ refId: "s2", originalChars: 2000, compressedChars: 200 }));

    const stats = kb.stats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalOriginalChars).toBe(3000);
    expect(stats.totalCompressedChars).toBe(300);
    kb.close();
  });

  it("persists data across re-opens", () => {
    const kb1 = openKnowledgeBase(tmpDir);
    kb1.store(makeEntry({ refId: "persist_test", fullText: "persistent data" }));
    kb1.close();

    const kb2 = openKnowledgeBase(tmpDir);
    const retrieved = kb2.retrieve("persist_test");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.fullText).toBe("persistent data");
    kb2.close();
  });

  it("handles special characters in search query", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry({ refId: "special", fullText: "error in file.ts (line 42)" }));

    // Should not throw on special FTS5 characters
    const results = kb.search("file.ts (line");
    expect(results.length).toBeGreaterThanOrEqual(0);
    kb.close();
  });

  it("lists recent entries sorted by timestamp descending", () => {
    const kb = openKnowledgeBase(tmpDir);
    kb.store(makeEntry({ refId: "old", timestamp: 1000 }));
    kb.store(makeEntry({ refId: "mid", timestamp: 2000 }));
    kb.store(makeEntry({ refId: "new", timestamp: 3000 }));

    const recent = kb.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.refId).toBe("new");
    expect(recent[1]!.refId).toBe("mid");
    // Should not include full text
    expect((recent[0] as Record<string, unknown>).fullText).toBeUndefined();
    kb.close();
  });
});
