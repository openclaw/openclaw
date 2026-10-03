import { describe, expect, it } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";

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
});
