import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/home/user/.openclaw"),
}));

vi.mock("../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

describe("resolveOpenClawAgentDir", () => {
  it("uses OPENCLAW_AGENT_DIR when set", () => {
    const env = { OPENCLAW_AGENT_DIR: "/custom/agent" };
    expect(resolveOpenClawAgentDir(env)).toBe("/custom/agent");
  });

  it("uses PI_CODING_AGENT_DIR when set", () => {
    const env = { PI_CODING_AGENT_DIR: "/coding/agent" };
    expect(resolveOpenClawAgentDir(env)).toBe("/coding/agent");
  });

  it("OPENCLAW_AGENT_DIR takes precedence over PI_CODING_AGENT_DIR", () => {
    const env = {
      OPENCLAW_AGENT_DIR: "/openclaw",
      PI_CODING_AGENT_DIR: "/coding",
    };
    expect(resolveOpenClawAgentDir(env)).toBe("/openclaw");
  });

  it("returns default path when no env var set", () => {
    const env = {};
    const result = resolveOpenClawAgentDir(env as any);
    expect(result).toContain("agents");
    expect(result).toContain("main");
    expect(result).toContain("agent");
  });

  it("trims whitespace from env var", () => {
    const env = { OPENCLAW_AGENT_DIR: "  /custom/agent  " };
    expect(resolveOpenClawAgentDir(env)).toBe("/custom/agent");
  });
});
