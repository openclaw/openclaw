import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCovenPluginConfig } from "./config.js";

const OLD_COVEN_HOME = process.env.COVEN_HOME;

afterEach(() => {
  if (OLD_COVEN_HOME === undefined) {
    delete process.env.COVEN_HOME;
  } else {
    process.env.COVEN_HOME = OLD_COVEN_HOME;
  }
});

describe("resolveCovenPluginConfig", () => {
  it("expands tilde paths before resolving Coven home and socket path", () => {
    const resolved = resolveCovenPluginConfig({
      rawConfig: {
        covenHome: "~/.coven",
        socketPath: "~/.coven/coven.sock",
      },
      workspaceDir: "/repo",
    });

    expect(resolved.covenHome).toBe(path.join(os.homedir(), ".coven"));
    expect(resolved.socketPath).toBe(path.join(os.homedir(), ".coven", "coven.sock"));
  });

  it("rejects relative Coven paths instead of trusting workspace contents", () => {
    expect(() =>
      resolveCovenPluginConfig({
        rawConfig: {
          covenHome: ".coven",
          socketPath: ".coven/coven.sock",
        },
        workspaceDir: "/repo",
      }),
    ).toThrow(/covenHome must be absolute/);
  });

  it("rejects socket paths outside covenHome", () => {
    expect(() =>
      resolveCovenPluginConfig({
        rawConfig: {
          covenHome: "~/.coven",
          socketPath: "/var/run/docker.sock",
        },
        workspaceDir: "/repo",
      }),
    ).toThrow(/socketPath must stay inside covenHome/);
  });

  it("rejects socket paths that are symlinks", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-config-"));
    const covenHome = path.join(workspaceDir, ".coven");
    await fs.mkdir(covenHome);
    const socketPath = path.join(covenHome, "coven.sock");
    await fs.symlink("/var/run/docker.sock", socketPath);
    try {
      expect(() =>
        resolveCovenPluginConfig({
          rawConfig: {
            covenHome,
            socketPath,
          },
          workspaceDir,
        }),
      ).toThrow(/must not be a symlink/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects covenHome when it is a symlink", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-config-"));
    const realHome = path.join(workspaceDir, "real-coven");
    const symlinkHome = path.join(workspaceDir, "symlink-coven");
    await fs.mkdir(realHome);
    await fs.symlink(realHome, symlinkHome);
    try {
      expect(() =>
        resolveCovenPluginConfig({
          rawConfig: {
            covenHome: symlinkHome,
          },
          workspaceDir,
        }),
      ).toThrow(/covenHome must not be a symlink/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses COVEN_HOME with tilde expansion for the default socket path", () => {
    process.env.COVEN_HOME = "~/.custom-coven";

    const resolved = resolveCovenPluginConfig({
      rawConfig: {},
      workspaceDir: "/repo",
    });

    expect(resolved.covenHome).toBe(path.join(os.homedir(), ".custom-coven"));
    expect(resolved.socketPath).toBe(path.join(os.homedir(), ".custom-coven", "coven.sock"));
    expect(resolved.allowFallback).toBe(false);
  });

  it("only enables fallback when configured explicitly", () => {
    const resolved = resolveCovenPluginConfig({
      rawConfig: { allowFallback: true },
      workspaceDir: "/repo",
    });

    expect(resolved.allowFallback).toBe(true);
  });
});
