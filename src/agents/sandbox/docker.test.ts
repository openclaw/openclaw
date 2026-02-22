import { describe, expect, it } from "vitest";
import { buildSandboxCreateArgs } from "./docker.js";
import type { SandboxDockerConfig } from "./types.js";

function createMinimalConfig(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return {
    image: "debian:bookworm-slim",
    containerPrefix: "openclaw-sandbox-",
    workdir: "/workspace",
    readOnlyRoot: false,
    tmpfs: [],
    network: "none",
    capDrop: ["ALL"],
    ...overrides,
  };
}

describe("buildSandboxCreateArgs", () => {
  it("includes --user flag when docker.user is set", () => {
    const cfg = createMinimalConfig({ user: "1000:1000" });
    const args = buildSandboxCreateArgs({
      name: "test-sandbox",
      cfg,
      scopeKey: "agent:main",
    });
    const userIndex = args.indexOf("--user");
    expect(userIndex).toBeGreaterThan(0);
    expect(args[userIndex + 1]).toBe("1000:1000");
  });

  it("does not include --user flag when docker.user is undefined", () => {
    const cfg = createMinimalConfig({ user: undefined });
    const args = buildSandboxCreateArgs({
      name: "test-sandbox",
      cfg,
      scopeKey: "agent:main",
    });
    expect(args).not.toContain("--user");
  });

  it("includes --cap-drop and --security-opt flags", () => {
    const cfg = createMinimalConfig({ capDrop: ["ALL"] });
    const args = buildSandboxCreateArgs({
      name: "test-sandbox",
      cfg,
      scopeKey: "agent:main",
    });
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
  });
});
