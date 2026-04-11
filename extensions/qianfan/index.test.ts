import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qianfanPlugin from "./index.js";
import {
  applyQianfanConfig,
  applyQianfanProviderConfig,
  QIANFAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildQianfanProvider, QIANFAN_BASE_URL } from "./provider-catalog.js";

describe("qianfan provider plugin", () => {
  it("registers Qianfan with api-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);

    expect(provider.id).toBe("qianfan");
    expect(provider.label).toBe("Qianfan");
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth![0].id).toBe("api-key");
    expect(provider.auth![0].kind).toBe("api_key");
  });

  it("builds the static Qianfan model catalog", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
  });

  it("marks deepseek-v3.2 as a reasoning model", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    const deepseekModel = catalog.provider.models?.find(
      (model) => model.id === "deepseek-v3.2",
    );
    expect(deepseekModel?.reasoning).toBe(true);
    expect(deepseekModel?.input).toEqual(["text"]);
    expect(deepseekModel?.contextWindow).toBe(98304);
    expect(deepseekModel?.maxTokens).toBe(32768);
  });

  it("marks ernie-5.0-thinking-preview as a multimodal reasoning model", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    const ernieModel = catalog.provider.models?.find(
      (model) => model.id === "ernie-5.0-thinking-preview",
    );
    expect(ernieModel?.reasoning).toBe(true);
    expect(ernieModel?.input).toEqual(["text", "image"]);
    expect(ernieModel?.contextWindow).toBe(119000);
    expect(ernieModel?.maxTokens).toBe(64000);
  });
});

describe("buildQianfanProvider", () => {
  it("returns provider config with correct base URL and API type", () => {
    const provider = buildQianfanProvider();

    expect(provider.baseUrl).toBe(QIANFAN_BASE_URL);
    expect(provider.api).toBe("openai-completions");
  });

  it("includes both bundled models", () => {
    const provider = buildQianfanProvider();

    expect(provider.models).toHaveLength(2);
    expect(provider.models[0].id).toBe("deepseek-v3.2");
    expect(provider.models[1].id).toBe("ernie-5.0-thinking-preview");
  });

  it("sets zero cost for all models", () => {
    const provider = buildQianfanProvider();

    for (const model of provider.models) {
      expect(model.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });
});

describe("applyQianfanConfig", () => {
  it("applies qianfan provider config with default model", () => {
    const cfg = applyQianfanConfig({} as never);

    expect(cfg.models?.providers?.qianfan).toBeDefined();
    expect(
      (cfg.agents?.defaults?.model as { primary?: string })?.primary,
    ).toBe(QIANFAN_DEFAULT_MODEL_REF);
  });

  it("applies qianfan provider config with correct baseUrl and api", () => {
    const cfg = applyQianfanProviderConfig({} as never);
    const qianfanProvider = cfg.models?.providers?.qianfan as Record<
      string,
      unknown
    >;

    expect(qianfanProvider.baseUrl).toBe(QIANFAN_BASE_URL);
    expect(qianfanProvider.api).toBe("openai-completions");
  });

  it("preserves existing provider baseUrl when explicitly configured", () => {
    const customBaseUrl = "https://custom-qianfan.example.com/v2";
    const cfg = applyQianfanConfig({
      models: {
        providers: {
          qianfan: {
            baseUrl: customBaseUrl,
          },
        },
      },
    } as never);

    const qianfanProvider = cfg.models?.providers?.qianfan as Record<
      string,
      unknown
    >;
    expect(qianfanProvider.baseUrl).toBe(customBaseUrl);
  });

  it("registers the QIANFAN alias for the default model", () => {
    const cfg = applyQianfanConfig({} as never);

    const alias =
      cfg.agents?.defaults?.models?.[QIANFAN_DEFAULT_MODEL_REF]?.alias;
    expect(alias).toBe("QIANFAN");
  });
});
