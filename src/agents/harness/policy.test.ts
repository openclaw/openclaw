import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { resolveOpenAIModelRoutes } from "../openai-model-routes.js";
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

const agentParams = { entries: { writer: { params: { temperature: 0.2 } } } };
const routeModel = (facts: Record<string, unknown> = {}, id = "gpt-5.5") => ({ id, ...facts });

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
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        agentRuntime,
      },
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

  it.each<[string, OpenClawConfig["agents"], string?, string?]>([
    ["global params", { defaults: { params: { temperature: 0.2 } } }],
    [
      "model params",
      { defaults: { models: { "openai/gpt-5.5": { params: { text_verbosity: "low" } } } } },
    ],
    ["agent params", agentParams, "writer"],
    ["session agent params", agentParams, undefined, "agent:writer:main"],
  ])("keeps %s on OpenClaw", (_name, agents, agentId, sessionKey) => {
    checkPolicy(providerConfig({}, agents), "openclaw", { agentId, sessionKey });
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

  it.each([
    [
      "later adapter",
      [routeModel(), routeModel({ api: "openai-completions" })],
      "openclaw",
      "openai-completions",
    ],
    [
      "provider-looking native id",
      [
        routeModel({ api: "openai-responses" }, "openai/gpt-5.5"),
        routeModel({ api: "openai-completions" }),
      ],
      "openclaw",
      "openai-completions",
    ],
    [
      "authoritative empty headers",
      [routeModel({ headers: {} }), routeModel({ headers: { "x-route": "custom" } })],
      "codex",
      "openai-responses",
    ],
    [
      "later headers",
      [routeModel(), routeModel({ headers: { "x-route": "custom" } })],
      "openclaw",
      "openai-responses",
    ],
  ] as const)("keeps duplicate model config aligned: %s", (_name, models, runtime, api) => {
    const config = providerConfig({ models });
    checkPolicy(config, runtime);
    const resolution = resolveOpenAIModelRoutes({ provider: "openai", modelId: "gpt-5.5", config });
    expect(
      resolution?.kind === "routes"
        ? resolution.routes.find((route) => route.authRequirement === "api-key")?.api
        : undefined,
    ).toBe(api);
  });
});
