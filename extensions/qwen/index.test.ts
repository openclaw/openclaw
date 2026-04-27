import type { OpenClawConfig } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qwenPlugin from "./index.js";

async function registerQwenProvider() {
  return registerSingleProviderPlugin(qwenPlugin);
}

describe("qwen provider plugin", () => {
  it("does not suppress exact custom modelstudio providers owned by another api", async () => {
    const provider = await registerQwenProvider();
    const config = {
      models: {
        providers: {
          modelstudio: {
            api: "openai-completions",
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            models: [{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      provider.suppressBuiltInModel?.({
        config,
        env: {},
        provider: "modelstudio",
        modelId: "qwen3.6-plus",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      }),
    ).toBeUndefined();
  });

  it("still suppresses legacy modelstudio refs on Qwen Coding Plan endpoints", async () => {
    const provider = await registerQwenProvider();

    expect(
      provider.suppressBuiltInModel?.({
        config: {},
        env: {},
        provider: "modelstudio",
        modelId: "qwen3.6-plus",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      })?.suppress,
    ).toBe(true);
  });
});
