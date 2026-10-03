/**
 * Exec workdir resolver tests for operator-configured bind mounts.
 * Binds must be selectable as exec workdirs exactly like the file tools accept them.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-exec-workdir-"));
  try {
    await run(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sandboxConfig(workspaceDir: string): BashSandboxConfig {
  return {
    containerName: "sandbox-workdir-bind-test",
    workspaceDir,
    containerWorkdir: "/workspace",
  };
}

describe("resolveExecWorkdir bind mounts", () => {
  it("admits a configured bind target that file tools already serve", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (bindDir) => {
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/data",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              bindMounts: [{ hostPath: bindDir, containerPath: "/data" }],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: bindDir,
          containerCwd: "/data",
          scriptPreflightCwd: bindDir,
        });
      });
    });
  });

  it("admits subdirectories under a configured bind target", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (bindDir) => {
        await mkdir(path.join(bindDir, "reports"), { recursive: true });
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/data/reports",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              bindMounts: [{ hostPath: bindDir, containerPath: "/data" }],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: path.join(bindDir, "reports"),
          containerCwd: "/data/reports",
          scriptPreflightCwd: path.join(bindDir, "reports"),
        });
      });
    });
  });

  it("still rejects bind container paths when no host directory exists", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (bindDir) => {
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/data/missing",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              bindMounts: [{ hostPath: bindDir, containerPath: "/data" }],
            },
          }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/data/missing" });
      });
    });
  });
});
