import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

function providerConfig(
  overrides: Record<string, unknown> = {},
  agents?: OpenClawConfig["agents"],
  provider = "openai",
): OpenClawConfig {
  return createCanonicalAgentConfigFixture({
    agents,
    models: {
      providers: {
        [provider]: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [],
          ...overrides,
        },
      },
    },
  } as OpenClawConfig).config;
}

function checkPolicy(
  config: OpenClawConfig,
  runtime: string,
  params: Parameters<typeof resolveAgentHarnessPolicy>[0] = {},
  runtimeSource = "implicit",
) {
  expect(
    resolveAgentHarnessPolicy({
      provider: "openai",
      modelId: "gpt-5.5",
      env: {},
      ...params,
      config,
    }),
  ).toEqual({ runtime, runtimeSource });
}

describe("resolveAgentHarnessPolicy", () => {
  it("preserves the source of an explicit provider runtime", () => {
    checkPolicy(
      providerConfig({ api: "openai-completions", agentRuntime: { id: "openclaw" } }),
      "openclaw",
      {},
      "provider",
    );
  });

  it.each(["default", "auto"] as const)("treats %s as implicit route selection", (id) => {
    const agentRuntime = { id };
    const anthropic = providerConfig(
      { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", agentRuntime },
      undefined,
      "anthropic",
    );
    checkPolicy(anthropic, "auto", { provider: "anthropic", modelId: "claude-sonnet-4-6" });
    checkPolicy(providerConfig({ agentRuntime }), "codex");
    checkPolicy(
      providerConfig(
        { baseUrl: "https://relay.example.test/v1" },
        { defaults: { models: { "openai/gpt-5.5": { agentRuntime } } } },
      ),
      "openclaw",
    );
  });

  it("keeps prepared request overrides on OpenClaw", () => {
    checkPolicy(createCanonicalAgentConfigFixture().config, "openclaw", {
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present",
    });
  });

  it("applies global request params before a concrete model is selected", () => {
    checkPolicy(providerConfig({}, { defaults: { params: { temperature: 0.2 } } }), "openclaw", {
      modelId: undefined,
    });
  });
});
