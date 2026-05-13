import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

describe("resolveAgentHarnessPolicy", () => {
  it("falls back to agents.defaults.agentRuntime for spawned subagents", () => {
    const config = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          agentRuntime: { id: "claude-cli" },
          subagents: { allowAgents: ["worker"] },
        },
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config,
        agentId: "worker",
        sessionKey: "agent:main:worker",
      }),
    ).toStrictEqual({ runtime: "claude-cli", runtimeSource: "defaults" });
  });

  it("keeps provider runtime policy ahead of the default agent runtime", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [],
            agentRuntime: { id: "pi" },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config,
      }),
    ).toStrictEqual({ runtime: "pi", runtimeSource: "provider" });
  });

  it("keeps model runtime policy ahead of the default agent runtime", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "pi" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config,
      }),
    ).toStrictEqual({ runtime: "pi", runtimeSource: "model" });
  });
});
