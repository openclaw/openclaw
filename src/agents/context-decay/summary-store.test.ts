import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GroupSummaryStore, SummaryStore } from "./summary-store.js";
import {
  clearGroupSummaryStore,
  clearSummaryStore,
  loadGroupSummaryStore,
  loadGroupSummaryStoreSync,
  loadSummaryStore,
  loadSummaryStoreSync,
  saveGroupSummaryStore,
  saveSummaryStore,
} from "./summary-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sessionPath(): string {
  return path.join(tmpDir, "session.jsonl");
}

function summaryPath(): string {
  return path.join(tmpDir, "session.summaries.json");
}

function groupSummaryPath(): string {
  return path.join(tmpDir, "session.group-summaries.json");
}

function makeSampleStore(): SummaryStore {
  return {
    2: {
      summary: "Read file /src/foo.ts, found function bar()",
      originalTokenEstimate: 450,
      summaryTokenEstimate: 12,
      summarizedAt: "2026-01-15T10:00:00.000Z",
      model: "anthropic/claude-haiku-4-5",
    },
    5: {
      summary: "Search returned 3 matches in utils.ts",
      originalTokenEstimate: 200,
      summaryTokenEstimate: 8,
      summarizedAt: "2026-01-15T10:01:00.000Z",
      model: "anthropic/claude-haiku-4-5",
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-store-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("summary-store", () => {
  describe("loadSummaryStore (async)", () => {
    it("returns empty store when file does not exist", async () => {
      const store = await loadSummaryStore(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains invalid JSON", async () => {
      await fs.writeFile(summaryPath(), "not json!", "utf-8");
      const store = await loadSummaryStore(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains a JSON array", async () => {
      await fs.writeFile(summaryPath(), "[1,2,3]", "utf-8");
      const store = await loadSummaryStore(sessionPath());
      expect(store).toEqual({});
    });

    it("loads a valid store", async () => {
      const sample = makeSampleStore();
      await fs.writeFile(summaryPath(), JSON.stringify(sample), "utf-8");
      const store = await loadSummaryStore(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("loadSummaryStoreSync", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadSummaryStoreSync(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains invalid JSON", async () => {
      await fs.writeFile(summaryPath(), "{broken", "utf-8");
      const store = loadSummaryStoreSync(sessionPath());
      expect(store).toEqual({});
    });

    it("loads a valid store", async () => {
      const sample = makeSampleStore();
      await fs.writeFile(summaryPath(), JSON.stringify(sample), "utf-8");
      const store = loadSummaryStoreSync(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("saveSummaryStore", () => {
    it("creates directories and saves a round-trippable store", async () => {
      const nestedSession = path.join(tmpDir, "a", "b", "session.jsonl");
      const sample = makeSampleStore();

      await saveSummaryStore(nestedSession, sample);

      const loaded = await loadSummaryStore(nestedSession);
      expect(loaded).toEqual(sample);
    });

    it("overwrites an existing store", async () => {
      const sample1 = makeSampleStore();
      await saveSummaryStore(sessionPath(), sample1);

      const sample2: SummaryStore = {
        10: {
          summary: "Updated summary",
          originalTokenEstimate: 100,
          summaryTokenEstimate: 5,
          summarizedAt: "2026-02-01T00:00:00.000Z",
          model: "haiku",
        },
      };
      await saveSummaryStore(sessionPath(), sample2);

      const loaded = await loadSummaryStore(sessionPath());
      expect(loaded).toEqual(sample2);
      expect(loaded[2]).toBeUndefined(); // old entry gone
    });

    it("writes pretty-printed JSON", async () => {
      await saveSummaryStore(sessionPath(), makeSampleStore());
      const raw = await fs.readFile(summaryPath(), "utf-8");
      // Pretty-printed JSON has newlines and indentation
      expect(raw).toContain("\n");
      expect(raw).toContain("  ");
    });
  });

  describe("clearSummaryStore", () => {
    it("removes an existing summary store file", async () => {
      await saveSummaryStore(sessionPath(), makeSampleStore());
      // File exists
      await expect(fs.access(summaryPath())).resolves.toBeUndefined();

      await clearSummaryStore(sessionPath());

      // File is gone — load returns empty
      const store = await loadSummaryStore(sessionPath());
      expect(store).toEqual({});
    });

    it("is a no-op when the file does not exist", async () => {
      // Should not throw
      await expect(clearSummaryStore(sessionPath())).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Group Summary Store Tests
// ---------------------------------------------------------------------------

function makeSampleGroupStore(): GroupSummaryStore {
  return [
    {
      summary: "User asked to read auth.ts. Tool found null check at line 42. Fix was applied.",
      anchorIndex: 0,
      indices: [0, 1, 2, 3, 4, 5],
      turnRange: [6, 3],
      originalTokenEstimate: 800,
      summaryTokenEstimate: 30,
      summarizedAt: "2026-01-15T10:00:00.000Z",
      model: "anthropic/claude-sonnet-4-5",
    },
  ];
}

describe("group-summary-store", () => {
  describe("loadGroupSummaryStore (async)", () => {
    it("returns empty array when file does not exist", async () => {
      const store = await loadGroupSummaryStore(sessionPath());
      expect(store).toEqual([]);
    });

    it("returns empty array when file contains invalid JSON", async () => {
      await fs.writeFile(groupSummaryPath(), "not json!", "utf-8");
      const store = await loadGroupSummaryStore(sessionPath());
      expect(store).toEqual([]);
    });

    it("returns empty array when file contains a JSON object (not array)", async () => {
      await fs.writeFile(groupSummaryPath(), '{"key": "value"}', "utf-8");
      const store = await loadGroupSummaryStore(sessionPath());
      expect(store).toEqual([]);
    });

    it("loads a valid store", async () => {
      const sample = makeSampleGroupStore();
      await fs.writeFile(groupSummaryPath(), JSON.stringify(sample), "utf-8");
      const store = await loadGroupSummaryStore(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("loadGroupSummaryStoreSync", () => {
    it("returns empty array when file does not exist", () => {
      const store = loadGroupSummaryStoreSync(sessionPath());
      expect(store).toEqual([]);
    });

    it("returns empty array when file contains invalid JSON", async () => {
      await fs.writeFile(groupSummaryPath(), "{broken", "utf-8");
      const store = loadGroupSummaryStoreSync(sessionPath());
      expect(store).toEqual([]);
    });

    it("loads a valid store", async () => {
      const sample = makeSampleGroupStore();
      await fs.writeFile(groupSummaryPath(), JSON.stringify(sample), "utf-8");
      const store = loadGroupSummaryStoreSync(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("saveGroupSummaryStore", () => {
    it("creates directories and saves a round-trippable store", async () => {
      const nestedSession = path.join(tmpDir, "a", "b", "session.jsonl");
      const sample = makeSampleGroupStore();

      await saveGroupSummaryStore(nestedSession, sample);

      const loaded = await loadGroupSummaryStore(nestedSession);
      expect(loaded).toEqual(sample);
    });

    it("overwrites an existing store", async () => {
      const sample1 = makeSampleGroupStore();
      await saveGroupSummaryStore(sessionPath(), sample1);

      const sample2: GroupSummaryStore = [
        {
          summary: "New group summary",
          anchorIndex: 10,
          indices: [10, 11, 12],
          turnRange: [4, 2],
          originalTokenEstimate: 300,
          summaryTokenEstimate: 15,
          summarizedAt: "2026-02-01T00:00:00.000Z",
          model: "haiku",
        },
      ];
      await saveGroupSummaryStore(sessionPath(), sample2);

      const loaded = await loadGroupSummaryStore(sessionPath());
      expect(loaded).toEqual(sample2);
      expect(loaded).toHaveLength(1);
    });

    it("writes pretty-printed JSON", async () => {
      await saveGroupSummaryStore(sessionPath(), makeSampleGroupStore());
      const raw = await fs.readFile(groupSummaryPath(), "utf-8");
      expect(raw).toContain("\n");
      expect(raw).toContain("  ");
    });
  });

  describe("clearGroupSummaryStore", () => {
    it("removes an existing group summary store file", async () => {
      await saveGroupSummaryStore(sessionPath(), makeSampleGroupStore());
      await expect(fs.access(groupSummaryPath())).resolves.toBeUndefined();

      await clearGroupSummaryStore(sessionPath());

      const store = await loadGroupSummaryStore(sessionPath());
      expect(store).toEqual([]);
    });

    it("is a no-op when the file does not exist", async () => {
      await expect(clearGroupSummaryStore(sessionPath())).resolves.toBeUndefined();
    });
  });
});
