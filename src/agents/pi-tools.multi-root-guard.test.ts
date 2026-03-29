import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  assertAliasSafe,
  validatePathAgainstRoots,
  findMatchingRoot,
  wrapToolMultiRootGuard,
  type FsRootResolved,
} from "./pi-tools.multi-root-guard.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRoots(
  ...entries: Array<{ path: string; kind: "dir" | "file"; access: "ro" | "rw" }>
): FsRootResolved[] {
  return entries.map((e) => ({ ...e, resolvedPath: path.resolve(e.path) }));
}

describe("validatePathAgainstRoots", () => {
  const roots = makeRoots(
    { path: "/workspace", kind: "dir", access: "rw" },
    { path: "/data/finance", kind: "dir", access: "ro" },
    { path: "/data/context.md", kind: "file", access: "ro" },
  );

  it("allows read inside rw dir root", () => {
    expect(() => validatePathAgainstRoots("/workspace/file.txt", "read", roots)).not.toThrow();
  });

  it("allows write inside rw dir root", () => {
    expect(() => validatePathAgainstRoots("/workspace/file.txt", "write", roots)).not.toThrow();
  });

  it("allows read inside ro dir root", () => {
    expect(() => validatePathAgainstRoots("/data/finance/report.pdf", "read", roots)).not.toThrow();
  });

  it("rejects write inside ro dir root", () => {
    expect(() => validatePathAgainstRoots("/data/finance/report.pdf", "write", roots)).toThrow(
      /read-only/,
    );
  });

  it("allows read of exact file root", () => {
    expect(() => validatePathAgainstRoots("/data/context.md", "read", roots)).not.toThrow();
  });

  it("rejects read of file under file root (not a dir)", () => {
    expect(() => validatePathAgainstRoots("/data/context.md/sub", "read", roots)).toThrow(
      /outside.*roots/,
    );
  });

  it("rejects path outside all roots", () => {
    expect(() => validatePathAgainstRoots("/etc/passwd", "read", roots)).toThrow(/outside.*roots/);
  });

  it("rejects path that is a prefix but not path-separator-aware", () => {
    expect(() => validatePathAgainstRoots("/data/finance-secret/file.txt", "read", roots)).toThrow(
      /outside.*roots/,
    );
  });

  it("allows dir root path itself", () => {
    expect(() => validatePathAgainstRoots("/workspace", "read", roots)).not.toThrow();
  });

  it("allows nested paths in dir root", () => {
    expect(() => validatePathAgainstRoots("/workspace/a/b/c/d.txt", "read", roots)).not.toThrow();
  });

  it("allows write to file root with rw access", () => {
    const rwFileRoots = makeRoots({ path: "/data/output.json", kind: "file", access: "rw" });
    expect(() => validatePathAgainstRoots("/data/output.json", "write", rwFileRoots)).not.toThrow();
  });

  it("rejects all paths when roots array is empty", () => {
    expect(() => validatePathAgainstRoots("/workspace/file.txt", "read", [])).toThrow(
      /outside.*roots/,
    );
  });

  it("handles paths with .. components after resolution", () => {
    expect(() =>
      validatePathAgainstRoots("/workspace/a/../b/file.txt", "read", roots),
    ).not.toThrow();
  });

  it("handles trailing slashes on paths", () => {
    expect(() => validatePathAgainstRoots("/workspace/", "read", roots)).not.toThrow();
  });

  it("most-specific root wins for overlapping dir roots", () => {
    const overlapping = makeRoots(
      { path: "/data", kind: "dir", access: "ro" },
      { path: "/data/project", kind: "dir", access: "rw" },
    );
    // Write under /data/project should succeed (rw), not fail because /data is ro
    expect(() =>
      validatePathAgainstRoots("/data/project/file.txt", "write", overlapping),
    ).not.toThrow();
    // Write under /data (outside /data/project) should still fail (ro)
    expect(() => validatePathAgainstRoots("/data/other/file.txt", "write", overlapping)).toThrow(
      /read-only/,
    );
  });

  it("most-specific root wins regardless of order", () => {
    // Same roots but reversed order — should produce same result
    const overlapping = makeRoots(
      { path: "/data/project", kind: "dir", access: "rw" },
      { path: "/data", kind: "dir", access: "ro" },
    );
    expect(() =>
      validatePathAgainstRoots("/data/project/file.txt", "write", overlapping),
    ).not.toThrow();
    expect(() => validatePathAgainstRoots("/data/other/file.txt", "write", overlapping)).toThrow(
      /read-only/,
    );
  });

  it("file root takes precedence over dir root for exact match", () => {
    const mixed = makeRoots(
      { path: "/data", kind: "dir", access: "rw" },
      { path: "/data/secret.md", kind: "file", access: "ro" },
    );
    // Exact file match uses file root (ro), not dir root (rw)
    expect(() => validatePathAgainstRoots("/data/secret.md", "write", mixed)).toThrow(/read-only/);
    // Other files under /data use dir root (rw)
    expect(() => validatePathAgainstRoots("/data/other.md", "write", mixed)).not.toThrow();
  });
});

describe("findMatchingRoot", () => {
  const roots = makeRoots(
    { path: "/workspace", kind: "dir", access: "rw" },
    { path: "/data/context.md", kind: "file", access: "ro" },
  );

  it("returns undefined for empty roots", () => {
    expect(findMatchingRoot("/workspace/file.txt", [])).toBeUndefined();
  });

  it("returns undefined for path outside all roots", () => {
    expect(findMatchingRoot("/etc/passwd", roots)).toBeUndefined();
  });

  it("returns the matching dir root", () => {
    const match = findMatchingRoot("/workspace/file.txt", roots);
    expect(match?.path).toBe("/workspace");
    expect(match?.kind).toBe("dir");
  });

  it("returns the matching file root for exact match", () => {
    const match = findMatchingRoot("/data/context.md", roots);
    expect(match?.path).toBe("/data/context.md");
    expect(match?.kind).toBe("file");
  });
});

describe("assertAliasSafe", () => {
  it.runIf(process.platform !== "win32")(
    "rejects writes through a symlink alias to a read-only file root",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const dataDir = path.join(root, "data");
          await fs.mkdir(dataDir, { recursive: true });
          const secretFile = path.join(dataDir, "secret.txt");
          const aliasFile = path.join(dataDir, "alias.txt");
          await fs.writeFile(secretFile, "secret");
          await fs.symlink(secretFile, aliasFile);

          const roots = makeRoots(
            { path: dataDir, kind: "dir", access: "rw" },
            { path: secretFile, kind: "file", access: "ro" },
          );

          expect(() => validatePathAgainstRoots(aliasFile, "write", roots)).not.toThrow();
          await expect(assertAliasSafe(aliasFile, roots, { operation: "write" })).rejects.toThrow(
            /read-only file root/,
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves unlink semantics for final symlink aliases inside allowed dir roots",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const dataDir = path.join(root, "data");
          await fs.mkdir(dataDir, { recursive: true });
          const secretFile = path.join(dataDir, "secret.txt");
          const aliasFile = path.join(dataDir, "alias.txt");
          await fs.writeFile(secretFile, "secret");
          await fs.symlink(secretFile, aliasFile);

          const roots = makeRoots({ path: dataDir, kind: "dir", access: "rw" });

          expect(() => validatePathAgainstRoots(aliasFile, "write", roots)).not.toThrow();
          await expect(
            assertAliasSafe(aliasFile, roots, {
              operation: "write",
              allowFinalSymlinkForUnlink: true,
            }),
          ).resolves.toBeUndefined();
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects unlinks when a canonical read-only file root is stricter than an alias rw dir root",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const dataDir = path.join(root, "data");
          await fs.mkdir(dataDir, { recursive: true });
          const secretFile = path.join(dataDir, "secret.txt");
          const aliasFile = path.join(dataDir, "alias.txt");
          await fs.writeFile(secretFile, "secret");
          await fs.symlink(secretFile, aliasFile);

          const roots = makeRoots(
            { path: dataDir, kind: "dir", access: "rw" },
            { path: secretFile, kind: "file", access: "ro" },
          );

          expect(() => validatePathAgainstRoots(aliasFile, "write", roots)).not.toThrow();
          await expect(
            assertAliasSafe(aliasFile, roots, {
              operation: "write",
              allowFinalSymlinkForUnlink: true,
            }),
          ).rejects.toThrow(/read-only file root/);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows canonical target checks when a configured root includes a symlink segment",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const realDir = path.join(root, "real-data");
          const linkedDir = path.join(root, "data-link");
          await fs.mkdir(realDir, { recursive: true });
          await fs.symlink(realDir, linkedDir);

          const linkedFile = path.join(linkedDir, "note.txt");
          await fs.writeFile(path.join(realDir, "note.txt"), "hello");

          const roots = makeRoots({ path: linkedDir, kind: "dir", access: "rw" });

          expect(() => validatePathAgainstRoots(linkedFile, "write", roots)).not.toThrow();
          await expect(assertAliasSafe(linkedFile, roots, { operation: "write" })).resolves.toBe(
            undefined,
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects missing write targets when a rw alias root canonicalizes inside a ro root",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const realDir = path.join(root, "real-data");
          const linkedDir = path.join(root, "data-link");
          await fs.mkdir(realDir, { recursive: true });
          await fs.symlink(realDir, linkedDir);

          const newFile = path.join(linkedDir, "new.txt");
          const roots = makeRoots(
            { path: linkedDir, kind: "dir", access: "rw" },
            { path: realDir, kind: "dir", access: "ro" },
          );

          expect(() => validatePathAgainstRoots(newFile, "write", roots)).not.toThrow();
          await expect(assertAliasSafe(newFile, roots, { operation: "write" })).rejects.toThrow(
            /read-only root/,
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows missing roots that canonicalize through a symlinked ancestor",
    async () => {
      await withTempDir(
        { prefix: "openclaw-fs-roots-", parentDir: process.cwd() },
        async (root) => {
          const realDir = path.join(root, "real-data");
          const linkedDir = path.join(root, "data-link");
          await fs.mkdir(realDir, { recursive: true });
          await fs.symlink(realDir, linkedDir);

          const missingRoot = path.join(linkedDir, "newdir");
          const newFile = path.join(missingRoot, "note.txt");
          const roots = makeRoots({ path: missingRoot, kind: "dir", access: "rw" });

          expect(() => validatePathAgainstRoots(newFile, "write", roots)).not.toThrow();
          await expect(assertAliasSafe(newFile, roots, { operation: "write" })).resolves.toBe(
            undefined,
          );
        },
      );
    },
  );
});

describe("wrapToolMultiRootGuard", () => {
  it("expands home-relative paths before validating fs roots", async () => {
    await withTempDir({ prefix: "openclaw-fs-roots-", parentDir: process.cwd() }, async (root) => {
      const homeDir = path.join(root, "home");
      const workspaceDir = path.join(root, "workspace");
      const sharedDir = path.join(homeDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });

      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("OPENCLAW_HOME", "");

      const execute = vi.fn(async () => ({
        content: [{ type: "text", text: "ok" }] as const,
        isError: false,
      }));
      const wrapped = wrapToolMultiRootGuard(
        {
          name: "read",
          description: "read",
          inputSchema: { type: "object" },
          execute,
        } as never,
        workspaceDir,
        makeRoots({ path: sharedDir, kind: "dir", access: "rw" }),
      );

      await expect(
        wrapped.execute("tc-home-root", { path: "~/shared/file.txt" }, undefined, undefined),
      ).resolves.toMatchObject({ isError: false });
      expect(execute).toHaveBeenCalledOnce();
    });
  });
});
