import { describe, expect, it } from "vitest";
import { buildSandboxCreateArgs } from "./docker.js";
import type { SandboxDockerConfig } from "./types.js";

const defaultDockerCfg: SandboxDockerConfig = {
  image: "openclaw-sandbox:test",
  containerPrefix: "openclaw-sbx-",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp", "/var/tmp", "/run"],
  network: "none",
  capDrop: ["ALL"],
  env: { LANG: "C.UTF-8" },
};

function createDockerConfig(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return { ...defaultDockerCfg, ...overrides };
}

describe("buildSandboxCreateArgs", () => {
  it("includes runtime when configured", () => {
    const cfg = createDockerConfig({ runtime: "nvidia" });
    const args = buildSandboxCreateArgs({
      name: "test-container",
      cfg,
      scopeKey: "test",
    });
    expect(args).toContain("--runtime");
    expect(args).toContain("nvidia");
  });

  it("does not include runtime when not configured", () => {
    const cfg = createDockerConfig({ runtime: undefined });
    const args = buildSandboxCreateArgs({
      name: "test-container",
      cfg,
      scopeKey: "test",
    });
    expect(args).not.toContain("--runtime");
  });

  it("places runtime after other options", () => {
    const cfg = createDockerConfig({ runtime: "kata-runtime" });
    const args = buildSandboxCreateArgs({
      name: "test-container",
      cfg,
      scopeKey: "test",
    });
    const runtimeIndex = args.indexOf("--runtime");
    expect(runtimeIndex).toBeGreaterThan(0);
    expect(args[runtimeIndex + 1]).toBe("kata-runtime");
  });
});
