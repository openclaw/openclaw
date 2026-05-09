import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { QWEN_BASE_URL } from "./api.js";
import qwenPlugin from "./index.js";

async function registerQwenProvider() {
  // The test runtime asserts the plugin registers exactly one provider and returns it.
  return registerSingleProviderPlugin(qwenPlugin);
}

describe("qwen provider plugin", () => {
  it("no longer filters qwen3.6-plus from Coding Plan catalogs", async () => {
    const provider = await registerQwenProvider();

    const normalized = provider.normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: [{ id: "qwen3.5-plus" }, { id: "qwen3.6-plus" }],
      },
    } as never);

    // normalizeConfig no longer filters; returns undefined for unchanged configs
    expect(normalized).toBeUndefined();
  });

  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });
});
