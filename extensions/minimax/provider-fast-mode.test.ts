import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { resolveFastModeSupport } from "./provider-policy-api.js";

const request: ProviderFastModePolicyContext = {
  provider: "minimax",
  modelId: "MiniMax-M2.7",
  api: "anthropic-messages",
  runtimeId: "openclaw",
  requestCapabilities: { endpointClass: "custom", allowsAnthropicServiceTier: false },
};

describe("MiniMax selected Fast capability", () => {
  it.each([
    { change: {}, expected: true },
    { change: { provider: "minimax-portal" }, expected: true },
    { change: { modelId: "MiniMax-M2.5" }, expected: false },
    { change: { modelId: "MiniMax-M2.7-highspeed" }, expected: false },
    { change: { api: "openai-completions" }, expected: false },
    { change: { provider: "anthropic" }, expected: false },
    { change: { runtimeId: "codex" }, expected: undefined },
    { change: { runtimeId: undefined }, expected: undefined },
    { change: { api: undefined }, expected: undefined },
  ])("resolves the request contract for $change", ({ change, expected }) => {
    expect(resolveFastModeSupport({ ...request, ...change })).toBe(expected);
  });
});
