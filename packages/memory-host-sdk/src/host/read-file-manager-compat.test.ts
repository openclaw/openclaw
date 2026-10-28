import fs from "node:fs/promises";
import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function requireMemoryReadSuccess(result: Awaited<ReturnType<typeof readMemoryFile>>) {
  assert(result.status === "ok", `expected memory content for ${result.path}`);
  return result;
}

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let extraDir: string;
  beforeEach(async () => {
    workspaceDir = tempDirs.make("openclaw-mem-read-");
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });
  async function write(relPath: string, content: string) {
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    return absPath;
  }
  const read = (
    relPath: string,
    extraPaths: string[] = [],
    options: Partial<Parameters<typeof readMemoryFile>[0]> = {},
  ) => readMemoryFile({ workspaceDir, extraPaths, relPath, ...options });
  const numberedLines = (count: number, suffix = "") =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}${suffix}`).join("\n");

  it("returns not found when the requested file does not exist", async () => {
    const relPath = "memory/2099-01-01.md";
    const result = await read(relPath);
    expect(result).toEqual({ status: "not_found", text: "", path: relPath });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    await write(relPath, numberedLines(3));
    const result = await read(relPath, [], { from: 2, lines: 1 });
    expect(result).toEqual({
      status: "ok",
      text: "line 2\n\n[More content available. Use from=3 to continue.]",
      path: relPath,
      from: 2,
      lines: 1,
      truncated: true,
      nextFrom: 3,
    });
  });

  it.each([undefined, 21])("returns a default-sized excerpt starting at %s", async (from) => {
    const relPath = "memory/default-window.md";
    await write(relPath, numberedLines(160));
    const start = from ?? 1;
    const nextFrom = start + 120;
    const result = requireMemoryReadSuccess(await read(relPath, [], { from }));
    expect(result).toMatchObject({
      path: relPath,
      from: start,
      lines: 120,
      truncated: true,
      nextFrom,
    });
    expect(result.text).toContain(`line ${start}`);
    expect(result.text).toContain(`line ${nextFrom - 1}`);
    expect(result.text).not.toContain(`line ${nextFrom}`);
    expect(result.text).toContain(`Use from=${nextFrom} to continue.`);
  });

  it("honors injected defaultLines and maxChars overrides", async () => {
    const relPath = "memory/agent-limits.md";
    await write(relPath, numberedLines(40, `: ${"x".repeat(40)}`));
    const result = requireMemoryReadSuccess(
      await read(relPath, [], { defaultLines: 5, maxChars: 220 }),
    );
    expect(result).toMatchObject({ from: 1, truncated: true });
    expect(result.lines).toBeLessThanOrEqual(5);
    expect(result.nextFrom).toBeGreaterThan(1);
    expect(result.text).toContain("Use from=");
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    await write(relPath, "alpha\nbeta");
    const result = await read(relPath, [], { from: 10, lines: 5 });
    expect(result).toEqual({ status: "ok", text: "", path: relPath, from: 10, lines: 0 });
  });

  it("caps returned text to the default max chars and exposes continuation metadata", async () => {
    const relPath = "memory/char-cap.md";
    await write(relPath, numberedLines(200, `: ${"x".repeat(200)}`));
    const result = requireMemoryReadSuccess(await read(relPath));

    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBeGreaterThan(1);
    expect(result.lines).toBeLessThan(120);
    expect(result.text.length).toBeLessThanOrEqual(12_000 + 64);
    expect(result.text).toContain("Use from=");
  });

  it.each(["", "\nline 2"])(
    "truncates oversized workspace lines without continuation (%j)",
    async (tail) => {
      const relPath = "memory/oversized-line.md";
      await write(relPath, `1: ${"x".repeat(20_000)}${tail}`);
      const result = requireMemoryReadSuccess(await read(relPath));
      expect(result).toMatchObject({ truncated: true, lines: 1 });
      expect(result.nextFrom).toBeUndefined();
      expect(result.text).toContain("use read on the source file");
      expect(result.text).not.toContain("Use from=");
    },
  );

  it("omits truncation metadata when the full excerpt fits and no more lines remain", async () => {
    const relPath = "memory/complete.md";
    await write(relPath, "alpha\nbeta\ngamma");
    expect(await read(relPath)).toEqual({
      status: "ok",
      text: "alpha\nbeta\ngamma",
      path: relPath,
      from: 1,
      lines: 3,
    });
  });

  it("returns not found when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = await write(relPath, "first\nsecond");

    const realOpen = fs.open;
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const [target, flags, mode] = args;
      if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
        injected = true;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return realOpen(target, flags, mode);
    });

    expect(await read(relPath)).toEqual({ status: "not_found", text: "", path: relPath });
  });

  it("rejects non-memory paths", async () => {
    await expect(read("NOTES.md")).rejects.toThrow("path is not an allowed Markdown memory file");
  });

  it("allows additional memory paths and blocks symlinks", async () => {
    await write("extra/extra.md", "Extra content.");
    await write("extra/oversized.md", `1: ${"y".repeat(20_000)}`);

    await expect(read("extra/extra.md", [extraDir])).resolves.toEqual({
      status: "ok",
      path: "extra/extra.md",
      text: "Extra content.",
      from: 1,
      lines: 1,
    });

    const oversized = requireMemoryReadSuccess(await read("extra/oversized.md", [extraDir]));
    expect(oversized.truncated).toBe(true);
    expect(oversized.text).not.toContain("use read on the source file");

    const linkPath = path.join(extraDir, "linked.md");
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return;
      }
      throw err;
    }
    await expect(read("extra/linked.md", [extraDir])).rejects.toThrow(
      "path is not an allowed Markdown memory file",
    );
  });
});
