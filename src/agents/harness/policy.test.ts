import { expect, it } from "vitest";
import { createProviderModelRoutesResolver } from "../../plugins/provider-model-routes.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { modelDefinition } from "../model-auth.fixtures.test-support.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

it("preserves an explicit prepared provider runtime", () => {
  expect(resolveAgentHarnessPolicy({}, { policy: { id: "openclaw" }, source: "provider" })).toEqual(
    { runtime: "openclaw", runtimeSource: "provider" },
  );
});

it.each(["default", "auto"])("treats prepared %s policy as implicit selection", (id) => {
  const prepared = { policy: { id }, source: "provider" as const };
  expect(resolveAgentHarnessPolicy({ provider: "anthropic", env: {} }, prepared)).toEqual({
    runtime: "auto",
    runtimeSource: "implicit",
  });
});

it("keeps prepared request overrides on OpenClaw", () => {
  expect(
    resolveAgentHarnessPolicy({
      provider: "openai",
      modelId: "gpt-5.5",
      env: {},
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present",
    }),
  ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
});

it("applies global request params before a concrete model is selected", () => {
  const config = createCanonicalAgentConfigFixture({
    agents: { defaults: { params: { temperature: 0.2 } } },
  }).config;
  expect(resolveAgentHarnessPolicy({ provider: "openai", config, env: {} })).toEqual({
    runtime: "openclaw",
    runtimeSource: "implicit",
  });
});

it("keeps model and agent request params per selection with shared provider indexes", () => {
  const config = createCanonicalAgentConfigFixture({
    agents: {
      ownership: "explicit",
      defaults: {
        model: "openai/gpt-5.5",
        models: { "openai/gpt-5.4": { params: { store: false } } },
      },
      entries: { main: {}, custom: { params: { temperature: 0.2 } } },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [modelDefinition("gpt-5.4-mini", { params: { store: false } })],
        },
      },
    },
  }).config;
  const resolveOpenAIProviderRoutes = createProviderModelRoutesResolver({
    provider: "openai",
    config,
    env: {},
  });
  for (const [agentId, modelId, runtime] of [
    ["main", "gpt-5.5", "codex"],
    ["main", "gpt-5.4", "openclaw"],
    ["main", "gpt-5.4-mini", "openclaw"],
    ["custom", "gpt-5.5", "openclaw"],
    ["main", "gpt-5.5", "codex"],
  ] as const) {
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        config,
        env: {},
        agentId,
        modelId,
        resolveOpenAIProviderRoutes,
      }),
    ).toEqual({ runtime, runtimeSource: "implicit" });
  }
});
