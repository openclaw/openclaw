import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qianfanPlugin from "./index.js";

describe("qianfan provider plugin", () => {
  it("registers Qianfan with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);

    expect(provider.id).toBe("qianfan");
    expect(provider.label).toBe("Qianfan");
    expect(provider.auth).toHaveLength(1);
  });

  it("resolves qianfan api-key choice correctly", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "qianfan-api-key",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("qianfan");
    expect(resolved?.method.id).toBe("api-key");
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
    expect(
      catalog.provider.models?.find(
        (model) => model.id === "ernie-5.0-thinking-preview",
      )?.reasoning,
    ).toBe(true);
  });

  it("has correct docs path", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);

    expect(provider.docsPath).toBe("/providers/qianfan");
  });

  it("ernie-5.0-thinking-preview model has correct properties", async () => {
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
    expect(ernieModel).toBeDefined();
    expect(ernieModel?.input).toEqual(["text", "image"]);
    expect(ernieModel?.contextWindow).toBe(119000);
    expect(ernieModel?.maxTokens).toBe(64000);
  });

  it("deepseek-v3.2 model has correct properties", async () => {
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
    expect(deepseekModel).toBeDefined();
    expect(deepseekModel?.input).toEqual(["text"]);
    expect(deepseekModel?.contextWindow).toBe(98304);
    expect(deepseekModel?.maxTokens).toBe(32768);
  });
});