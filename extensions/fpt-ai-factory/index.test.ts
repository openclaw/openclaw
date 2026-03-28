import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
import fptAiFactoryPlugin from "./index.js";
import { applyFptAiFactoryConfig, FPT_AI_FACTORY_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildFptAiFactoryProvider } from "./provider-catalog.js";

describe("fpt-ai-factory provider plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers FPT AI Factory with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(fptAiFactoryPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "fpt-ai-factory-api-key",
    });

    expect(provider.id).toBe("fpt-ai-factory");
    expect(provider.label).toBe("FPT AI Factory");
    expect(provider.envVars).toEqual(["FPT_AI_FACTORY_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved?.provider.id).toBe("fpt-ai-factory");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds a catalog from discovered chat and vision models only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "Qwen3-32B",
              name: "Qwen3-32B",
              context_length: 128000,
              pricing: { prompt: "0.00000017", completion: "0.00000019" },
              architecture: {
                modality: "text->text",
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              top_provider: { context_length: 128000, max_completion_tokens: 33000 },
            },
            {
              id: "Qwen3-VL-8B-Instruct",
              name: "Qwen3-VL-8B-Instruct",
              context_length: 256000,
              pricing: { prompt: "0.00000020", completion: "0.00000076" },
              architecture: {
                modality: "image+text->text",
                input_modalities: ["image", "text"],
                output_modalities: ["text"],
              },
              top_provider: { context_length: 256000, max_completion_tokens: 32000 },
            },
            {
              id: "Vietnamese_Embedding",
              architecture: {
                modality: "text->text",
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              description: "Embedding model",
            },
            {
              id: "FPT.AI-TTS",
              architecture: {
                modality: "text->text",
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              description: "TTS model",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = registerSingleProviderPlugin(fptAiFactoryPlugin);
    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key", discoveryApiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        discoveryApiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://mkp-api.fptcloud.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    const ids = catalog.provider.models?.map((model) => model.id) ?? [];
    expect(ids).toContain("Qwen3-32B");
    expect(ids).toContain("Qwen3-VL-8B-Instruct");
    expect(ids).not.toContain("Vietnamese_Embedding");
    expect(ids).not.toContain("FPT.AI-TTS");
    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://mkp-api.fptcloud.com/v1");
    expect(catalog.provider.models?.find((model) => model.id === "Qwen3-32B")?.input).toEqual([
      "text",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "Qwen3-VL-8B-Instruct")?.input,
    ).toEqual(["text", "image"]);
    expect(catalog.provider.models?.find((model) => model.id === "Qwen3-32B")?.cost).toEqual({
      input: 0.17,
      output: 0.19,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("keeps fallback reasoning metadata when discovery would downgrade SaoLa models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "SaoLa4-medium",
                name: "SaoLa4-medium",
                context_length: 128000,
                pricing: { prompt: "0.00000017", completion: "0.00000019" },
                architecture: {
                  modality: "text->text",
                  input_modalities: ["text"],
                  output_modalities: ["text"],
                },
                top_provider: { context_length: 128000, max_completion_tokens: 8192 },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const provider = await buildFptAiFactoryProvider("test-key");

    expect(provider.models?.find((model) => model.id === "SaoLa4-medium")?.reasoning).toBe(true);
  });

  it("uses per-million-token fallback pricing when discovery is skipped", async () => {
    const provider = await buildFptAiFactoryProvider();

    expect(provider.models?.find((model) => model.id === "Qwen3-32B")?.cost).toEqual({
      input: 0.17,
      output: 0.19,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("applies provider config and default primary model", () => {
    const next = applyFptAiFactoryConfig({});

    expect(next.agents?.defaults?.model).toEqual({
      primary: FPT_AI_FACTORY_DEFAULT_MODEL_REF,
    });
    expect(next.models?.providers?.["fpt-ai-factory"]?.api).toBe("openai-completions");
    expect(next.models?.providers?.["fpt-ai-factory"]?.baseUrl).toBe(
      "https://mkp-api.fptcloud.com/v1",
    );
    expect(
      next.models?.providers?.["fpt-ai-factory"]?.models?.some((model) => model.id === "Qwen3-32B"),
    ).toBe(true);
    expect(next.agents?.defaults?.models?.[FPT_AI_FACTORY_DEFAULT_MODEL_REF]?.alias).toBe(
      "FPT AI Factory",
    );
  });
});
