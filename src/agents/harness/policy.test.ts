import { expect, it } from "vitest";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
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
