import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRequiredOsHomeDir } from "../infra/home-dir.js";
import { resolveSandboxWorkdir, resolveWorkdir } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bash-workdir-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveWorkdir", () => {
  it("resolves a valid absolute path unchanged", () => {
    const result = resolveWorkdir(os.tmpdir(), []);
    expect(result).toBe(os.tmpdir());
  });

  it("expands ~ to the OS home directory", () => {
    // resolveWorkdir anchors ~ to the OS home (not OPENCLAW_HOME)
    const expected = resolveRequiredOsHomeDir();
    const result = resolveWorkdir("~", []);
    expect(result).toBe(expected);
  });

  it("expands ~/subpath to a path under the OS home directory", async () => {
    const effectiveHome = resolveRequiredOsHomeDir();
    const tempName = `openclaw-test-workdir-${Date.now()}`;
    const fullPath = path.join(effectiveHome, tempName);
    await mkdir(fullPath, { recursive: true });
    try {
      const result = resolveWorkdir(`~/${tempName}`, []);
      expect(result).toBe(fullPath);
    } finally {
      await rm(fullPath, { recursive: true, force: true });
    }
  });

  it("throws when workdir does not exist", () => {
    expect(() => resolveWorkdir("/tmp/openclaw-nonexistent-workdir-test-12345", [])).toThrow(
      /workdir ".*" is unavailable/,
    );
  });

  it("throws when ~ path does not resolve to an existing directory", () => {
    expect(() => resolveWorkdir("~/openclaw-nonexistent-workdir-test-12345", [])).toThrow(
      /workdir ".*" is unavailable/,
    );
  });

  it("throws when workdir exists but is a file, not a directory", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "not-a-dir.txt");
      await writeFile(filePath, "");
      expect(() => resolveWorkdir(filePath, [])).toThrow(/workdir ".*" is not a directory/);
    });
  });
});

describe("resolveSandboxWorkdir", () => {
  it("maps container root workdir to host workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace",
        sandbox: {
          containerName: "sandbox-1",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(workspaceDir);
      expect(resolved.containerWorkdir).toBe("/workspace");
      expect(warnings).toEqual([]);
    });
  });

  it("maps nested container workdir under the container workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "scripts", "runner");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace/scripts/runner",
        sandbox: {
          containerName: "sandbox-2",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/workspace/scripts/runner");
      expect(warnings).toEqual([]);
    });
  });

  it("supports custom container workdir prefixes", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "project");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/sandbox-root/project",
        sandbox: {
          containerName: "sandbox-3",
          workspaceDir,
          containerWorkdir: "/sandbox-root",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/sandbox-root/project");
      expect(warnings).toEqual([]);
    });
  });
});
