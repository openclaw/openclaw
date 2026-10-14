import { describe, expect, it, vi } from "vitest";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { overlayConfiguredModelCatalog } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: vi.fn(),
}));

describe("configured catalog overlay", () => {
  it("clears captured capabilities when applying a previously missing base URL", () => {
    const route = {
      api: "openai-responses",
      baseUrl: "https://configured.example.test/v1",
    } as const;
    const source = validateConfigObjectRaw({
      plugins: { enabled: false },
      models: {
        providers: {
          custom: {
            ...route,
            models: [{ id: "plain", name: "Configured model", ...route }],
          },
        },
      },
    });
    if (!source.ok) {
      throw new Error(JSON.stringify(source.issues));
    }
    const captured: ModelCatalogEntry & ThinkingCatalogPolicyCarrier = {
      provider: "custom",
      id: "plain",
      name: "Captured model",
      ...route,
      reasoning: true,
      thinkingLevelMap: { high: "high" },
      thinkingPolicyProvider: "captured-policy",
      [PREPARED_THINKING_POLICY]: {
        resolve: () => ({ levels: [{ id: "high" }], defaultLevel: "high" }),
      },
      contextWindow: 32_000,
      contextWindows: [{ id: "large", label: "Large", contextWindow: 32_000 }],
      contextWindowDefault: "large",
      contextTokens: 16_000,
      input: ["text", "image"],
      params: { captured: true },
      compat: { supportsTools: false },
      mediaInput: { image: { maxBytes: 4_096 } },
    };
    delete captured.baseUrl;
    Object.freeze(captured);
    const catalog = Object.freeze([captured]);
    const [entry] = overlayConfiguredModelCatalog({ catalog, config: source.config });
    expect(entry).toEqual({
      provider: "custom",
      id: "plain",
      name: "Captured model",
      ...route,
      compat: undefined,
    });
    expect(catalog).toEqual([captured]);
    expect(captured.thinkingLevelMap).toEqual({ high: "high" });
  });

  it("keeps capabilities with their captured route when provider defaults differ", () => {
    const captured: ModelCatalogEntry = Object.freeze({
      provider: "custom",
      id: "plain",
      name: "Captured model",
      api: "openai-responses",
      baseUrl: "https://captured.example.test/v1",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
      contextWindows: [{ id: "large", label: "Large", contextWindow: 32_000 }],
      contextWindowDefault: "large",
      params: { captured: true },
      compat: { supportsTools: false },
    });
    const catalog = Object.freeze([captured]);
    const defaults = {
      api: "openai-completions",
      baseUrl: "https://configured.example.test/v1",
    } as const;
    const [entry] = overlayConfiguredModelCatalog({
      catalog,
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            custom: {
              ...defaults,
              models: [
                {
                  id: "plain",
                  name: "Configured model",
                  reasoning: false,
                  thinkingLevelMap: { high: null },
                  contextWindow: 8192,
                  maxTokens: 2048,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  compat: { supportsTools: true },
                },
              ],
            },
          },
        },
      },
    });
    expect(entry).toMatchObject({
      api: captured.api,
      baseUrl: captured.baseUrl,
      reasoning: false,
      configuredReasoning: false,
      thinkingLevelMap: { high: null },
      compat: { supportsTools: false },
    });
    expect(entry?.contextWindows).toEqual(captured.contextWindows);
    expect(entry?.contextWindowDefault).toBe("large");
    expect(entry?.params).toEqual(captured.params);
    expect(catalog).toEqual([captured]);
    expect(captured.reasoning).toBe(true);
    expect(captured.thinkingLevelMap).toEqual({ high: "high" });
  });
});
