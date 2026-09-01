// Documents provider/model id normalization from built-ins and plugin manifests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as pluginModuleLoader from "../plugins/plugin-module-loader-cache.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeModelRef,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

describe("normalizeStaticProviderModelId", () => {
  it("re-adds the nvidia prefix for bare model ids", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix already prefixed models", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("applies shipped bundled provider model aliases without manifest lookup", () => {
    // Shipped aliases must work before plugin metadata is loaded so catalog and
    // config parsing can normalize common refs during startup.
    expect(normalizeStaticProviderModelId("anthropic", "sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(normalizeStaticProviderModelId("vercel-ai-gateway", "sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(normalizeStaticProviderModelId("huggingface", "huggingface/vendor/model")).toBe(
      "vendor/model",
    );
  });

  it("strips native Anthropic provider prefixes from static catalog ids", () => {
    expect(normalizeStaticProviderModelId("anthropic", "anthropic/claude-haiku-4-5")).toBe(
      "claude-haiku-4-5",
    );
  });

  it("uses supplied manifest normalization policies when provided", () => {
    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: {
            custom: {
              prefixWhenBare: "vendor",
            },
          },
        },
      },
    ];

    expect(normalizeStaticProviderModelId("custom", "model", { manifestPlugins })).toBe(
      "vendor/model",
    );
  });

  it("keeps OpenRouter bare compatibility ids provider-qualified without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("openrouter", "auto", {
        allowManifestNormalization: false,
      }),
    ).toBe("openrouter/auto");
  });

  it("preserves provider-owned XAI beta aliases without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("xai", "grok-4.20-experimental-beta-0304-reasoning", {
        allowManifestNormalization: false,
      }),
    ).toBe("grok-4.20-experimental-beta-0304-reasoning");
  });

  it("normalizes the shipped retired Together default without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("together", "moonshotai/Kimi-K2.5", {
        allowManifestNormalization: false,
      }),
    ).toBe("moonshotai/Kimi-K2.6");
  });

  it("uses current plugin metadata manifest normalization by default", () => {
    // Runtime callers use the current metadata snapshot by default, so plugin
    // normalization policy applies even without an explicit manifest list.
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { aliases: { latest: "custom/modern-model" } },
              },
            },
          },
        ],
      }),
      { config: {} },
    );

    expect(normalizeStaticProviderModelId("custom", "latest")).toBe("custom/modern-model");
  });
});

it("uses retained normalizers without cold discovery and propagates hook and load failures", () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture-owner",
        modelIdNormalization: {
          providers: {
            fixture: {
              aliases: { blank: "manifest-model", "manifest-model": "reapplied-model" },
            },
          },
        },
      },
    ],
  });
  const hookError = new Error("normalizer failed");
  const provider: ProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    aliases: ["fixture-alias"],
    hookAliases: ["fixture-hook"],
    auth: [],
    normalizeModelId: vi.fn(function (this: ProviderPlugin, { modelId }) {
      if (modelId === "throw") {
        throw hookError;
      }
      return modelId === "blank" ? " " : ` ${this.pluginId}/${modelId} `;
    }),
  };
  const retained = createEmptyPluginRegistry();
  retained.providers.push(
    { pluginId: "fixture-owner", provider, source: "test" },
    {
      pluginId: "without-hook",
      provider: { id: "without-hook", label: "Without hook", auth: [] },
      source: "test",
    },
  );
  const ambient = createEmptyPluginRegistry();
  const ambientNormalizer = vi.fn(() => "ambient-model");
  ambient.providers.push({
    pluginId: "ambient-owner",
    provider: { ...provider, normalizeModelId: ambientNormalizer },
    source: "test",
  });
  const normalize = (providerId: string, modelId: string) =>
    normalizeProviderModelIdWithRuntime({
      provider: providerId,
      plugins: metadataSnapshot.plugins,
      context: { provider: providerId, modelId },
    }) ?? modelId;
  const coldError = new Error("cold normalizer load failed");
  const coldLoad = vi
    .spyOn(pluginModuleLoader, "getCachedPluginModuleLoader")
    .mockImplementation(() => {
      throw coldError;
    });
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(ambient);
  try {
    withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: retained }, () => {
      for (const id of ["fixture", "fixture-alias", "fixture-hook"]) {
        expect(normalize(id, "input")).toBe("fixture-owner/input");
      }
      expect(normalize("fixture", "blank")).toBe("manifest-model");
      expect(() => normalize("fixture", "throw")).toThrow(hookError);
      expect(normalize("without-hook", "input")).toBe("input");
      expect(normalize("unowned", "input")).toBe("input");
    });
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      expect(normalize("fixture", "blank")).toBe("manifest-model");
      expect(normalize("fixture", "input")).toBe("input");
      expect(
        normalizeModelRef("fixture", "blank", { manifestPlugins: metadataSnapshot.plugins }).model,
      ).toBe("manifest-model");
    });
    expect(provider.normalizeModelId).toHaveBeenCalledTimes(5);
    expect(provider.pluginId).toBeUndefined();
    expect(ambientNormalizer).not.toHaveBeenCalled();
    expect(coldLoad).not.toHaveBeenCalled();

    expect(() =>
      withPluginRuntimeRegistryScope(retained, () => normalize("fixture", "input")),
    ).toThrow(coldError);
    expect(() => normalize("fixture", "input")).toThrow(coldError);
    expect(coldLoad).toHaveBeenCalledTimes(2);
  } finally {
    coldLoad.mockRestore();
    resetPluginRuntimeStateForTest();
  }
});

describe("normalizeConfiguredProviderCatalogModelId", () => {
  const manifestPlugins = [
    {
      modelIdNormalization: {
        providers: {
          custom: {
            aliases: {
              latest: "modern-model",
            },
            prefixWhenBare: "vendor",
          },
        },
      },
    },
  ];

  it("applies supplied manifest normalization policies to configured catalog ids", () => {
    expect(normalizeConfiguredProviderCatalogModelId("custom", "latest", { manifestPlugins })).toBe(
      "vendor/modern-model",
    );
  });

  it("can skip manifest normalization while retaining built-in normalization", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("custom", "latest", {
        allowManifestNormalization: false,
        manifestPlugins,
      }),
    ).toBe("latest");
  });

  it("normalizes nested retired Google Gemini ids in proxy-prefixed rows", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("kilocode", "kilocode/google/gemini-3-pro-preview"),
    ).toBe("kilocode/google/gemini-3.1-pro-preview");
  });
});
