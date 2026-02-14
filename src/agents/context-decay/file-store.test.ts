import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SwappedFileStore } from "./file-store.js";
import {
  clearSwappedFileStore,
  loadSwappedFileStore,
  loadSwappedFileStoreSync,
  resultsDir,
  saveSwappedFileStore,
} from "./file-store.js";

let tmpDir: string;

function sessionPath(): string {
  return path.join(tmpDir, "session.jsonl");
}

function storePath(): string {
  return path.join(tmpDir, "session.swapped-results.json");
}

function makeSampleStore(): SwappedFileStore {
  return {
    3: {
      filePath: "/tmp/results/1700000000000-Read.txt",
      toolName: "Read",
      hint: "[136 lines, TypeScript] Contains resolveUserPath()",
      originalChars: 4200,
      swappedAt: "2026-01-15T10:00:00.000Z",
    },
    7: {
      filePath: "/tmp/results/1700000001000-Bash.txt",
      toolName: "Bash",
      hint: "[exit 0, 12 lines] npm install completed",
      originalChars: 800,
      swappedAt: "2026-01-15T10:01:00.000Z",
    },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-store-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("file-store", () => {
  describe("loadSwappedFileStore (async)", () => {
    it("returns empty store when file does not exist", async () => {
      const store = await loadSwappedFileStore(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains invalid JSON", async () => {
      await fs.writeFile(storePath(), "not json!", "utf-8");
      const store = await loadSwappedFileStore(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains a JSON array", async () => {
      await fs.writeFile(storePath(), "[1,2,3]", "utf-8");
      const store = await loadSwappedFileStore(sessionPath());
      expect(store).toEqual({});
    });

    it("loads a valid store", async () => {
      const sample = makeSampleStore();
      await fs.writeFile(storePath(), JSON.stringify(sample), "utf-8");
      const store = await loadSwappedFileStore(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("loadSwappedFileStoreSync", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadSwappedFileStoreSync(sessionPath());
      expect(store).toEqual({});
    });

    it("returns empty store when file contains invalid JSON", async () => {
      await fs.writeFile(storePath(), "{broken", "utf-8");
      const store = loadSwappedFileStoreSync(sessionPath());
      expect(store).toEqual({});
    });

    it("loads a valid store", async () => {
      const sample = makeSampleStore();
      await fs.writeFile(storePath(), JSON.stringify(sample), "utf-8");
      const store = loadSwappedFileStoreSync(sessionPath());
      expect(store).toEqual(sample);
    });
  });

  describe("saveSwappedFileStore", () => {
    it("creates directories and saves a round-trippable store", async () => {
      const nestedSession = path.join(tmpDir, "a", "b", "session.jsonl");
      const sample = makeSampleStore();

      await saveSwappedFileStore(nestedSession, sample);

      const loaded = await loadSwappedFileStore(nestedSession);
      expect(loaded).toEqual(sample);
    });

    it("overwrites an existing store", async () => {
      const sample1 = makeSampleStore();
      await saveSwappedFileStore(sessionPath(), sample1);

      const sample2: SwappedFileStore = {
        10: {
          filePath: "/tmp/results/new.txt",
          toolName: "Grep",
          hint: "[5 result lines]",
          originalChars: 300,
          swappedAt: "2026-02-01T00:00:00.000Z",
        },
      };
      await saveSwappedFileStore(sessionPath(), sample2);

      const loaded = await loadSwappedFileStore(sessionPath());
      expect(loaded).toEqual(sample2);
      expect(loaded[3]).toBeUndefined();
    });

    it("writes pretty-printed JSON", async () => {
      await saveSwappedFileStore(sessionPath(), makeSampleStore());
      const raw = await fs.readFile(storePath(), "utf-8");
      expect(raw).toContain("\n");
      expect(raw).toContain("  ");
    });
  });

  describe("clearSwappedFileStore", () => {
    it("removes an existing store file and results directory", async () => {
      await saveSwappedFileStore(sessionPath(), makeSampleStore());
      await expect(fs.access(storePath())).resolves.toBeUndefined();

      // Create a results directory with a file
      const resDir = resultsDir(sessionPath());
      await fs.mkdir(resDir, { recursive: true });
      await fs.writeFile(path.join(resDir, "test.txt"), "content", "utf-8");

      await clearSwappedFileStore(sessionPath());

      const store = await loadSwappedFileStore(sessionPath());
      expect(store).toEqual({});

      // Results directory should also be gone
      await expect(fs.access(resDir)).rejects.toThrow();
    });

    it("is a no-op when the file does not exist", async () => {
      await expect(clearSwappedFileStore(sessionPath())).resolves.toBeUndefined();
    });
  });

  describe("resultsDir", () => {
    it("returns path alongside session file", () => {
      const result = resultsDir("/data/sessions/abc.jsonl");
      expect(result).toBe("/data/sessions/abc.results");
    });
  });
});
