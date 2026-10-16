import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { resolveOpenAIModelRoutes } from "../openai-model-routes.js";
import { resolveAgentHarnessPolicy as resolveAgentHarnessPolicyBase } from "./policy.js";

function resolveAgentHarnessPolicy(
  params: Parameters<typeof resolveAgentHarnessPolicyBase>[0],
): ReturnType<typeof resolveAgentHarnessPolicyBase> {
  return resolveAgentHarnessPolicyBase({
    provider: "openai",
    modelId: "gpt-5.5",
    env: {},
    ...params,
    config: createCanonicalAgentConfigFixture(params.config).config,
  });
}

function openAIProviderConfig(overrides: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [],
          ...overrides,
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveAgentHarnessPolicy", () => {
  it.each<[string, Record<string, unknown>, string, string?]>([
    ["official Responses route", {}, "codex"],
    ["HTTP official Responses route", { baseUrl: "http://api.openai.com/v1" }, "openclaw"],
    [
      "HTTP official ChatGPT route",
      {
        api: "openai-chatgpt-responses",
        baseUrl: "http://chatgpt.com/backend-api/codex",
      },
      "openclaw",
    ],
    ["custom endpoint", { baseUrl: "https://relay.example.test/v1" }, "openclaw"],
    ["authored Completions route", { api: "openai-completions" }, "openclaw"],
    [
      "explicit API runtime on Completions",
      {
        api: "openai-completions",
        agentRuntime: { id: "openclaw" },
      },
      "openclaw",
      "provider",
    ],
    ["request override", { headers: { "x-route": "custom" } }, "openclaw"],
  ])("uses the provider-owned runtime for %s", (_name, overrides, runtime, runtimeSource) => {
    expect(resolveAgentHarnessPolicy({ config: openAIProviderConfig(overrides) })).toEqual({
      runtime,
      runtimeSource: runtimeSource ?? "implicit",
    });
  });

  it.each(["default", "auto"] as const)(
    "treats configured %s runtime policy as implicit route selection",
    (runtime) => {
      expect(
        resolveAgentHarnessPolicy({
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          config: {
            models: {
              providers: {
                anthropic: {
                  api: "anthropic-messages",
                  baseUrl: "https://api.anthropic.com",
                  agentRuntime: { id: runtime },
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({ runtime: "auto", runtimeSource: "implicit" });
      expect(
        resolveAgentHarnessPolicy({
          config: openAIProviderConfig({ agentRuntime: { id: runtime } }),
        }),
      ).toEqual({ runtime: "codex", runtimeSource: "implicit" });
      const customConfig = openAIProviderConfig({
        baseUrl: "https://relay.example.test/v1",
      });
      customConfig.agents = {
        defaults: {
          models: { "openai/gpt-5.5": { agentRuntime: { id: runtime } } },
        },
      };
      expect(
        resolveAgentHarnessPolicy({
          config: customConfig,
        }),
      ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
    },
  );

  it.each([
    {
      name: "global params",
      agents: { defaults: { params: { temperature: 0.2 } } },
      agentId: undefined,
      sessionKey: undefined,
    },
    {
      name: "model params",
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { params: { text_verbosity: "low" } } },
        },
      },
      agentId: undefined,
      sessionKey: undefined,
    },
    {
      name: "agent params",
      agents: { entries: { writer: { params: { temperature: 0.2 } } } },
      agentId: "writer",
      sessionKey: undefined,
    },
    {
      name: "session agent params",
      agents: { entries: { writer: { params: { temperature: 0.2 } } } },
      agentId: undefined,
      sessionKey: "agent:writer:main",
    },
  ])("keeps $name on OpenClaw", ({ agents, agentId, sessionKey }) => {
    const config = openAIProviderConfig({});
    config.agents = agents;
    expect(
      resolveAgentHarnessPolicy({
        config,
        agentId,
        sessionKey,
      }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
  });

  it("keeps prepared request overrides on OpenClaw", () => {
    expect(
      resolveAgentHarnessPolicy({
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "present",
      }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
  });

  it("applies global request params before a concrete model is selected", () => {
    const config = openAIProviderConfig({});
    config.agents = { defaults: { params: { temperature: 0.2 } } };
    expect(resolveAgentHarnessPolicy({ modelId: undefined, config })).toEqual({
      runtime: "openclaw",
      runtimeSource: "implicit",
    });
  });

  it.each([
    {
      name: "later route facts fill an omitted adapter",
      models: [{ id: "gpt-5.5" }, { id: "gpt-5.5", api: "openai-completions" }],
      runtime: "openclaw",
      api: "openai-completions",
    },
    {
      name: "a provider-looking native id stays distinct",
      models: [
        { id: "openai/gpt-5.5", api: "openai-responses" },
        { id: "gpt-5.5", api: "openai-completions" },
      ],
      runtime: "openclaw",
      api: "openai-completions",
    },
    {
      name: "an authored empty header map stays authoritative",
      models: [
        { id: "gpt-5.5", headers: {} },
        { id: "gpt-5.5", headers: { "x-route": "custom" } },
      ],
      runtime: "codex",
      api: "openai-responses",
    },
    {
      name: "later headers fill an omitted header map",
      models: [{ id: "gpt-5.5" }, { id: "gpt-5.5", headers: { "x-route": "custom" } }],
      runtime: "openclaw",
      api: "openai-responses",
    },
  ])("keeps duplicate model config aligned: $name", ({ models, runtime, api }) => {
    const config = openAIProviderConfig({ models });
    expect(
      resolveAgentHarnessPolicy({
        config,
      }),
    ).toEqual({ runtime, runtimeSource: "implicit" });
    const resolution = resolveOpenAIModelRoutes({ provider: "openai", modelId: "gpt-5.5", config });
    expect(
      resolution?.kind === "routes"
        ? resolution.routes.find((route) => route.authRequirement === "api-key")?.api
        : undefined,
    ).toBe(api);
  });
});
