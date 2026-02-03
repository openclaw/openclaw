import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveAgentThinkingDefault,
  resolveAgentVerboseDefault,
} from "./agent-scope.js";

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: OpenClawConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/openclaw",
            agentDir: "~/.openclaw/agents/main",
            model: "anthropic/claude-opus-4",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/openclaw",
      agentDir: "~/.openclaw/agents/main",
      model: "anthropic/claude-opus-4",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4",
            fallbacks: ["openai/gpt-4.1"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
              fallbacks: ["openai/gpt-5.2"],
            },
          },
        ],
      },
    };

    expect(resolveAgentModelPrimary(cfg, "linus")).toBe("anthropic/claude-opus-4");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.2"]);

    // If fallbacks isn't present, we don't override the global fallbacks.
    const cfgNoOverride: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toBe(undefined);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
              fallbacks: [],
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toEqual([]);
  });

  it("should return agent-specific sandbox config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              perSession: false,
              workspaceAccess: "ro",
              workspaceRoot: "~/sandboxes",
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      scope: "agent",
      perSession: false,
      workspaceAccess: "ro",
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/openclaw-restricted",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit"],
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit"],
      elevated: {
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      },
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "family",
            workspace: "~/openclaw-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["exec"],
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/openclaw");
  });
});

describe("resolveAgentThinkingDefault", () => {
  it("should return per-agent thinking default when set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "high",
        },
        list: [
          {
            id: "codex-worker",
            model: "openai-codex/gpt-5.2",
            thinkingDefault: "medium",
          },
        ],
      },
    };
    expect(resolveAgentThinkingDefault(cfg, "codex-worker")).toBe("medium");
  });

  it("should fall back to global default when per-agent not set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "high",
        },
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-5",
          },
        ],
      },
    };
    expect(resolveAgentThinkingDefault(cfg, "main")).toBe("high");
  });

  it("should return undefined when neither per-agent nor global default is set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-5",
          },
        ],
      },
    };
    expect(resolveAgentThinkingDefault(cfg, "main")).toBeUndefined();
  });

  it("should prioritize per-agent over global default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "high",
        },
        list: [
          {
            id: "codex-worker-1",
            model: "openai-codex/gpt-5.2",
            thinkingDefault: "medium",
          },
          {
            id: "codex-worker-smart",
            model: "openai-codex/gpt-5.2",
            thinkingDefault: "high",
          },
          {
            id: "main",
            model: "anthropic/claude-opus-4-5",
            // No override - should use global "high"
          },
        ],
      },
    };
    expect(resolveAgentThinkingDefault(cfg, "codex-worker-1")).toBe("medium");
    expect(resolveAgentThinkingDefault(cfg, "codex-worker-smart")).toBe("high");
    expect(resolveAgentThinkingDefault(cfg, "main")).toBe("high");
  });

  it("should support all thinking levels", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "off-agent", thinkingDefault: "off" },
          { id: "minimal-agent", thinkingDefault: "minimal" },
          { id: "low-agent", thinkingDefault: "low" },
          { id: "medium-agent", thinkingDefault: "medium" },
          { id: "high-agent", thinkingDefault: "high" },
          { id: "xhigh-agent", thinkingDefault: "xhigh" },
        ],
      },
    };
    expect(resolveAgentThinkingDefault(cfg, "off-agent")).toBe("off");
    expect(resolveAgentThinkingDefault(cfg, "minimal-agent")).toBe("minimal");
    expect(resolveAgentThinkingDefault(cfg, "low-agent")).toBe("low");
    expect(resolveAgentThinkingDefault(cfg, "medium-agent")).toBe("medium");
    expect(resolveAgentThinkingDefault(cfg, "high-agent")).toBe("high");
    expect(resolveAgentThinkingDefault(cfg, "xhigh-agent")).toBe("xhigh");
  });
});

describe("resolveAgentVerboseDefault", () => {
  it("should return per-agent verbose default when set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "off",
        },
        list: [
          {
            id: "debug-agent",
            model: "openai-codex/gpt-5.2",
            verboseDefault: "full",
          },
        ],
      },
    };
    expect(resolveAgentVerboseDefault(cfg, "debug-agent")).toBe("full");
  });

  it("should fall back to global default when per-agent not set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "on",
        },
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-5",
          },
        ],
      },
    };
    expect(resolveAgentVerboseDefault(cfg, "main")).toBe("on");
  });

  it("should return undefined when neither per-agent nor global default is set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-5",
          },
        ],
      },
    };
    expect(resolveAgentVerboseDefault(cfg, "main")).toBeUndefined();
  });

  it("should prioritize per-agent over global default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "off",
        },
        list: [
          {
            id: "quiet-agent",
            verboseDefault: "off",
          },
          {
            id: "normal-agent",
            verboseDefault: "on",
          },
          {
            id: "debug-agent",
            verboseDefault: "full",
          },
          {
            id: "default-agent",
            // No override - should use global "off"
          },
        ],
      },
    };
    expect(resolveAgentVerboseDefault(cfg, "quiet-agent")).toBe("off");
    expect(resolveAgentVerboseDefault(cfg, "normal-agent")).toBe("on");
    expect(resolveAgentVerboseDefault(cfg, "debug-agent")).toBe("full");
    expect(resolveAgentVerboseDefault(cfg, "default-agent")).toBe("off");
  });

  it("should support all verbose levels", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "off-agent", verboseDefault: "off" },
          { id: "on-agent", verboseDefault: "on" },
          { id: "full-agent", verboseDefault: "full" },
        ],
      },
    };
    expect(resolveAgentVerboseDefault(cfg, "off-agent")).toBe("off");
    expect(resolveAgentVerboseDefault(cfg, "on-agent")).toBe("on");
    expect(resolveAgentVerboseDefault(cfg, "full-agent")).toBe("full");
  });
});
