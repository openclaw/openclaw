import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  filterLocalModelLeanTools,
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
  resolveLocalModelLeanProfile,
} from "./local-model-lean.js";

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

describe("local model lean tool filtering", () => {
  it("filters heavyweight tools for one configured agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "gemma",
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "gemma" })).toBe(true);
    expect(resolveLocalModelLeanProfile({ config: cfg, agentId: "gemma" })).toBe("basic");
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "gemma",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("keeps explicitly preserved tools when lean mode is enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        preserveToolNames: ["browser", "cron", "group:messaging"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("adds reply-required message tools to lean preservation", () => {
    expect(
      resolveLocalModelLeanPreserveToolNames({
        forceMessageTool: true,
      }),
    ).toEqual(["message"]);
    expect(
      resolveLocalModelLeanPreserveToolNames({
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).toEqual(["message"]);
    expect(
      resolveLocalModelLeanPreserveToolNames({
        toolNames: ["group:messaging"],
        forceMessageTool: true,
      }),
    ).toEqual(["group:messaging", "message"]);
  });

  it("keeps existing lean behavior when the basic profile is explicit", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
            localModelLeanProfile: "basic",
          },
        },
      },
    };

    expect(resolveLocalModelLeanProfile({ config: cfg })).toBe("basic");
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec", "web_search"]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec", "web_search"]);
  });

  it("does not treat wildcard preservation as disabling lean mode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        preserveToolNames: ["*"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("uses the strict profile only when lean mode is enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
            localModelLeanProfile: "strict",
          },
        },
      },
    };

    expect(resolveLocalModelLeanProfile({ config: cfg })).toBe("strict");
    expect(
      filterLocalModelLeanTools({
        tools: tools([
          "read",
          "write",
          "edit",
          "exec",
          "wait",
          "apply_patch",
          "process",
          "session_status",
          "update_plan",
          "create_goal",
          "get_goal",
          "update_goal",
          "agents_list",
          "browser",
          "canvas",
          "code_execution",
          "cron",
          "gateway",
          "image",
          "image_generate",
          "message",
          "music_generate",
          "nodes",
          "pdf",
          "sessions_history",
          "sessions_list",
          "sessions_send",
          "sessions_spawn",
          "sessions_yield",
          "subagents",
          "tts",
          "video_generate",
          "web_fetch",
          "web_search",
          "x_search",
          "transcripts",
        ]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual([
      "read",
      "write",
      "edit",
      "exec",
      "wait",
      "apply_patch",
      "process",
      "session_status",
      "update_plan",
    ]);
  });

  it("keeps explicitly preserved tools when strict lean mode is enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
            localModelLeanProfile: "strict",
          },
        },
      },
    };

    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "message", "browser", "cron", "exec"]),
        config: cfg,
        preserveToolNames: ["message"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "message", "exec"]);
  });

  it("does not let a strict profile enable lean mode by itself", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLeanProfile: "strict",
          },
        },
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg })).toBe(false);
    expect(resolveLocalModelLeanProfile({ config: cfg })).toBeUndefined();
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec", "web_search"]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec", "web_search"]);
  });

  it("lets agents override an inherited lean profile", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
            localModelLeanProfile: "strict",
          },
        },
        list: [
          {
            id: "main",
            experimental: {
              localModelLeanProfile: "basic",
            },
          },
        ],
      },
    };

    expect(resolveLocalModelLeanProfile({ config: cfg, agentId: "main" })).toBe("basic");
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec", "web_search"]),
        config: cfg,
        agentId: "main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec", "web_search"]);
  });

  it("lets an agent opt out of an inherited global lean setting", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
        list: [
          {
            id: "main",
            experimental: {
              localModelLean: false,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "main" })).toBe(false);
    expect(resolveLocalModelLeanProfile({ config: cfg, agentId: "main" })).toBeUndefined();
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("inherits global lean mode when an agent experimental block omits the flag", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
        list: [
          {
            id: "main",
            experimental: {},
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "main" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("keeps global lean mode for an agent id without an agent entry", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "ad-hoc" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "ad-hoc",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("uses the configured default agent when no agent id is explicit", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "gemma",
            default: true,
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("uses the agent from an agent session key", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            experimental: {
              localModelLean: false,
            },
          },
          {
            id: "gemma",
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, sessionKey: "agent:gemma:main" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        sessionKey: "agent:gemma:main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });
});
