import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expect, it } from "vitest";
import {
  buildQwenProvider,
  buildQwenTokenPlanProvider,
  QWEN_BASE_URL,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
} from "./api.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

useProviderCatalogMetadata(new URL(".", import.meta.url));

type QwenProvider = ReturnType<typeof buildQwenProvider>;

const getQwenModelIds = (provider: QwenProvider): string[] =>
  provider.models.map((model) => model.id);
const multimodal = { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000 };
const flagship = { ...multimodal, maxTokens: 131_072 };
const getModel = (provider: QwenProvider, id: string) =>
  provider.models.find((model) => model.id === id);

it("only advertises Standard-only Qwen models on Standard endpoints", () => {
  const coding = buildQwenProvider();
  const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });
  expect(coding).toMatchObject({ baseUrl: QWEN_BASE_URL, api: "openai-completions" });
  expect(getQwenModelIds(coding)).toContain("qwen3.5-plus");
  expect(getQwenModelIds(standard)).toContain("qwen3.6-plus");
  for (const provider of [
    coding,
    buildQwenProvider({ baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 " }),
  ]) {
    const ids = getQwenModelIds(provider);
    expect(ids).toEqual(expect.arrayContaining(["qwen3.6-plus", "qwen3.7-plus"]));
    for (const id of ["qwen3.6-flash", "qwen3.7-max", "qwen3.8-max", "qwen3.8-flash"]) {
      expect(ids).not.toContain(id);
    }
  }
  expect(getModel(coding, "qwen3.6-plus")?.reasoning).toBe(true);

  for (const [id, input, maxTokens] of [
    ["qwen3.6-flash", ["text", "image"], 65_536],
    ["qwen3.7-max", ["text"], 65_536],
    ["qwen3.7-plus", ["text", "image"], 65_536],
    ["qwen3.8-max", ["text", "image"], 131_072],
    ["qwen3.8-flash", ["text", "image"], 131_072],
  ] as const) {
    expect(getModel(standard, id)).toMatchObject({ ...multimodal, input, maxTokens });
  }
});
it("provides Token Plan catalog metadata and current model limits", () => {
  const provider = buildQwenTokenPlanProvider();
  expect(provider).toMatchObject({
    baseUrl: QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
    api: "openai-completions",
  });
  expect(provider.models.every((model) => model.reasoning)).toBe(true);
  expect(manifest.modelCatalog.discovery["qwen-token-plan"]).toBe("refreshable");
  expect(getModel(provider, "kimi-k2.5")?.maxTokens).toBe(98_304);
  expect(getModel(provider, "MiniMax-M2.5")).toMatchObject({
    contextWindow: 196_608,
    maxTokens: 32_768,
  });
});

it.each(["qwen", "qwen-token-plan"])(
  "keeps %s flagship metadata while discovering uncurated models",
  async (providerId) => {
    const providerConfig =
      providerId === "qwen"
        ? buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL })
        : buildQwenTokenPlanProvider();
    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId,
      providerConfig,
      apiKey: `discovery-${providerId}`,
      fetchGuard: async ({ url }) => ({
        response: Response.json({
          data: [
            { id: "qwen3.8-max" },
            { id: "qwen3.8-flash" },
            {
              id: "qwen3.8-27b",
              reasoning: true,
              input: ["text", "image"],
              context_window: 1_000_000,
              max_output_tokens: 131_072,
            },
          ],
        }),
        finalUrl: url,
        release: async () => {},
      }),
    });
    expect(getQwenModelIds(provider)).toEqual(["qwen3.8-27b", "qwen3.8-flash", "qwen3.8-max"]);
    for (const model of provider.models) {
      expect(model).toMatchObject(flagship);
    }
    expect(providerConfig.models.some((model) => model.id === "qwen3.8-27b")).toBe(false);
  },
);
