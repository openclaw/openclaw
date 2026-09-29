import { describe, expect, it } from "vitest";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const catalogBase: ModelCatalogEntry = {
  id: "acme/effort-model",
  name: "Effort Model",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { off: null },
  compat: { supportedReasoningEfforts: ["xhigh", "high", "medium", "low"] },
  catalogReasoningEfforts: true,
};

describe("catalog-derived effort provenance overlays", () => {
  it("keeps the marker when the configured overlay declares no effort metadata", () => {
    const entry = overlayCatalogMetadata(catalogBase, {
      id: catalogBase.id,
      name: "Configured name",
      provider: "openrouter",
      reasoning: true,
      compat: { supportsTemperature: false },
    });

    expect(entry.catalogReasoningEfforts).toBe(true);
    expect(entry.compat?.supportedReasoningEfforts).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("clears the marker when the overlay declares reasoning efforts", () => {
    const entry = overlayCatalogMetadata(catalogBase, {
      id: catalogBase.id,
      name: "Configured name",
      provider: "openrouter",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "high"] },
    });

    expect(entry.catalogReasoningEfforts).toBeUndefined();
    expect(entry.compat?.supportedReasoningEfforts).toEqual(["low", "high"]);
  });

  it("clears the marker when the overlay declares a thinking level map", () => {
    const entry = overlayCatalogMetadata(catalogBase, {
      id: catalogBase.id,
      name: "Configured name",
      provider: "openrouter",
      reasoning: true,
      thinkingLevelMap: { off: "none" },
    });

    expect(entry.catalogReasoningEfforts).toBeUndefined();
    expect(entry.thinkingLevelMap).toEqual({ off: "none" });
  });

  it("drops the marker when capabilities cannot cross a route change", () => {
    const entry = overlayCatalogMetadata(catalogBase, {
      id: catalogBase.id,
      name: "Configured name",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://custom.example.invalid/v1",
      reasoning: true,
    });

    expect(entry.catalogReasoningEfforts).toBeUndefined();
    expect(entry.compat).toBeUndefined();
  });

  it("drops the marker when the overlay declares only an effort mapping", () => {
    const entry = overlayCatalogMetadata(catalogBase, {
      id: catalogBase.id,
      name: "Configured name",
      provider: "openrouter",
      reasoning: true,
      compat: { reasoningEffortMap: { high: "medium" } },
    });

    expect(entry.catalogReasoningEfforts).toBeUndefined();
    expect(entry.compat?.reasoningEffortMap).toEqual({ high: "medium" });
  });

  it("carries catalog-derived effort provenance onto projected entries", () => {
    const entry = modelCatalogRowToEntry({
      id: catalogBase.id,
      name: catalogBase.name,
      provider: "openrouter",
      reasoning: true,
      input: ["text"],
      compat: { supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      catalogReasoningEfforts: true,
    });
    expect(entry.catalogReasoningEfforts).toBe(true);

    const declared = modelCatalogRowToEntry({
      id: "acme/declared-model",
      name: "Declared Model",
      provider: "openrouter",
      reasoning: true,
      input: ["text"],
      compat: { supportedReasoningEfforts: ["high", "low"] },
    });
    expect(declared.catalogReasoningEfforts).toBeUndefined();
  });
});
