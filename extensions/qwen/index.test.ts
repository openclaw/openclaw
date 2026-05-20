import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import qwenPlugin from "./index.js";

async function registerQwenProvider() {
  // The test runtime asserts the plugin registers exactly one provider and returns it.
  return registerSingleProviderPlugin(qwenPlugin);
}

describe("qwen provider plugin", () => {
  it("does not filter qwen3.6-plus from Coding Plan configs", async () => {
    const provider = await registerQwenProvider();

    // normalizeConfig is no longer defined: qwen3.6-plus is available on all
    // Qwen endpoints including Coding Plan CN (coding.dashscope.aliyuncs.com).
    expect(provider.normalizeConfig).toBeUndefined();
  });

  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });
});