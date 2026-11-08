import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS, resolveNativeOwnedRuntimeModel } from "./defaults.js";

function resolveNativeModel(entry: { contextWindow?: number; contextWindowSource?: "synthetic" }) {
  const row = {
    id: "provider-large-model",
    name: "Provider Large Model",
    provider: "example-provider",
    nativeRuntime: "example-runtime",
    ...entry,
  };
  return resolveNativeOwnedRuntimeModel({
    catalog: { entries: [row], routeVariants: [] },
    provider: "example-provider",
    modelId: "provider-large-model",
    runtimeId: "example-runtime",
  });
}

describe("resolveNativeOwnedRuntimeModel", () => {
  it("uses a provider-reported window for the matching native model", () => {
    expect(resolveNativeModel({ contextWindow: 1_048_576 })?.contextWindow).toBe(1_048_576);
  });

  it("keeps the conservative fallback for missing or synthetic catalog windows", () => {
    expect(resolveNativeModel({})?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(
      resolveNativeModel({ contextWindow: 1_048_576, contextWindowSource: "synthetic" })
        ?.contextWindow,
    ).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});
