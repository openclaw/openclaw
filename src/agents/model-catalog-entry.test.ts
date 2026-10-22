import { describe, expect, it } from "vitest";
import { enrichHarnessRows, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

describe("model catalog metadata projection", () => {
  it("retains runtime capabilities without exporting request credentials", () => {
    const capabilities = {
      id: "configured-model",
      name: "Configured model",
      provider: "custom",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 96_000,
      contextTokens: 48_000,
      parameterCount: 4_000_000_000,
      contextWindows: [{ id: "large", label: "Large", contextWindow: 96_000 }],
      contextWindowDefault: "large",
      thinkingLevelMap: { off: null, high: "high" },
      params: { platformOnly: true },
      compat: { supportsTools: false },
    } satisfies ModelCatalogEntry;
    const model = {
      ...capabilities,
      headers: { Authorization: "synthetic-unused" },
      authHeader: true,
      requestTimeoutMs: 12_000,
    };
    const entry = modelCatalogRowToEntry(model);
    expect(entry).toMatchObject(capabilities);
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
    const entries = [
      { ...native, nativeRuntime: undefined, name: "Muse Spark 1.3", contextWindow: 128000 },
    ];
    expect(enrichHarnessRows([native], { entries, routeVariants: [] })).toEqual([
      { ...native, name: "Muse Spark 1.3" },
    ]);
  });
  it("keeps synthetic provenance bound to the context metadata and route that supplied it", () => {
    const identity = { provider: "fixture", id: "m", name: "M" };
    const base = {
      ...identity,
      api: "openai-responses" as const,
      baseUrl: "https://first.example/v1",
      contextWindow: 128_000,
      contextWindowSource: "synthetic" as const,
      parameterCount: 4_000_000_000,
    };
    const overlay = (fields: Partial<ModelCatalogEntry>) =>
      overlayCatalogMetadata(base, { ...identity, ...fields });
    expect(
      overlay({
        ...base,
        contextWindow: 64_000,
        contextWindowSource: undefined,
      }).contextWindowSource,
    ).toBeUndefined();
    const moved = overlay({ baseUrl: "https://second.example/v1" });
    expect(moved.contextWindowSource).toBeUndefined();
    expect(moved.parameterCount).toBeUndefined();
    expect(overlay({ reasoning: true }).contextWindowSource).toBe("synthetic");
  });
});
