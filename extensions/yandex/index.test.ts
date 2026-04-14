import { resolveProviderPluginChoice } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import yandexPlugin from "./index.js";

describe("yandex provider plugin", () => {
  it("registers Yandex with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(yandexPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "yandex-api-key",
    });

    expect(provider.id).toBe("yandex");
    expect(provider.label).toBe("Yandex");
    expect(provider.envVars).toEqual(["YANDEX_API_KEY", "YANDEX_FOLDER_ID"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("yandex");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static Yandex model catalog", async () => {
    const provider = await registerSingleProviderPlugin(yandexPlugin);
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
    expect(catalog.provider.baseUrl).toBe("https://llm.api.cloud.yandex.net/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "aliceai-llm",
      "yandexgpt/latest",
      "yandexgpt/rc",
      "yandexgpt-lite/latest",
    ]);
  });

  it("marks all models as non-reasoning text-only", async () => {
    const provider = await registerSingleProviderPlugin(yandexPlugin);
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

    for (const model of catalog.provider.models ?? []) {
      expect(model.reasoning).toBe(false);
      expect(model.input).toEqual(["text"]);
      expect(model.api).toBe("openai-completions");
    }
  });
});
