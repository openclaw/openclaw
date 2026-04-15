import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qiniuPlugin from "./index.js";

describe("qiniu provider plugin", () => {
  it("registers Qiniu with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(qiniuPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "qiniu-api-key",
    });

    expect(provider.id).toBe("qiniu");
    expect(provider.label).toBe("Qiniu");
    expect(provider.envVars).toEqual(["QINIU_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("qiniu");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the Qiniu model catalog with deepseek-v3 fallback", async () => {
    const provider = await registerSingleProviderPlugin(qiniuPlugin);
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
    expect(catalog.provider.baseUrl).toBe("https://api.qnaigc.com/v1");
    expect(catalog.provider.models?.some((model) => model.id === "deepseek-v3")).toBe(true);
  });
});
