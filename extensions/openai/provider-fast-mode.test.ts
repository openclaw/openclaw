import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { resolveFastModeSupport } from "./provider-policy-api.js";

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
    { change: { baseUrl: "https://proxy.example/v1" }, expected: false },
    { change: { api: "azure-openai-responses" }, expected: false },
    { change: { params: { serviceTier: "flex" } }, expected: false },
    { change: { params: { service_tier: " PRIORITY " } }, expected: false },
    { change: { params: { serviceTier: "default" } }, expected: false },
    { change: { params: { serviceTier: "auto" } }, expected: false },
    { change: { params: { serviceTier: "invalid" } }, expected: true },
    { change: { params: { serviceTier: 1 } }, expected: true },
    { change: { runtimeId: "codex" }, expected: undefined },
    { change: { runtimeId: undefined }, expected: undefined },
    { change: { api: undefined }, expected: undefined },
    { change: { baseUrl: undefined }, expected: undefined },
  ])("resolves the request contract for $change", ({ change, expected }) => {
    expect(resolveFastModeSupport({ ...request, ...change })).toBe(expected);
  });
});
