import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterSessionSummaryDailyMemoryFiles,
  isDailyMemoryFileName,
  isSessionSummaryDailyMemory,
  listDailyMemoryFiles,
  listRecentDailyMemoryFiles,
  parseDailyMemoryFileName,
  rememberRecentDailyMemoryFile,
} from "./daily-files.js";

const tmpDirs: string[] = [];

async function makeMemoryDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-memory-"));
  tmpDirs.push(root);
  const memoryDir = path.join(root, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  return memoryDir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseDailyMemoryFileName", () => {
  it("accepts canonical and dated-slug memory files", () => {
    expect(parseDailyMemoryFileName("2026-04-19.md")).toMatchObject({
      day: "2026-04-19",
      canonical: true,
    });
    expect(parseDailyMemoryFileName("2026-04-19-session-reset.md")).toMatchObject({
      day: "2026-04-19",
      slug: "session-reset",
      canonical: false,
    });
  });

  it("rejects non-daily markdown names", () => {
    expect(parseDailyMemoryFileName("memory.md")).toBeNull();
    expect(parseDailyMemoryFileName("2026-04-19 notes.md")).toBeNull();
    expect(isDailyMemoryFileName("2026-04-19-topic.md")).toBe(true);
    expect(isDailyMemoryFileName("notes.md")).toBe(false);
  });
});

describe("listDailyMemoryFiles", () => {
  it("lists canonical and dated-slug files with stable ordering", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-topic.md"), "slugged", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-19.md"), "canonical", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-18-reset.md"), "older", "utf-8");
    await fs.writeFile(path.join(memoryDir, "notes.md"), "ignore", "utf-8");

    const files = await listDailyMemoryFiles(memoryDir);

    expect(files.map((file) => file.relativePath)).toEqual([
      "memory/2026-04-18-reset.md",
      "memory/2026-04-19.md",
      "memory/2026-04-19-topic.md",
    ]);
    expect(files[1]?.canonical).toBe(true);
    expect(files[2]?.canonical).toBe(false);
  });

  it("returns an empty list when the memory path is not a directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-memory-file-"));
    tmpDirs.push(root);
    const memoryPath = path.join(root, "memory");
    await fs.writeFile(memoryPath, "not a directory", "utf-8");

    await expect(listDailyMemoryFiles(memoryPath)).resolves.toEqual([]);
  });
});

describe("session summary helpers", () => {
  it("detects session-summary bookkeeping content", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 America/New_York",
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: abc123",
          "- **Source**: cli",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(isSessionSummaryDailyMemory("# Notes\n\nRegular daily memory.")).toBe(false);
  });

  it("filters session-summary bookkeeping files out of grounded-memory inputs", async () => {
    const memoryDir = await makeMemoryDir();
    const notePath = path.join(memoryDir, "2026-04-19.md");
    const sessionSummaryPath = path.join(memoryDir, "2026-04-19-session-reset.md");
    await fs.writeFile(notePath, "## Durable Notes\n\nKeep this.\n", "utf-8");
    await fs.writeFile(
      sessionSummaryPath,
      [
        "# Session: 2026-04-19 10:00:00 America/New_York",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await expect(
      filterSessionSummaryDailyMemoryFiles([notePath, sessionSummaryPath]),
    ).resolves.toEqual([notePath]);
  });
});

describe("listRecentDailyMemoryFiles", () => {
  it("returns canonical files plus indexed slugged files for the requested days", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19.md"), "canonical", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "slugged", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-18-wrap.md"), "older", "utf-8");
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-reset.md",
      mtimeMs: 200,
    });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-18-wrap.md",
      mtimeMs: 100,
    });

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19", "2026-04-18"],
    });

    expect(files.map((file) => file.relativePath)).toEqual([
      "memory/2026-04-19.md",
      "memory/2026-04-19-reset.md",
      "memory/2026-04-18-wrap.md",
    ]);
  });

  it("backfills the recent-file index from a one-time scan when no index exists", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "slugged", "utf-8");

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    expect(files.map((file) => file.relativePath)).toEqual(["memory/2026-04-19-reset.md"]);
    await expect(
      fs.access(path.join(path.dirname(memoryDir), ".openclaw", ".recent-daily-files.json")),
    ).resolves.toBeUndefined();
  });

  it("can resolve recent daily files without writing the recent-file index", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "slugged", "utf-8");

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
      persistIndex: false,
    });

    expect(files.map((file) => file.relativePath)).toEqual(["memory/2026-04-19-reset.md"]);
    await expect(
      fs.access(path.join(path.dirname(memoryDir), ".openclaw", ".recent-daily-files.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not stat unrelated historical files on the read-only no-index path", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "recent", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2025-01-01-old.md"), "old", "utf-8");

    const statSpy = vi.spyOn(fs, "stat");
    try {
      const files = await listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-19"],
        persistIndex: false,
      });

      expect(files.map((file) => file.relativePath)).toEqual(["memory/2026-04-19-reset.md"]);
      expect(
        statSpy.mock.calls.some(([target]) =>
          String(target).endsWith(path.join("memory", "2025-01-01-old.md")),
        ),
      ).toBe(false);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("rescans when new same-day files appear after the index already exists", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "first", "utf-8");

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    await fs.writeFile(path.join(memoryDir, "2026-04-19-manual.md"), "second", "utf-8");

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    expect(files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["memory/2026-04-19-reset.md", "memory/2026-04-19-manual.md"]),
    );
    expect(files).toHaveLength(2);
  });

  it("detects new same-day files even when directory mtimes are coarse", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19-reset.md"), "first", "utf-8");

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    const indexPath = path.join(path.dirname(memoryDir), ".openclaw", ".recent-daily-files.json");
    const indexStat = await fs.stat(indexPath);
    await fs.writeFile(path.join(memoryDir, "2026-04-19-manual.md"), "second", "utf-8");
    await fs.utimes(memoryDir, indexStat.atime, indexStat.mtime);

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    expect(files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["memory/2026-04-19-reset.md", "memory/2026-04-19-manual.md"]),
    );
    expect(files).toHaveLength(2);
  });

  it("falls back to a directory scan when the index does not cover a requested day", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-22-reset.md"), "older", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-25-reset.md"), "newer", "utf-8");
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-25-reset.md",
      mtimeMs: 200,
    });

    const files = await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-22", "2026-04-25"],
      persistIndex: false,
    });

    expect(files.map((file) => file.relativePath)).toEqual([
      "memory/2026-04-22-reset.md",
      "memory/2026-04-25-reset.md",
    ]);
  });
});
