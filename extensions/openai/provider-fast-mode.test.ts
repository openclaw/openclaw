import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { resolveFastModeSupport, resolveServiceTiers } from "./provider-policy-api.js";

const request: ProviderFastModePolicyContext = {
  provider: "openai",
  modelId: "speed-fixture",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  runtimeId: "openclaw",
  requestCapabilities: { endpointClass: "openai-public", allowsAnthropicServiceTier: false },
};

describe("OpenAI selected Fast capability", () => {
  it.each([
    { change: {}, expected: true },
    { change: { api: "openai-completions" }, expected: false },
    { change: { baseUrl: "https://proxy.example/v1" }, expected: true },
    { change: { api: "azure-openai-responses" }, expected: false },
    { change: { params: { serviceTier: "flex" } }, expected: false },
    { change: { params: { service_tier: " PRIORITY " } }, expected: false },
    { change: { params: { serviceTier: "default" } }, expected: false },
    { change: { params: { serviceTier: "auto" } }, expected: false },
    { change: { params: { serviceTier: "invalid" } }, expected: true },
    { change: { params: { serviceTier: 1 } }, expected: true },
    { change: { runtimeId: "codex" }, expected: undefined },
    { change: { api: undefined }, expected: undefined },
    { change: { baseUrl: undefined }, expected: undefined },
  ])("resolves the request contract for $change", ({ change, expected }) => {
    expect(resolveFastModeSupport({ ...request, ...change })).toBe(expected);
  });
});

it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
  "publishes verified tier capabilities for %s without constraining other routes",
  (modelId) => {
    const context = { ...request, modelId };
    expect(resolveFastModeSupport(context)).toBe(modelId === "gpt-daybreak-blue-latest");
    expect(resolveServiceTiers(context)).toEqual(
      modelId === "gpt-daybreak-blue-latest" ? ["default", "priority"] : ["default"],
    );
    expect(resolveServiceTiers({ ...context, runtimeId: "codex" })).toBeUndefined();
    expect(
      resolveServiceTiers({ ...context, baseUrl: "https://proxy.example/v1" }),
    ).toBeUndefined();
    expect(resolveServiceTiers({ ...context, modelId: "gpt-5.4" })).toBeUndefined();
  },
);
