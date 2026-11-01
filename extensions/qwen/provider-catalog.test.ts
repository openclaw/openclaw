import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expect, it } from "vitest";
import {
  buildQwenProvider,
  buildQwenTokenPlanProvider,
  QWEN_BASE_URL,
  QWEN_36_FLASH_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
  QWEN_37_PLUS_MODEL_ID,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
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
  const codingTrailingDot = buildQwenProvider({
    baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
  });
  const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });
  const codingIds = getQwenModelIds(coding);
  const dottedIds = getQwenModelIds(codingTrailingDot);
  expect(coding).toMatchObject({ baseUrl: QWEN_BASE_URL, api: "openai-completions" });
  expect(codingIds).toContain(QWEN_DEFAULT_MODEL_ID);
  expect(dottedIds).toContain("qwen3.6-plus");
  expect(getQwenModelIds(standard)).toContain("qwen3.6-plus");
  expect(codingIds).not.toContain(QWEN_36_FLASH_MODEL_ID);
  expect(dottedIds).not.toContain(QWEN_36_FLASH_MODEL_ID);
  expect(codingIds).not.toContain(QWEN_37_MAX_MODEL_ID);
  expect(codingIds).toContain(QWEN_37_PLUS_MODEL_ID);
  expect(getModel(coding, "qwen3.6-plus")?.reasoning).toBe(true);

  const standardModel = { ...multimodal, maxTokens: 65_536 };
  expect(getModel(standard, QWEN_36_FLASH_MODEL_ID)).toMatchObject(standardModel);
  expect(getModel(standard, QWEN_37_MAX_MODEL_ID)).toMatchObject({
    ...standardModel,
    input: ["text"],
  });
  expect(getModel(standard, QWEN_37_PLUS_MODEL_ID)).toMatchObject(standardModel);
  for (const id of ["qwen3.8-max", "qwen3.8-flash"]) {
    expect(codingIds).not.toContain(id);
    expect(dottedIds).not.toContain(id);
    expect(getModel(standard, id)).toMatchObject(flagship);
  }
});
it("advertises current plan models without the retired compatibility row", () => {
  const provider = buildQwenTokenPlanProvider();
  const models = provider.models;
  const modelIds = models.map((model) => model.id);

  expect(provider.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
  expect(provider.api).toBe("openai-completions");
  expect(modelIds).toEqual([
    QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.6-plus",
    "kimi-k2.5",
    "glm-5",
    "MiniMax-M2.5",
  ]);
  const manifestModels = manifest.modelCatalog.providers["qwen-token-plan"].models;
  expect(models.every((model) => model.reasoning)).toBe(true);
  expect(manifestModels.map((model) => model.id)).toEqual(modelIds);
  expect(manifest.modelCatalog.discovery["qwen-token-plan"]).toBe("refreshable");
});

it("uses current model limits instead of the stale contributor catalog", () => {
  const provider = buildQwenTokenPlanProvider();

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
