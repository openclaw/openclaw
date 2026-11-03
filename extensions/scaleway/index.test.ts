import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

it("registers Scaleway as an OpenAI-compatible provider", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider).toMatchObject({
    id: "scaleway",
    envVars: ["SCW_SECRET_KEY"],
    auth: [{ id: "api-key", starterModel: "scaleway/glm-5.3" }],
  });

  const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  expect(catalogProvider?.baseUrl).toBe("https://api.scaleway.ai/v1");
  const modelIds = catalogProvider?.models?.map((model) => model.id) ?? [];
  expect(modelIds).toContain("glm-5.3");
  expect(modelIds).toContain("qwen3.5-397b-a17b");
  expect(modelIds).toContain("gpt-oss-120b");
});
