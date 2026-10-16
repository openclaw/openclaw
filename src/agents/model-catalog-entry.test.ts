import { describe, expect, it } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { enrichHarnessRows, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";

describe("model catalog metadata projection", () => {
  it("retains runtime capabilities without exporting request credentials", () => {
    const model: ProviderRuntimeModel = {
      id: "configured-model",
      name: "Configured model",
      provider: "custom",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 4096,
      contextWindow: 96_000,
      contextTokens: 48_000,
      parameterCount: 4_000_000_000,
      contextWindows: [{ id: "large", label: "Large", contextWindow: 96_000 }],
      contextWindowDefault: "large",
      thinkingLevelMap: { off: null, high: "high" },
      params: { platformOnly: true },
      compat: { supportsTools: false },
      headers: { Authorization: "synthetic-unused" },
      authHeader: true,
      requestTimeoutMs: 12_000,
    };

    const entry = modelCatalogRowToEntry(model);

    expect(entry).toMatchObject({
      id: "configured-model",
      name: "Configured model",
      provider: "custom",
      api: "openai-responses",
      contextWindow: 96_000,
      contextTokens: 48_000,
      parameterCount: 4_000_000_000,
      contextWindows: [{ id: "large", label: "Large", contextWindow: 96_000 }],
      contextWindowDefault: "large",
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, high: "high" },
      params: { platformOnly: true },
      compat: { supportsTools: false },
    });
    expect(entry).not.toHaveProperty("headers");
    expect(entry).not.toHaveProperty("authHeader");
    expect(entry).not.toHaveProperty("requestTimeoutMs");
  });
  it("uses the provider label for an unnamed native model without borrowing capabilities", () => {
    const native = {
      provider: "meta",
      id: "muse-spark-1.3",
      name: "muse-spark-1.3",
      nativeRuntime: "muse",
    };
    const provider = {
      ...native,
      nativeRuntime: undefined,
      name: "Muse Spark 1.3",
      contextWindow: 128000,
    };
    expect(enrichHarnessRows([native], { entries: [provider], routeVariants: [] })).toEqual([
      { ...native, name: "Muse Spark 1.3" },
    ]);
  });
  it("keeps synthetic provenance bound to the context metadata and route that supplied it", () => {
    const base = {
      provider: "fixture",
      id: "m",
      name: "M",
      api: "openai-responses" as const,
      baseUrl: "https://first.example/v1",
      contextWindow: 128_000,
      contextWindowSource: "synthetic" as const,
      parameterCount: 4_000_000_000,
    };
    expect(
      overlayCatalogMetadata(base, {
        ...base,
        contextWindow: 64_000,
        contextWindowSource: undefined,
      }).contextWindowSource,
    ).toBeUndefined();
    const moved = overlayCatalogMetadata(base, {
      provider: "fixture",
      id: "m",
      name: "M",
      baseUrl: "https://second.example/v1",
    });
    expect(moved.contextWindowSource).toBeUndefined();
    expect(moved.parameterCount).toBeUndefined();
    expect(
      overlayCatalogMetadata(base, { provider: "fixture", id: "m", name: "M", reasoning: true })
        .contextWindowSource,
    ).toBe("synthetic");
  });
});
