import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatExtraPaths, resolveMemoryAgent } from "./cli-runtime-common.js";

describe("formatExtraPaths", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prints evergreen policy with and without a glob pattern", () => {
    // Keep the display root outside the explicitly selected home on every OS.
    vi.stubEnv("OPENCLAW_HOME", path.resolve("openclaw-home-fixture"));
    const workspaceDir = path.resolve("openclaw-format-fixture");
    expect(
      formatExtraPaths(workspaceDir, [
        { path: "reference", evergreen: true },
        { path: "notes", pattern: "runbooks/**/*.md", evergreen: true },
      ]),
    ).toEqual([
      `${path.join(workspaceDir, "reference")} (evergreen)`,
      `${path.join(workspaceDir, "notes")} (pattern: runbooks/**/*.md, evergreen)`,
    ]);
  });
});

describe("resolveMemoryAgent", () => {
  it("resolves the configured systemAgent under explicit ownership when no agent is specified", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { alpha: {}, ops: {} },
      },
    };
    expect(resolveMemoryAgent(config)).toBe("ops");
  });

  it("preserves explicit agent overrides", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { alpha: {}, ops: {} },
      },
    };
    expect(resolveMemoryAgent(config, "alpha")).toBe("alpha");
  });

  it("fails when multiple agents are configured without an explicit owner", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    };
    expect(() => resolveMemoryAgent(config)).toThrow("Multiple agents are configured");
  });
});
