import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

describe("openclaw-tools: subagents model + agentId", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  /**
   * Regression test for issue #6817:
   * sessions_spawn ignores model parameter when agentId or other extra parameters are passed.
   *
   * When passing both an explicit model AND an agentId, the explicit model should take
   * precedence over any per-agent subagents.model config.
   */
  it("sessions_spawn uses explicit model even when agentId is also provided", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    // Configure an agent with its own subagent model default
    // The "main" agent needs subagents.allowAgents to allow targeting "research"
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { model: "anthropic/claude-sonnet-4" } },
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["research"] }, // Allow main to spawn to research
          },
          {
            id: "research",
            subagents: { model: "opencode/claude" }, // Agent's default subagent model
          },
        ],
      },
    };

    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-explicit-model", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_spawn");

    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    // Pass BOTH explicit model AND agentId - the explicit model should win
    const result = await tool.execute("call-explicit-model-with-agentid", {
      task: "Research this topic",
      model: "openrouter/deepseek/deepseek-chat", // Explicit model
      agentId: "research", // Target agent (has its own subagents.model)
      label: "Research-Task",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    // Verify that sessions.patch was called with the EXPLICIT model,
    // not the agent's subagents.model default
    const patchCall = calls.find((call) => call.method === "sessions.patch");
    expect(patchCall).toBeDefined();
    expect(patchCall?.params).toMatchObject({
      model: "openrouter/deepseek/deepseek-chat", // Should be explicit model, NOT "opencode/claude"
    });
  });

  /**
   * Additional test: verify explicit model takes precedence over global subagents.model
   */
  it("sessions_spawn explicit model overrides global subagents.model default", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          subagents: { model: "anthropic/claude-sonnet-4" }, // Global default
        },
      },
    };

    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-override-global", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");

    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-override-global", {
      task: "Do something",
      model: "google/gemini-2.5-flash", // Explicit model should override global default
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find((call) => call.method === "sessions.patch");
    expect(patchCall?.params).toMatchObject({
      model: "google/gemini-2.5-flash",
    });
  });

  /**
   * Test that model is applied when only model + task + label are provided (the "working" case)
   */
  it("sessions_spawn applies model when only task, model, and label are provided", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
    };

    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-basic", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");

    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    // This is the "working" case per issue #6817
    const result = await tool.execute("call-basic", {
      task: "Do something",
      model: "openrouter/deepseek/deepseek-chat",
      label: "Test-Agent",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find((call) => call.method === "sessions.patch");
    expect(patchCall?.params).toMatchObject({
      model: "openrouter/deepseek/deepseek-chat",
    });
  });
});
