import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: ClawdbotConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          main: { workspace: "~/clawd" },
        },
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          main: {
            name: "Main Agent",
            workspace: "~/clawd",
            agentDir: "~/.clawdbot/agents/main",
            model: "anthropic/claude-opus-4",
          },
        },
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/clawd",
      agentDir: "~/.clawdbot/agents/main",
      model: "anthropic/claude-opus-4",
      sandbox: undefined,
      tools: undefined,
    });
  });

  it("should return agent-specific sandbox config", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          work: {
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              perSession: false,
              workspaceRoot: "~/sandboxes",
            },
          },
        },
      },
    };
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      scope: "agent",
      perSession: false,
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          restricted: {
            workspace: "~/clawd-restricted",
            tools: {
              allow: ["read"],
              deny: ["bash", "write", "edit"],
            },
          },
        },
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["bash", "write", "edit"],
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          family: {
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["bash"],
            },
          },
        },
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          main: { workspace: "~/clawd" },
        },
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/clawd");
  });
});
