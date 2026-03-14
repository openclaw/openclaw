import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImports } from "./resolve-imports.js";

async function makeTempDir(prefix = "openclaw-import-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("resolveImports", () => {
  it("returns content unchanged when no directives are present", async () => {
    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "# Hello\n\nSome content.\n", "utf-8");

    const result = await resolveImports("# Hello\n\nSome content.\n", filePath);
    expect(result).toBe("# Hello\n\nSome content.\n");
  });

  it("expands a single @ import", async () => {
    const tmpDir = await makeTempDir();
    const sharedPath = path.join(tmpDir, "SHARED.md");
    await fs.writeFile(sharedPath, "shared content", "utf-8");

    const filePath = path.join(tmpDir, "sub", "FILE.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "@../SHARED.md\n", "utf-8");

    const result = await resolveImports("@../SHARED.md\n", filePath);
    expect(result).toBe("shared content\n");
  });

  it("expands nested imports (depth 2)", async () => {
    const tmpDir = await makeTempDir();
    const cPath = path.join(tmpDir, "C.md");
    await fs.writeFile(cPath, "leaf", "utf-8");

    const bPath = path.join(tmpDir, "B.md");
    await fs.writeFile(bPath, "@C.md", "utf-8");

    const aPath = path.join(tmpDir, "A.md");
    await fs.writeFile(aPath, "@B.md", "utf-8");

    const result = await resolveImports("@B.md", aPath);
    expect(result).toBe("leaf");
  });

  it("stops expanding at max depth", async () => {
    const tmpDir = await makeTempDir();
    // Create a chain: A -> B -> C -> D -> E
    // With maxDepth=2, D's import of E should not expand.
    await fs.writeFile(path.join(tmpDir, "E.md"), "end", "utf-8");
    await fs.writeFile(path.join(tmpDir, "D.md"), "@E.md", "utf-8");
    await fs.writeFile(path.join(tmpDir, "C.md"), "@D.md", "utf-8");
    await fs.writeFile(path.join(tmpDir, "B.md"), "@C.md", "utf-8");

    const aPath = path.join(tmpDir, "A.md");
    await fs.writeFile(aPath, "@B.md", "utf-8");

    const result = await resolveImports("@B.md", aPath, { maxDepth: 2 });
    // depth 0: A expands B → depth 1: B expands C → depth 2: at max, C's "@D.md" left as-is
    expect(result).toBe("@D.md");
  });

  it("detects circular imports and leaves directive unexpanded", async () => {
    const tmpDir = await makeTempDir();
    const aPath = path.join(tmpDir, "A.md");
    const bPath = path.join(tmpDir, "B.md");
    await fs.writeFile(aPath, "@B.md", "utf-8");
    await fs.writeFile(bPath, "@A.md", "utf-8");

    const result = await resolveImports("@B.md", aPath);
    // A imports B, B tries to import A (cycle) → left as-is
    expect(result).toBe("@A.md");
  });

  it("replaces directive with an empty string when referenced file is missing", async () => {
    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "@missing.md", "utf-8");

    const result = await resolveImports("@missing.md", filePath);
    expect(result).toBe("");
  });

  it("handles leading whitespace before @ directive", async () => {
    const tmpDir = await makeTempDir();
    const sharedPath = path.join(tmpDir, "SHARED.md");
    await fs.writeFile(sharedPath, "imported", "utf-8");

    const filePath = path.join(tmpDir, "FILE.md");
    const content = "  @SHARED.md";

    const result = await resolveImports(content, filePath);
    expect(result).toBe("imported");
  });

  it("does not treat non-.md @ references as imports", async () => {
    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "@data.txt\n@user\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "data.txt"), "text data", "utf-8");

    const result = await resolveImports("@data.txt\n@user\n", filePath);
    expect(result).toBe("@data.txt\n@user\n");
  });

  it("handles mixed content with directives interspersed", async () => {
    const tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "SHARED.md"), "injected", "utf-8");

    const filePath = path.join(tmpDir, "FILE.md");
    const content = "# Title\n\n@SHARED.md\n\nMore text.\n";

    const result = await resolveImports(content, filePath);
    expect(result).toBe("# Title\n\ninjected\n\nMore text.\n");
  });

  it("does not expand self-import", async () => {
    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "@FILE.md", "utf-8");

    const result = await resolveImports("@FILE.md", filePath);
    expect(result).toBe("@FILE.md");
  });

  it("works with cross-directory imports within boundary (simulating cross-workspace)", async () => {
    const tmpDir = await makeTempDir();
    // Simulate: .openclaw/USER.md and .openclaw/workspace-agent-a/USER.md
    const globalDir = path.join(tmpDir, ".openclaw");
    const agentDir = path.join(tmpDir, ".openclaw", "workspace-agent-a");
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(path.join(globalDir, "USER.md"), "# Global User\nName: Alice", "utf-8");
    const agentUserPath = path.join(agentDir, "USER.md");
    await fs.writeFile(agentUserPath, "@../USER.md", "utf-8");

    const result = await resolveImports("@../USER.md", agentUserPath, {
      boundaryDir: globalDir,
    });
    expect(result).toBe("# Global User\nName: Alice");
  });

  it("blocks imports that escape the boundary directory", async () => {
    const tmpDir = await makeTempDir();
    // .openclaw/workspace/FILE.md tries to import ../../secret.md (outside .openclaw/)
    const openclawDir = path.join(tmpDir, ".openclaw");
    const workspaceDir = path.join(openclawDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const secretPath = path.join(tmpDir, "secret.md");
    await fs.writeFile(secretPath, "top secret", "utf-8");

    const filePath = path.join(workspaceDir, "FILE.md");
    await fs.writeFile(filePath, "@../../secret.md", "utf-8");

    const result = await resolveImports("@../../secret.md", filePath, {
      boundaryDir: openclawDir,
    });
    // Directive left unexpanded because target is outside .openclaw/
    expect(result).toBe("@../../secret.md");
  });

  it("truncates imported content exceeding 4KB to exactly 4096 chars", async () => {
    const tmpDir = await makeTempDir();
    const bigContent = "x".repeat(8000);
    await fs.writeFile(path.join(tmpDir, "BIG.md"), bigContent, "utf-8");

    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "@BIG.md", "utf-8");

    const result = await resolveImports("@BIG.md", filePath);
    expect(result.length).toBe(4096);
    expect(result.endsWith("...TRUNCATED...")).toBe(true);
    expect(result.slice(0, 4096 - 15)).toBe("x".repeat(4096 - 15));
  });

  it("rejects hardlinked import targets", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = await makeTempDir();
    const originalPath = path.join(tmpDir, "ORIGINAL.md");
    await fs.writeFile(originalPath, "secret content", "utf-8");

    // Create a hardlink to the original file
    const hardlinkPath = path.join(tmpDir, "LINK.md");
    await fs.link(originalPath, hardlinkPath);

    const filePath = path.join(tmpDir, "FILE.md");
    await fs.writeFile(filePath, "@LINK.md", "utf-8");

    const result = await resolveImports("@LINK.md", filePath);
    // Hardlinked file (nlink > 1) should be rejected
    expect(result).toBe("@LINK.md");
  });

  it("recurses nested imports from canonical path, handling symlinks correctly", async () => {
    const tmpDir = await makeTempDir();
    const mntDir = path.join(tmpDir, "mnt");
    await fs.mkdir(mntDir, { recursive: true });

    // mntDir contains the actual files
    const sharedActualPath = path.join(mntDir, "SHARED.md");
    const nestedCommonPath = path.join(mntDir, "COMMON.md");
    await fs.writeFile(sharedActualPath, "@COMMON.md", "utf-8");
    await fs.writeFile(nestedCommonPath, "common content", "utf-8");

    const openclawDir = path.join(tmpDir, ".openclaw");
    await fs.mkdir(openclawDir, { recursive: true });

    // openclawDir has a symlink to SHARED.md
    const sharedLinkPath = path.join(openclawDir, "SHARED.md");
    try {
      await fs.symlink(sharedActualPath, sharedLinkPath);
    } catch {
      // Skip if symlinks not supported (e.g. Windows without dev mode)
      return;
    }

    const filePath = path.join(openclawDir, "FILE.md");
    await fs.writeFile(filePath, "@SHARED.md", "utf-8");

    const result = await resolveImports("@SHARED.md", filePath);
    // Should canonicalize resolving COMMON.md relative to mntDir, not openclawDir
    expect(result).toBe("common content");
  });

  it("allows imports if they fall within any of the provided boundaryDirs", async () => {
    const tmpDir = await makeTempDir();
    const openclawDir = path.join(tmpDir, ".openclaw");
    const mntWorkspaceDir = path.join(tmpDir, "mnt", "workspace");
    await fs.mkdir(openclawDir, { recursive: true });
    await fs.mkdir(mntWorkspaceDir, { recursive: true });

    // Workspace is a symlink: .openclaw/workspace -> mnt/workspace
    const workspaceLink = path.join(openclawDir, "workspace");
    try {
      await fs.symlink(mntWorkspaceDir, workspaceLink);
    } catch {
      return;
    }

    // A file outside both boundaries
    const secretPath = path.join(tmpDir, "secret.md");
    await fs.writeFile(secretPath, "top secret", "utf-8");

    // A file inside the canonical workspace dir
    const internalPath = path.join(mntWorkspaceDir, "INTERNAL.md");
    await fs.writeFile(internalPath, "internal content", "utf-8");

    // A file inside .openclaw
    const globalPath = path.join(openclawDir, "GLOBAL.md");
    await fs.writeFile(globalPath, "global content", "utf-8");

    const filePath = path.join(workspaceLink, "FILE.md");
    const content = "@INTERNAL.md\n@../GLOBAL.md\n@../../secret.md\n";
    await fs.writeFile(filePath, content, "utf-8");

    const result = await resolveImports(content, filePath, {
      boundaryDirs: [openclawDir, mntWorkspaceDir],
    });

    // INTERNAL.md and GLOBAL.md should resolve. secret.md is rejected (replaced with "").
    expect(result).toBe("internal content\nglobal content\n@../../secret.md\n");
  });
});
