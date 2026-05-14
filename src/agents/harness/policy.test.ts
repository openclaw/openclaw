import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
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

  it("uses agents.list[].agentRuntime before the default agent runtime", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
        list: [{ id: "worker", agentRuntime: { id: "codex" } }],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config,
        agentId: "worker",
      }),
    ).toStrictEqual({ runtime: "codex", runtimeSource: "agent" });
  });

  it("keeps provider runtime policy ahead of whole-agent fallback runtimes", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
        list: [{ id: "worker", agentRuntime: { id: "codex" } }],
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
        agentId: "worker",
      }),
    ).toStrictEqual({ runtime: "pi", runtimeSource: "provider" });
  });

  it("keeps provider model runtime policy ahead of whole-agent fallback runtimes", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
        list: [{ id: "worker", agentRuntime: { id: "codex" } }],
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [
              { id: "claude-sonnet-4-6", agentRuntime: { id: "pi" } } as ModelDefinitionConfig,
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config,
        agentId: "worker",
      }),
    ).toStrictEqual({ runtime: "pi", runtimeSource: "model" });
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
