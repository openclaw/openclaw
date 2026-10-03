// FlexAI tests cover index plugin behavior and live catalog projection.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildFlexAIProvider, FLEXAI_MODEL_DISCOVERY } from "./api.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const seededCatalog = manifest.modelCatalog.providers.flexai;

function projectRows(rows: readonly unknown[], fallback?: ModelProviderConfig) {
  const project = FLEXAI_MODEL_DISCOVERY.projectRows;
  if (!project) {
    throw new Error("expected a FlexAI live catalog projection");
  }
  return project(rows, fallback ?? buildFlexAIProvider());
}

describe("flexai provider plugin", () => {
  it("registers FlexAI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("flexai");
    expect(provider.envVars).toEqual(["FLEXAI_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]?.starterModel).toBe(`flexai/${seededCatalog.defaultModel}`);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = result && "provider" in result ? result.provider : undefined;
    expect(catalogProvider?.baseUrl).toBe(seededCatalog.baseUrl);
    expect(catalogProvider?.models?.map((model) => model.id)).toContain(seededCatalog.defaultModel);
  });
});

describe("flexai live catalog projection", () => {
  it("keeps chat rows and drops the non-text models served on the same endpoint", () => {
    const models = projectRows([
      {
        id: "fixture-chat",
        object: "model",
        name: "Fixture Chat",
        supports: ["chat", "streaming", "tool_use"],
        context_length: 131072,
        max_output_length: 131072,
        input_modalities: ["text"],
        pricing: { prompt: "0.00000003", completion: "0.00000017" },
      },
      {
        id: "fixture-embedding",
        object: "model",
        supports: ["embeddings"],
        context_length: 8192,
        input_modalities: ["text"],
      },
      {
        id: "fixture-transcription",
        object: "model",
        supports: ["audio_transcription"],
        context_length: 8192,
        input_modalities: ["audio"],
      },
      {
        id: "fixture-image-input-only",
        object: "model",
        supports: ["image_input"],
        context_length: 131072,
        input_modalities: ["text", "image"],
      },
    ]);

    expect(models.map((model) => model.id)).toEqual(["fixture-chat"]);
    const [chat] = models;
    expect(chat).toMatchObject({
      name: "Fixture Chat",
      input: ["text"],
      contextWindow: 131072,
      reasoning: false,
    });
    expect(chat?.compat).toMatchObject({ supportsTools: true });
    expect(chat?.cost.input).toBeCloseTo(0.03, 10);
    expect(chat?.cost.output).toBeCloseTo(0.17, 10);
  });

  it("keeps a chat row whose supports array omits streaming", () => {
    // Measured 2026-10-02: MiniMax-M2.7 streams and reports usage in the
    // stream while its `supports` array lists no `streaming` entry, so only
    // `chat` is safe to filter on.
    const models = projectRows([
      {
        id: "fixture-unlisted-streaming",
        object: "model",
        supports: ["chat", "completion", "tool_use"],
        context_length: 204800,
        input_modalities: ["text"],
      },
    ]);

    expect(models.map((model) => model.id)).toEqual(["fixture-unlisted-streaming"]);
  });

  it("publishes the context window as the output ceiling because FlexAI has no separate cap", () => {
    // FlexAI mirrors max_output_length onto context_length, so the reported
    // value is not an independent output budget and must not be published as
    // a tighter ceiling than the API actually imposes.
    const [model] = projectRows([
      {
        id: "fixture-shared-budget",
        object: "model",
        supports: ["chat"],
        context_length: 262144,
        max_output_length: 262144,
        input_modalities: ["text"],
      },
    ]);

    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxTokens).toBe(262144);
  });

  it("marks an image-capable chat row as a vision model", () => {
    const [model] = projectRows([
      {
        id: "fixture-vision",
        object: "model",
        supports: ["chat", "vision", "tool_use"],
        context_length: 262144,
        input_modalities: ["text", "image"],
      },
    ]);

    expect(model?.input).toEqual(["text", "image"]);
  });

  it("limits a discovered reasoning row to the efforts every validating route accepts", () => {
    const [model] = projectRows([
      {
        id: "fixture-reasoner",
        object: "model",
        supports: ["chat", "reasoning_effort"],
        context_length: 131072,
        input_modalities: ["text"],
      },
    ]);

    expect(model?.reasoning).toBe(true);
    expect(model?.compat?.supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("treats the reasoning category as a reasoning row", () => {
    const [model] = projectRows([
      {
        id: "fixture-thinking",
        object: "model",
        supports: ["chat", "tool_use"],
        category: "reasoning",
        context_length: 262144,
        input_modalities: ["text"],
      },
    ]);

    expect(model?.reasoning).toBe(true);
  });

  it("keeps the measured per-model effort list for a seeded row", () => {
    const seeded = seededCatalog.models.find(
      (model) => model.compat?.supportedReasoningEfforts?.length === 3,
    );
    if (!seeded) {
      throw new Error("expected a seeded model with a narrowed reasoning-effort list");
    }
    const [model] = projectRows([
      {
        id: seeded.id,
        object: "model",
        supports: ["chat", "tool_use"],
        context_length: seeded.contextWindow,
        input_modalities: ["text"],
      },
    ]);

    expect(model?.reasoning).toBe(seeded.reasoning);
    expect(model?.compat?.supportedReasoningEfforts).toEqual(
      seeded.compat?.supportedReasoningEfforts,
    );
  });

  it("reports an incomplete price as zero rather than dropping the row", () => {
    // FlexAI always publishes both halves; a partial payload is treated the
    // same way the other OpenAI-compatible catalogs treat it, so the model
    // stays selectable with a zero estimate instead of disappearing.
    const [model] = projectRows([
      {
        id: "fixture-unpriced",
        object: "model",
        supports: ["chat"],
        context_length: 131072,
        input_modalities: ["text"],
        pricing: { prompt: "0.00000003" },
      },
    ]);

    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("reads the cached-prompt rate FlexAI publishes", () => {
    const [model] = projectRows([
      {
        id: "fixture-cached",
        object: "model",
        supports: ["chat"],
        context_length: 131072,
        input_modalities: ["text"],
        pricing: {
          prompt: "0.00000006",
          completion: "0.00000018",
          input_cache_read: "0.000000009",
        },
      },
    ]);

    expect(model?.cost.cacheRead).toBeCloseTo(0.009, 10);
    expect(model?.cost.cacheWrite).toBe(0);
  });
});
