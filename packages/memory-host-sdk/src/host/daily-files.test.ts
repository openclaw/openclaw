import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listDailyMemoryFiles,
  listRecentDailyMemoryFiles,
  readRememberedDailyMemoryFile,
  rememberRecentDailyMemoryFile,
} from "./daily-files.js";
import { SESSION_SUMMARY_DAILY_MEMORY_SENTINEL } from "./daily-session-summary.js";

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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("detects session-summary provenance when a one-time scan seeds the recent-file index", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19-reset.md"),
      [
        "# Session: 2026-04-19 10:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-19-reset.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-19-reset.md",
      sessionSummary: true,
    });
  });

  it("detects canonical session-summary provenance when a one-time scan seeds the recent-file index", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19.md"),
      [
        "# Session: 2026-04-19 10:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-19.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-19.md",
      sessionSummary: true,
    });
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

  it("persists session-summary provenance for newly discovered same-day files", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(path.join(memoryDir, "2026-04-19.md"), "canonical", "utf-8");

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    await fs.writeFile(
      path.join(memoryDir, "2026-04-19-reset.md"),
      [
        "# Session: 2026-04-19 10:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-19"],
    });

    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-19-reset.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-19-reset.md",
      sessionSummary: true,
    });
  });

  it("refreshes session-summary provenance when a tracked durable file is rewritten in place", async () => {
    const memoryDir = await makeMemoryDir();
    const fileName = "2026-04-25-vendor-pitch.md";
    const filePath = path.join(memoryDir, fileName);
    await fs.writeFile(filePath, "durable note\n", "utf-8");

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-25"],
    });

    await fs.writeFile(
      filePath,
      [
        "# Session: 2026-04-25 12:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.utimes(
      filePath,
      new Date("2026-04-25T12:00:00.000Z"),
      new Date("2026-04-25T12:00:00.000Z"),
    );

    await expect(
      listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-25"],
      }),
    ).resolves.toEqual([expect.objectContaining({ fileName, sessionSummary: true })]);
    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName,
      }),
    ).resolves.toMatchObject({
      fileName,
      sessionSummary: true,
    });
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

  it("remembers session-summary provenance for deleted-file cleanup", async () => {
    const memoryDir = await makeMemoryDir();
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-25-vendor-pitch.md",
      mtimeMs: 200,
      sessionSummary: true,
    });

    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-25-vendor-pitch.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-25-vendor-pitch.md",
      sessionSummary: true,
    });
  });

  it("waits on the recent-daily sidecar lock before updating the index", async () => {
    const memoryDir = await makeMemoryDir();
    const indexPath = path.join(path.dirname(memoryDir), ".openclaw", ".recent-daily-files.json");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(
      `${indexPath}.lock`,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    let settled = false;
    const pending = rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-25-session-reset.md",
      sessionSummary: true,
    }).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);

    await fs.rm(`${indexPath}.lock`, { force: true });
    await pending;

    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-25-session-reset.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-25-session-reset.md",
      sessionSummary: true,
    });
  });

  it("preserves remembered session-summary provenance across recent-file index refreshes", async () => {
    const memoryDir = await makeMemoryDir();
    await fs.writeFile(
      path.join(memoryDir, "2026-04-25-session-reset.md"),
      [
        "# Session: 2026-04-25 12:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
      ].join("\n"),
      "utf-8",
    );
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-25-session-reset.md",
      mtimeMs: 100,
      sessionSummary: true,
    });
    await fs.writeFile(path.join(memoryDir, "2026-04-25-manual.md"), "manual", "utf-8");

    await expect(
      listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-25"],
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "2026-04-25-session-reset.md" }),
        expect.objectContaining({ fileName: "2026-04-25-manual.md" }),
      ]),
    );
    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-25-session-reset.md",
      }),
    ).resolves.toMatchObject({
      fileName: "2026-04-25-session-reset.md",
      sessionSummary: true,
    });
  });

  it("re-reads the current index before refreshing target days under the sidecar lock", async () => {
    const memoryDir = await makeMemoryDir();
    const fileName = "2026-04-25-session-reset.md";
    const filePath = path.join(memoryDir, fileName);
    await fs.writeFile(filePath, "bookkeeping note\n", "utf-8");
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName,
      mtimeMs: 100,
      sessionSummary: true,
    });
    await fs.utimes(
      filePath,
      new Date("2026-04-25T12:00:00.000Z"),
      new Date("2026-04-25T12:00:00.000Z"),
    );

    const readdirGate = createDeferred();
    const originalReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      const [target] = args;
      if (String(target) === memoryDir) {
        await readdirGate.promise;
      }
      return await originalReaddir(...args);
    }) as typeof fs.readdir);

    try {
      const pending = listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-25"],
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await rememberRecentDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-26-reset.md",
        mtimeMs: 200,
        sessionSummary: true,
      });
      readdirGate.resolve();

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          fileName,
        }),
      ]);
      await expect(
        readRememberedDailyMemoryFile({
          memoryDir,
          fileName: "2026-04-26-reset.md",
        }),
      ).resolves.toMatchObject({
        fileName: "2026-04-26-reset.md",
        sessionSummary: true,
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("clears remembered session-summary provenance when a full rescan finds no daily files", async () => {
    const memoryDir = await makeMemoryDir();
    const fileName = "2026-04-25-session-reset.md";
    const filePath = path.join(memoryDir, fileName);
    await fs.writeFile(
      filePath,
      [
        "# Session: 2026-04-25 12:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await listRecentDailyMemoryFiles({
      memoryDir,
      days: ["2026-04-25"],
    });

    const indexPath = path.join(path.dirname(memoryDir), ".openclaw", ".recent-daily-files.json");
    const indexStat = await fs.stat(indexPath);
    await fs.rm(filePath, { force: true });
    await fs.utimes(
      memoryDir,
      new Date(indexStat.atimeMs + 1000),
      new Date(indexStat.mtimeMs + 1000),
    );

    await expect(
      listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-25"],
      }),
    ).resolves.toEqual([]);
    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName,
      }),
    ).resolves.toBeNull();
  });

  it("clears stale session-summary provenance when a live file was replaced with durable content", async () => {
    const memoryDir = await makeMemoryDir();
    const fileName = "2026-04-25-vendor-pitch.md";
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName,
      mtimeMs: 100,
      sessionSummary: true,
    });
    await fs.writeFile(path.join(memoryDir, fileName), "real durable note\n", "utf-8");

    await expect(
      listRecentDailyMemoryFiles({
        memoryDir,
        days: ["2026-04-25"],
      }),
    ).resolves.toEqual([expect.objectContaining({ fileName })]);
    const remembered = await readRememberedDailyMemoryFile({
      memoryDir,
      fileName,
    });
    expect(remembered?.fileName).toBe(fileName);
    expect(remembered?.sessionSummary).toBeUndefined();
  });
});
