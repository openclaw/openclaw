import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let memoryDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-read-"));
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    const entries = await fs.readdir(memoryDir).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        await fs.rm(path.join(memoryDir, entry), { recursive: true, force: true });
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns empty text when the requested file does not exist", async () => {
    const relPath = "memory/2099-01-01.md";
    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["line 1", "line 2", "line 3"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      from: 2,
      lines: 1,
    });
    expect(result).toEqual({ text: "line 2", path: relPath });
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta"].join("\n"), "utf-8");

    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
      from: 10,
      lines: 5,
    });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns empty text when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf-8");

    const realReadFile = fs.readFile;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realReadFile(target, options);
      });

    try {
      const result = await readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath,
      });
      expect(result).toEqual({ text: "", path: relPath });
    } finally {
      readSpy.mockRestore();
    }
  });
});
