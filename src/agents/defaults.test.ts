import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS, resolveNativeOwnedRuntimeModel } from "./defaults.js";

function resolveMuseModel(entry: { contextWindow?: number; contextWindowSource?: "synthetic" }) {
  const row = {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    provider: "meta",
    nativeRuntime: "muse",
    ...entry,
  };
  return resolveNativeOwnedRuntimeModel({
    catalog: { entries: [row], routeVariants: [] },
    provider: "meta",
    modelId: "muse-spark-1.3",
    runtimeId: "muse",
  });
}

describe("resolveNativeOwnedRuntimeModel", () => {
  it("uses the provider catalog context window for a matching native model", () => {
    expect(resolveMuseModel({ contextWindow: 1_048_576 })?.contextWindow).toBe(1_048_576);
  });

  it("keeps the conservative fallback for missing or synthetic catalog windows", () => {
    expect(resolveMuseModel({})?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(
      resolveMuseModel({ contextWindow: 1_048_576, contextWindowSource: "synthetic" })
        ?.contextWindow,
    ).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});
