import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentCompaction,
  resolveAgentConfig,
  resolveAgentContextPruningMode,
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

  it("uses OPENCLAW_HOME for default agent workspace", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);

    const workspace = resolveAgentWorkspaceDir({} as OpenClawConfig, "main");
    expect(workspace).toBe(path.join(path.resolve(home), ".openclaw", "workspace"));
  });

  it("uses OPENCLAW_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    // Clear state dir so it falls back to OPENCLAW_HOME
    vi.stubEnv("OPENCLAW_STATE_DIR", "");

    const agentDir = resolveAgentDir({} as OpenClawConfig, "main");
    expect(agentDir).toBe(path.join(path.resolve(home), ".openclaw", "agents", "main", "agent"));
  });
});

describe("resolveAgentCompaction", () => {
  it("returns undefined when no compaction config exists", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveAgentCompaction(cfg)).toBeUndefined();
    expect(resolveAgentCompaction(cfg, "main")).toBeUndefined();
  });

  it("returns global defaults when agent has no compaction override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 30000,
          },
        },
        list: [{ id: "main" }],
      },
    };
    const result = resolveAgentCompaction(cfg, "main");
    expect(result?.mode).toBe("safeguard");
    expect(result?.reserveTokensFloor).toBe(30000);
  });

  it("returns global defaults when agentId is omitted", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 25000,
          },
        },
      },
    };
    const result = resolveAgentCompaction(cfg);
    expect(result?.mode).toBe("safeguard");
    expect(result?.reserveTokensFloor).toBe(25000);
  });

  it("returns global defaults for unknown agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: { mode: "safeguard" },
        },
        list: [{ id: "main" }],
      },
    };
    const result = resolveAgentCompaction(cfg, "nonexistent");
    expect(result?.mode).toBe("safeguard");
  });

  it("per-agent compaction overrides defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "default",
            reserveTokensFloor: 20000,
            maxHistoryShare: 0.5,
          },
        },
        list: [
          {
            id: "researcher",
            compaction: {
              mode: "safeguard",
              reserveTokensFloor: 40000,
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "researcher");
    expect(result?.mode).toBe("safeguard");
    expect(result?.reserveTokensFloor).toBe(40000);
    // maxHistoryShare inherited from defaults
    expect(result?.maxHistoryShare).toBe(0.5);
  });

  it("partial per-agent override merges with defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 20000,
            maxHistoryShare: 0.5,
          },
        },
        list: [
          {
            id: "chat",
            compaction: {
              maxHistoryShare: 0.3,
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "chat");
    expect(result?.mode).toBe("safeguard"); // inherited
    expect(result?.reserveTokensFloor).toBe(20000); // inherited
    expect(result?.maxHistoryShare).toBe(0.3); // overridden
  });

  it("per-agent compaction without any defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "standalone",
            compaction: {
              mode: "safeguard",
              reserveTokensFloor: 15000,
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "standalone");
    expect(result?.mode).toBe("safeguard");
    expect(result?.reserveTokensFloor).toBe(15000);
  });

  it("memoryFlush partial override preserves default sub-fields", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 5000,
              prompt: "Flush memories now.",
              systemPrompt: "You are flushing memory.",
            },
          },
        },
        list: [
          {
            id: "executor",
            compaction: {
              memoryFlush: {
                enabled: false,
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "executor");
    expect(result?.memoryFlush?.enabled).toBe(false);
    // Sub-fields inherited from defaults despite partial override
    expect(result?.memoryFlush?.softThresholdTokens).toBe(5000);
    expect(result?.memoryFlush?.prompt).toBe("Flush memories now.");
    expect(result?.memoryFlush?.systemPrompt).toBe("You are flushing memory.");
  });

  it("memoryFlush override with custom prompt preserves other defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 4000,
              prompt: "Default prompt.",
              systemPrompt: "Default system prompt.",
            },
          },
        },
        list: [
          {
            id: "companion",
            compaction: {
              memoryFlush: {
                prompt: "Save emotional context and personal stories.",
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "companion");
    expect(result?.memoryFlush?.enabled).toBe(true); // inherited
    expect(result?.memoryFlush?.softThresholdTokens).toBe(4000); // inherited
    expect(result?.memoryFlush?.prompt).toBe("Save emotional context and personal stories."); // overridden
    expect(result?.memoryFlush?.systemPrompt).toBe("Default system prompt."); // inherited
  });

  it("memoryFlush per-agent only (no default memoryFlush)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
        list: [
          {
            id: "custom",
            compaction: {
              memoryFlush: {
                enabled: false,
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "custom");
    expect(result?.mode).toBe("safeguard"); // inherited
    expect(result?.memoryFlush?.enabled).toBe(false);
  });

  it("per-agent memoryFlush with no default memoryFlush does not throw", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            // no memoryFlush at all
          },
        },
        list: [
          {
            id: "agent",
            compaction: {
              memoryFlush: {
                enabled: false,
                softThresholdTokens: 3000,
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "agent");
    expect(result?.mode).toBe("safeguard"); // inherited
    expect(result?.memoryFlush?.enabled).toBe(false);
    expect(result?.memoryFlush?.softThresholdTokens).toBe(3000);
  });

  it("no memoryFlush in either per-agent or defaults returns undefined", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "default",
          },
        },
        list: [
          {
            id: "plain",
            compaction: {
              reserveTokensFloor: 10000,
            },
          },
        ],
      },
    };
    const result = resolveAgentCompaction(cfg, "plain");
    expect(result?.memoryFlush).toBeUndefined();
  });

  it("agent without compaction returns compaction field as undefined in resolveAgentConfig", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "basic", workspace: "~/basic" }],
      },
    };
    const result = resolveAgentConfig(cfg, "basic");
    expect(result?.compaction).toBeUndefined();
  });
});

describe("resolveAgentCompaction — mode: off", () => {
  it("per-agent mode 'off' overrides global safeguard default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: { mode: "safeguard", reserveTokensFloor: 20000 },
        },
        list: [{ id: "steno-managed", compaction: { mode: "off" } }],
      },
    };
    const result = resolveAgentCompaction(cfg, "steno-managed");
    expect(result?.mode).toBe("off");
    // Still inherits other fields from defaults
    expect(result?.reserveTokensFloor).toBe(20000);
  });

  it("other agents keep global default when one agent is 'off'", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: { mode: "safeguard" },
        },
        list: [{ id: "steno-managed", compaction: { mode: "off" } }, { id: "normal-agent" }],
      },
    };
    expect(resolveAgentCompaction(cfg, "steno-managed")?.mode).toBe("off");
    expect(resolveAgentCompaction(cfg, "normal-agent")?.mode).toBe("safeguard");
  });
});

describe("resolveAgentContextPruningMode", () => {
  it("returns undefined when no config exists", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveAgentContextPruningMode(cfg)).toBeUndefined();
    expect(resolveAgentContextPruningMode(cfg, "main")).toBeUndefined();
  });

  it("returns global default when agent has no override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { contextPruning: { mode: "cache-ttl" } },
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentContextPruningMode(cfg, "main")).toBe("cache-ttl");
  });

  it("per-agent mode 'off' overrides global cache-ttl", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { contextPruning: { mode: "cache-ttl" } },
        list: [{ id: "steno-managed", contextPruning: { mode: "off" } }],
      },
    };
    expect(resolveAgentContextPruningMode(cfg, "steno-managed")).toBe("off");
  });

  it("other agents keep global default when one agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { contextPruning: { mode: "cache-ttl" } },
        list: [{ id: "steno-managed", contextPruning: { mode: "off" } }, { id: "normal-agent" }],
      },
    };
    expect(resolveAgentContextPruningMode(cfg, "steno-managed")).toBe("off");
    expect(resolveAgentContextPruningMode(cfg, "normal-agent")).toBe("cache-ttl");
  });
});
