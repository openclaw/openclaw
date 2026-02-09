import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EasyHubConfig } from "../config/config.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: EasyHubConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: EasyHubConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/EasyHub" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: EasyHubConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/EasyHub",
            agentDir: "~/.easyhub/agents/main",
            model: "anthropic/claude-opus-4",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/EasyHub",
      agentDir: "~/.easyhub/agents/main",
      model: "anthropic/claude-opus-4",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: EasyHubConfig = {
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
    const cfgNoOverride: EasyHubConfig = {
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
    const cfgDisable: EasyHubConfig = {
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
    const cfg: EasyHubConfig = {
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/EasyHub-work",
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
    const cfg: EasyHubConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/EasyHub-restricted",
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
    const cfg: EasyHubConfig = {
      agents: {
        list: [
          {
            id: "family",
            workspace: "~/EasyHub-family",
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
    const cfg: EasyHubConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/EasyHub" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/EasyHub");
  });

  it("uses EASYHUB_HOME for default agent workspace", () => {
    const home = path.join(path.sep, "srv", "EasyHub-home");
    vi.stubEnv("EASYHUB_HOME", home);

    const workspace = resolveAgentWorkspaceDir({} as EasyHubConfig, "main");
    expect(workspace).toBe(path.join(path.resolve(home), ".easyhub", "workspace"));
  });

  it("uses EASYHUB_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "EasyHub-home");
    vi.stubEnv("EASYHUB_HOME", home);
    // Clear state dir so it falls back to EASYHUB_HOME
    vi.stubEnv("EASYHUB_STATE_DIR", "");

    const agentDir = resolveAgentDir({} as EasyHubConfig, "main");
    expect(agentDir).toBe(path.join(path.resolve(home), ".easyhub", "agents", "main", "agent"));
  });
});
