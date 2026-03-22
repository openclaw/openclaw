import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSandboxWorkspace } from "./sandbox/workspace.js";

describe("ensureSandboxWorkspace", () => {
  it("materializes explicit top-level symlinked workspace authorities into the sandbox", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-workspace-"));
    const sourceWorkspace = path.join(tmpRoot, "workspace");
    const sandboxWorkspace = path.join(tmpRoot, "sandbox");
    const authorityRoot = path.join(tmpRoot, "authority");
    const authorityDocs = path.join(authorityRoot, "docs");
    const authorityRepoDocs = path.join(authorityRoot, "voro-docs");

    await fs.mkdir(sourceWorkspace, { recursive: true });
    await fs.mkdir(authorityDocs, { recursive: true });
    await fs.mkdir(authorityRepoDocs, { recursive: true });
    await fs.writeFile(path.join(sourceWorkspace, "AGENTS.md"), "# Agent\n", "utf-8");
    await fs.writeFile(path.join(authorityRoot, "README.md"), "repo readme\n", "utf-8");
    await fs.writeFile(path.join(authorityRoot, "CLAUDE.md"), "repo claude\n", "utf-8");
    await fs.writeFile(path.join(authorityDocs, "CODEBASE_MAP.md"), "map\n", "utf-8");
    await fs.writeFile(path.join(authorityRepoDocs, "PLAN.md"), "plan\n", "utf-8");

    await fs.symlink(path.join(authorityRoot, "README.md"), path.join(sourceWorkspace, "README.md"));
    await fs.symlink(path.join(authorityRoot, "CLAUDE.md"), path.join(sourceWorkspace, "CLAUDE.md"));
    await fs.symlink(authorityDocs, path.join(sourceWorkspace, "docs"));
    await fs.symlink(authorityRepoDocs, path.join(sourceWorkspace, "voro-docs"));

    await ensureSandboxWorkspace(sandboxWorkspace, sourceWorkspace, true);

    await expect(fs.readFile(path.join(sandboxWorkspace, "README.md"), "utf-8")).resolves.toBe(
      "repo readme\n",
    );
    await expect(fs.readFile(path.join(sandboxWorkspace, "CLAUDE.md"), "utf-8")).resolves.toBe(
      "repo claude\n",
    );
    await expect(
      fs.readFile(path.join(sandboxWorkspace, "docs", "CODEBASE_MAP.md"), "utf-8"),
    ).resolves.toBe("map\n");
    await expect(
      fs.readFile(path.join(sandboxWorkspace, "voro-docs", "PLAN.md"), "utf-8"),
    ).resolves.toBe("plan\n");

    await expect(fs.lstat(path.join(sandboxWorkspace, "README.md"))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
    expect((await fs.lstat(path.join(sandboxWorkspace, "README.md"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(sandboxWorkspace, "docs"))).isSymbolicLink()).toBe(false);
  });

  it("does not mirror non-symlink top-level workspace entries", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-workspace-"));
    const sourceWorkspace = path.join(tmpRoot, "workspace");
    const sandboxWorkspace = path.join(tmpRoot, "sandbox");

    await fs.mkdir(sourceWorkspace, { recursive: true });
    await fs.writeFile(path.join(sourceWorkspace, "AGENTS.md"), "# Agent\n", "utf-8");
    await fs.writeFile(path.join(sourceWorkspace, "README.md"), "plain file\n", "utf-8");
    await fs.mkdir(path.join(sourceWorkspace, "docs"), { recursive: true });
    await fs.writeFile(path.join(sourceWorkspace, "docs", "CODEBASE_MAP.md"), "plain dir\n", "utf-8");

    await ensureSandboxWorkspace(sandboxWorkspace, sourceWorkspace, true);

    await expect(fs.stat(path.join(sandboxWorkspace, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sandboxWorkspace, "README.md"))).rejects.toBeTruthy();
    await expect(fs.stat(path.join(sandboxWorkspace, "docs"))).rejects.toBeTruthy();
  });
});
