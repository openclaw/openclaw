import { describe, expect, it, vi } from "vitest";
import { buildSandboxCreateArgs } from "./docker.js";
import type { SandboxDockerConfig } from "./types.docker.js";

// Baseline docker config with no user set (the problematic default)
function makeDockerCfg(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return {
    image: "openclaw-sandbox:test",
    containerPrefix: "oc-test-",
    workdir: "/workspace",
    readOnlyRoot: true,
    tmpfs: ["/tmp"],
    network: "none",
    capDrop: ["ALL"],
    env: {},
    binds: ["/tmp/workspace:/workspace:rw"],
    ...overrides,
  };
}

describe("buildSandboxCreateArgs - user flag", () => {
  it("passes --user from cfg.user when explicitly configured", () => {
    const args = buildSandboxCreateArgs({
      name: "oc-test-agent",
      cfg: makeDockerCfg({ user: "1003:1003" }),
      scopeKey: "agent:main:session-1",
    });
    const idx = args.indexOf("--user");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("1003:1003");
  });

  it("falls back to gateway process UID:GID when cfg.user is not set (fix for #20979)", () => {
    // Simulate a non-root gateway user (UID 1003)
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1003 as unknown as never);
    const getgidSpy = vi.spyOn(process, "getgid").mockReturnValue(1003 as unknown as never);

    try {
      const args = buildSandboxCreateArgs({
        name: "oc-test-agent",
        cfg: makeDockerCfg(), // no user field
        scopeKey: "agent:main:session-1",
      });
      const idx = args.indexOf("--user");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("1003:1003");
    } finally {
      getuidSpy.mockRestore();
      getgidSpy.mockRestore();
    }
  });

  it("falls back to root UID:GID (0:0) when gateway runs as root and no user is set", () => {
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(0 as unknown as never);
    const getgidSpy = vi.spyOn(process, "getgid").mockReturnValue(0 as unknown as never);

    try {
      const args = buildSandboxCreateArgs({
        name: "oc-test-agent",
        cfg: makeDockerCfg(), // no user field
        scopeKey: "agent:main:session-1",
      });
      const idx = args.indexOf("--user");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("0:0");
    } finally {
      getuidSpy.mockRestore();
      getgidSpy.mockRestore();
    }
  });

  it("does NOT add --user flag on non-POSIX platforms (process.getuid undefined)", () => {
    // Simulate Windows / non-POSIX environment where process.getuid is undefined
    const origGetuid = process.getuid;
    // @ts-expect-error: intentionally setting to undefined to simulate non-POSIX
    process.getuid = undefined;
    try {
      const args = buildSandboxCreateArgs({
        cfg: makeDockerCfg(), // no user field
        scopeKey: "agent:main:session-1",
      });
      expect(args.indexOf("--user")).toBe(-1);
    } finally {
      process.getuid = origGetuid;
    }
  });
});
