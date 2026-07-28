// Memory Host SDK tests cover read file behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readMemoryFile } from "./read-file.js";

async function createDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

describe("readMemoryFile", () => {
  it.each([
    {
      name: "an empty file",
      content: "",
      from: 1,
      lines: 2,
      expected: { text: "", from: 1, lines: 0 },
    },
    {
      name: "an exact LF-terminated page",
      content: "one\ntwo\n",
      from: 1,
      lines: 2,
      expected: { text: "one\ntwo", from: 1, lines: 2 },
    },
    {
      name: "an exact CRLF-terminated page",
      content: "one\r\ntwo\r\n",
      from: 1,
      lines: 2,
      expected: { text: "one\r\ntwo\r", from: 1, lines: 2 },
    },
    {
      name: "an intentional trailing blank line",
      content: "one\n\n",
      from: 1,
      lines: 2,
      expected: { text: "one\n", from: 1, lines: 2 },
    },
    {
      name: "multiple intentional trailing blank lines",
      content: "one\n\n\n",
      from: 1,
      lines: 3,
      expected: { text: "one\n\n", from: 1, lines: 3 },
    },
    {
      name: "an intentional interior blank line",
      content: "one\n\ntwo\n",
      from: 1,
      lines: 3,
      expected: { text: "one\n\ntwo", from: 1, lines: 3 },
    },
    {
      name: "an offset ending at the final LF-terminated line",
      content: "one\ntwo\n",
      from: 2,
      lines: 1,
      expected: { text: "two", from: 2, lines: 1 },
    },
    {
      name: "an offset beyond the final LF-terminated line",
      content: "one\ntwo\n",
      from: 3,
      lines: 1,
      expected: { text: "", from: 3, lines: 0 },
    },
    {
      name: "a genuine continuation before the final LF-terminated line",
      content: "one\ntwo\n",
      from: 1,
      lines: 1,
      expected: {
        text: "one\n\n[More content available. Use from=2 to continue.]",
        from: 1,
        lines: 1,
        truncated: true,
        nextFrom: 2,
      },
    },
    {
      name: "a page without a final newline",
      content: "one\ntwo",
      from: 1,
      lines: 2,
      expected: { text: "one\ntwo", from: 1, lines: 2 },
    },
  ])("reads $name without a phantom continuation page", async (testCase) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-pagination-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const relPath = "memory/pagination.md";
      const absPath = path.join(workspaceDir, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, testCase.content, "utf-8");

      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [],
          relPath,
          from: testCase.from,
          lines: testCase.lines,
        }),
      ).resolves.toEqual({ ...testCase.expected, path: relPath });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns empty text for missing files under extra path directories", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const extraDir = path.join(tmpRoot, "extra");
      const missingPath = path.join(extraDir, "missing.md");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(extraDir, { recursive: true });

      const result = await readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: missingPath,
      });

      expect(result).toEqual({
        text: "",
        path: path.relative(workspaceDir, missingPath).replace(/\\/g, "/"),
      });

      const nonDirectoryParentPath = path.join(extraDir, "note.md", "child.md");
      await fs.writeFile(path.join(extraDir, "note.md"), "note", "utf-8");
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: nonDirectoryParentPath,
        }),
      ).resolves.toEqual({
        text: "",
        path: path.relative(workspaceDir, nonDirectoryParentPath).replace(/\\/g, "/"),
      });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects extra path reads through symlinked directory components", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const extraDir = path.join(tmpRoot, "extra");
      const outsideDir = path.join(tmpRoot, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(extraDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(extraDir, "inside.md"), "inside", "utf-8");
      await fs.writeFile(path.join(outsideDir, "private.md"), "private", "utf-8");

      const inside = await readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: path.join(extraDir, "inside.md"),
      });
      expect(inside.text).toBe("inside");

      const insideLinkPath = path.join(extraDir, "inside-link");
      if (!(await createDirectorySymlink(extraDir, insideLinkPath))) {
        return;
      }
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(insideLinkPath, "inside.md"),
        }),
      ).rejects.toThrow("path required");

      const outsideLinkPath = path.join(extraDir, "link");
      if (!(await createDirectorySymlink(outsideDir, outsideLinkPath))) {
        return;
      }

      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(outsideLinkPath, "private.md"),
        }),
      ).rejects.toThrow("path required");
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(outsideLinkPath, "missing.md"),
        }),
      ).rejects.toThrow("path required");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("retries transient read errors for workspace memory files", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const relPath = "memory/retry.md";
      const absPath = path.join(workspaceDir, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, "alpha\nbeta", "utf-8");

      const realOpen = fs.open;
      let attempts = 0;
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
          const [target, flags, mode] = args;
          if (typeof target === "string" && path.resolve(target) === absPath && attempts++ === 0) {
            const err = new Error(
              "Unknown system error -11: Unknown system error -11, open",
            ) as NodeJS.ErrnoException;
            err.code = "UNKNOWN";
            err.errno = -11;
            throw err;
          }
          return await realOpen(target, flags, mode);
        });

      try {
        await expect(
          readMemoryFile({
            workspaceDir,
            extraPaths: [],
            relPath,
          }),
        ).resolves.toEqual({
          text: "alpha\nbeta",
          path: relPath,
          from: 1,
          lines: 2,
        });
        expect(attempts).toBe(2);
      } finally {
        openSpy.mockRestore();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
