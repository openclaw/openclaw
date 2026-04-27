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

  it("resolves relative Coven paths from the workspace instead of process cwd", () => {
    const resolved = resolveCovenPluginConfig({
      rawConfig: {
        covenHome: ".coven",
        socketPath: ".coven/coven.sock",
      },
      workspaceDir: "/repo",
    });

    expect(resolved.workspaceDir).toBe("/repo");
    expect(resolved.covenHome).toBe("/repo/.coven");
    expect(resolved.socketPath).toBe("/repo/.coven/coven.sock");
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

  it("uses COVEN_HOME with tilde expansion for the default socket path", () => {
    process.env.COVEN_HOME = "~/.custom-coven";

    const resolved = resolveCovenPluginConfig({
      rawConfig: {},
      workspaceDir: "/repo",
    });

    expect(resolved.covenHome).toBe(path.join(os.homedir(), ".custom-coven"));
    expect(resolved.socketPath).toBe(path.join(os.homedir(), ".custom-coven", "coven.sock"));
  });
});
