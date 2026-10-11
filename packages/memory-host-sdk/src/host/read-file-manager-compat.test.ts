// Memory Core tests cover manager.read file plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

function requireMemoryReadSuccess(result: Awaited<ReturnType<typeof readMemoryFile>>) {
  if (result.status === "not_found") {
    throw new Error(`expected memory content for ${result.path}`);
  }
  return result;
}

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let memoryDir: string;
  let extraDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-read-"));
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(
      [memoryDir, extraDir].map(async (root) => {
        const entries = await fs.readdir(root).catch(() => []);
        await Promise.all(
          entries.map(async (entry) => {
            await fs.rm(path.join(root, entry), { recursive: true, force: true });
          }),
        );
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns not found when the requested file does not exist", async () => {
    const relPath = "memory/2099-01-01.md";
    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: [],
      relPath,
    });
    expect(result).toEqual({ status: "not_found", text: "", path: relPath });
  });

  it("returns a default-sized excerpt when no line range is provided", async () => {
    const relPath = "memory/default-window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf-8",
    );

    const result = requireMemoryReadSuccess(
      await readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath,
      }),
    );

    expect(result.path).toBe(relPath);
    expect(result.from).toBe(1);
    expect(result.lines).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBe(121);
    expect(result.text).toContain("line 1");
    expect(result.text).toContain("line 120");
    expect(result.text).not.toContain("line 121");
    expect(result.text).toContain("Use from=121 to continue.");
  });

  it("does not advertise line continuation when a single oversized line is cut mid-line", async () => {
    const relPath = "memory/oversized-line-with-tail.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, [`1: ${"x".repeat(20_000)}`, "line 2"].join("\n"), "utf-8");

    const result = requireMemoryReadSuccess(
      await readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath,
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.lines).toBe(1);
    expect(result.nextFrom).toBeUndefined();
    expect(result.text).not.toContain("Use from=");
  });

  it("returns not found when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf-8");

    const realOpen = fs.open;
    let injected = false;
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
        const [target, flags, mode] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realOpen(target, flags, mode);
      });

    try {
      const result = await readMemoryFile({
        workspaceDir,
        extraPaths: [],
        relPath,
      });
      expect(result).toEqual({ status: "not_found", text: "", path: relPath });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("allows additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");
    await fs.writeFile(path.join(extraDir, "oversized.md"), `1: ${"y".repeat(20_000)}`);

    await expect(
      readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: "extra/extra.md",
      }),
    ).resolves.toEqual({
      status: "ok",
      path: "extra/extra.md",
      text: "Extra content.",
      from: 1,
      lines: 1,
    });

    const oversized = requireMemoryReadSuccess(
      await readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: "extra/oversized.md",
      }),
    );
    expect(oversized.truncated).toBe(true);
    expect(oversized.text).not.toContain("use read on the source file");

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: "extra/linked.md",
        }),
      ).rejects.toThrow("path is not an allowed Markdown memory file");
    }
  });
});
