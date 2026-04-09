import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxWorkdir, resolveWorkdir } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bash-workdir-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

describe("resolveWorkdir", () => {
  it("returns the workdir unchanged when not starting with ~", async () => {
    await withTempDir(async (dir) => {
      const resolved = resolveWorkdir(dir);
      expect(resolved).toBe(dir);
    });
  });

  it("expands ~ to the home directory", async () => {
    const homeDir = os.homedir();
    const resolved = resolveWorkdir("~");
    expect(resolved).toBe(homeDir);
  });

  it("expands ~/subdir to home directory with subdir", async () => {
    const home = os.homedir();
    const resolved = resolveWorkdir("~");
    expect(resolved).toBe(home);
  });

  it("throws error when workdir does not exist", async () => {
    expect(() => resolveWorkdir("/nonexistent/path/to/dir")).toThrow(
      'workdir "/nonexistent/path/to/dir" does not exist',
    );
  });

  it("throws error when workdir is a file, not a directory", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "file.txt");
      await writeFile(filePath, "");
      expect(() => resolveWorkdir(filePath)).toThrow(`workdir "${filePath}" is not a directory`);
    });
  });
});
