import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FLUSH_PROMPT,
  isNoFlushResponse,
  listFlushMemoryFiles,
  loadRecentMemories,
  readMemoryFile,
  resolveMemoryFilePath,
  resolveMemoryFlushDefaultConfig,
  shouldFlushMemory,
  writeMemoryFlush,
} from "./memory-flush-default.js";

const tmpDir = path.join(os.tmpdir(), `openclaw-memory-test-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("resolveMemoryFlushDefaultConfig", () => {
  it("returns defaults", () => {
    const config = resolveMemoryFlushDefaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.threshold).toBe(0.5);
    expect(config.model).toBe("anthropic/claude-haiku");
  });
});

describe("shouldFlushMemory", () => {
  const config = resolveMemoryFlushDefaultConfig();

  it("triggers when above threshold", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 60_000,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(true);
  });

  it("does not trigger when below threshold", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 40_000,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(false);
  });

  it("does not trigger when disabled", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 90_000,
        contextWindowTokens: 100_000,
        config: { ...config, enabled: false },
      }),
    ).toBe(false);
  });

  it("does not trigger with zero tokens", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 0,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(false);
  });

  it("skips if recently flushed with insufficient gain", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 55_000,
        contextWindowTokens: 100_000,
        config,
        lastFlushTokens: 52_000, // Only 3k tokens gained, need 10k (10%)
      }),
    ).toBe(false);
  });

  it("flushes again after sufficient gain", () => {
    expect(
      shouldFlushMemory({
        totalTokens: 70_000,
        contextWindowTokens: 100_000,
        config,
        lastFlushTokens: 50_000, // 20k tokens gained, above 10k threshold
      }),
    ).toBe(true);
  });
});

describe("isNoFlushResponse", () => {
  it("detects NO_FLUSH", () => {
    expect(isNoFlushResponse("NO_FLUSH")).toBe(true);
    expect(isNoFlushResponse("  NO_FLUSH  ")).toBe(true);
    expect(isNoFlushResponse("no_flush")).toBe(true);
  });

  it("rejects real content", () => {
    expect(isNoFlushResponse("User decided to use TypeScript")).toBe(false);
    expect(isNoFlushResponse("Key decision: migrate to PostgreSQL")).toBe(false);
  });
});

describe("resolveMemoryFilePath", () => {
  it("generates date-based path", () => {
    const date = new Date(2025, 0, 15);
    const filePath = resolveMemoryFilePath("/memory", date);
    expect(filePath).toBe(path.join("/memory", "2025-01-15.md"));
  });

  it("pads month and day", () => {
    const date = new Date(2025, 2, 5);
    const filePath = resolveMemoryFilePath("/memory", date);
    expect(filePath).toBe(path.join("/memory", "2025-03-05.md"));
  });
});

describe("writeMemoryFlush", () => {
  it("writes memory to file", async () => {
    const memoryDir = path.join(tmpDir, "write-test");
    const result = await writeMemoryFlush({
      content: "User prefers TypeScript over JavaScript.",
      memoryDir,
      date: new Date(2025, 0, 1),
    });
    expect(result.written).toBe(true);
    expect(result.filePath).toContain("2025-01-01.md");

    const content = await fs.readFile(result.filePath, "utf8");
    expect(content).toContain("User prefers TypeScript");
    expect(content).toContain("Flushed at");
  });

  it("skips NO_FLUSH responses", async () => {
    const memoryDir = path.join(tmpDir, "nofflush-test");
    const result = await writeMemoryFlush({
      content: "NO_FLUSH",
      memoryDir,
    });
    expect(result.written).toBe(false);
  });

  it("appends to existing files", async () => {
    const memoryDir = path.join(tmpDir, "append-test");
    const date = new Date(2025, 5, 15);

    await writeMemoryFlush({
      content: "First entry",
      memoryDir,
      date,
    });
    await writeMemoryFlush({
      content: "Second entry",
      memoryDir,
      date,
    });

    const filePath = resolveMemoryFilePath(memoryDir, date);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("First entry");
    expect(content).toContain("Second entry");
  });
});

describe("listFlushMemoryFiles", () => {
  it("lists memory files sorted by date (newest first)", async () => {
    const memoryDir = path.join(tmpDir, "list-test");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2025-01-01.md"), "old");
    await fs.writeFile(path.join(memoryDir, "2025-03-15.md"), "new");
    await fs.writeFile(path.join(memoryDir, "not-a-memory.txt"), "ignore");

    const files = await listFlushMemoryFiles(memoryDir);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("2025-03-15.md");
    expect(files[1].name).toBe("2025-01-01.md");
  });

  it("returns empty for non-existent directory", async () => {
    const files = await listFlushMemoryFiles("/nonexistent/path");
    expect(files).toEqual([]);
  });
});

describe("loadRecentMemories", () => {
  it("loads recent memory entries", async () => {
    const memoryDir = path.join(tmpDir, "load-test");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2025-01-01.md"), "Day 1 memories");
    await fs.writeFile(path.join(memoryDir, "2025-01-02.md"), "Day 2 memories");

    const result = await loadRecentMemories({ memoryDir, maxDays: 7 });
    expect(result).toContain("Recent Memories");
    expect(result).toContain("Day 1 memories");
    expect(result).toContain("Day 2 memories");
  });

  it("returns empty string for no memories", async () => {
    const result = await loadRecentMemories({
      memoryDir: "/nonexistent/path",
    });
    expect(result).toBe("");
  });

  it("respects maxChars limit", async () => {
    const memoryDir = path.join(tmpDir, "maxchars-test");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2025-01-01.md"), "x".repeat(5000));

    const result = await loadRecentMemories({
      memoryDir,
      maxDays: 7,
      maxChars: 100,
    });
    expect(result.length).toBeLessThan(300); // header + truncated content
  });
});

describe("readMemoryFile and deleteMemoryFile", () => {
  it("reads existing file", async () => {
    const filePath = path.join(tmpDir, "read-test.md");
    await fs.writeFile(filePath, "test content");
    const content = await readMemoryFile(filePath);
    expect(content).toBe("test content");
  });

  it("returns null for missing file", async () => {
    const content = await readMemoryFile("/nonexistent/file.md");
    expect(content).toBeNull();
  });
});

describe("DEFAULT_FLUSH_PROMPT", () => {
  it("includes key extraction instructions", () => {
    expect(DEFAULT_FLUSH_PROMPT).toContain("decisions");
    expect(DEFAULT_FLUSH_PROMPT).toContain("action items");
    expect(DEFAULT_FLUSH_PROMPT).toContain("NO_FLUSH");
  });
});
