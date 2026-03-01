import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { resolveSandboxWorkdir } from "./bash-tools.shared.js";

describe("resolveSandboxWorkdir", () => {
  let tempRoot = "";
  let sandbox: BashSandboxConfig;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-workdir-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "nested", "dir"), { recursive: true });
    sandbox = {
      containerName: "sandbox-test",
      workspaceDir,
      containerWorkdir: "/workspace",
    };
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("maps container root workdir to host workspace directory", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSandboxWorkdir({
      workdir: "/workspace",
      sandbox,
      warnings,
    });

    expect(resolved.hostWorkdir).toBe(sandbox.workspaceDir);
    expect(resolved.containerWorkdir).toBe("/workspace");
    expect(warnings).toEqual([]);
  });

  it("maps nested container workdir to corresponding host path", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSandboxWorkdir({
      workdir: "/workspace/nested/dir",
      sandbox,
      warnings,
    });

    expect(resolved.hostWorkdir).toBe(path.join(sandbox.workspaceDir, "nested", "dir"));
    expect(resolved.containerWorkdir).toBe("/workspace/nested/dir");
    expect(warnings).toEqual([]);
  });

  it("falls back to workspace root when container path is outside mapped workspace", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSandboxWorkdir({
      workdir: "/workspace-two",
      sandbox,
      warnings,
    });

    expect(resolved.hostWorkdir).toBe(sandbox.workspaceDir);
    expect(resolved.containerWorkdir).toBe(sandbox.containerWorkdir);
    expect(warnings).toEqual([
      'Warning: workdir "/workspace-two" is unavailable; using "' + sandbox.workspaceDir + '".',
    ]);
  });
});
