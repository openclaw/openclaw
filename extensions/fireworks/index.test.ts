import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

const makeModel = (overrides: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel => ({
  id: FIREWORKS_DEFAULT_MODEL_ID,
  name: FIREWORKS_DEFAULT_MODEL_ID,
  provider: "fireworks",
  api: "openai-completions",
  baseUrl: FIREWORKS_BASE_URL,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  ...overrides,
});

describe("fireworks provider plugin", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    provider = await registerSingleProviderPlugin(fireworksPlugin);
  });
  const resolveModel = (modelId: string, models = [makeModel()]) =>
    provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({ provider: "fireworks", modelId, models }),
    );
  const thinkingProfile = (modelId: string) =>
    provider.resolveThinkingProfile?.({ provider: "fireworks", modelId });

  it("builds the static Fireworks catalog", async () => {
    const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
    expect(catalog).toMatchObject({ api: "openai-completions", baseUrl: FIREWORKS_BASE_URL });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models?.[0]).toMatchObject({
      id: "accounts/fireworks/routers/glm-5p3-fast",
      name: "GLM 5.3 Fast",
      reasoning: true,
      input: ["text"],
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
    });
  });

  it.each([
    undefined,
    makeModel({
      api: "openai-responses",
      baseUrl: "https://models.example.test/v1",
      headers: { "X-Route": "custom-template" },
      contextWindow: 64_000,
      maxTokens: 16_000,
      cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
    }),
  ])("resolves forward-compat models with template %j", (model) => {
    const template = model ?? makeModel();
    const id = "accounts/fireworks/models/qwen3.6-plus";
    const resolved = resolveModel(id, model ? [model] : []);
    expect(resolved).toMatchObject({
      ...template,
      id,
      name: id,
      input: ["text", "image"],
    });
    expect(resolved?.headers).toEqual(template.headers);
  });

  it.each([
    ["kimi-k2p5-synthetic-test", false, ["text", "image"]],
    ["glm-5p1", true, ["text"]],
  ] as const)("sets reasoning and input metadata for %s", (name, reasoning, input) => {
    const id = `accounts/fireworks/models/${name}`;
    expect(resolveModel(id)).toMatchObject({ provider: "fireworks", id, reasoning, input });
  });

  it("defers manifest catalog models to core static-catalog resolution", () => {
    expect(resolveModel(FIREWORKS_DEFAULT_MODEL_ID)).toBeUndefined();
  });

  it("exposes off-only thinking policy for Fireworks Kimi models", () => {
    const modelId = "accounts/fireworks/models/kimi-k2.6-synthetic-test";
    const offOnly = { levels: [{ id: "off" }], defaultLevel: "off" };
    expect(thinkingProfile("accounts/fireworks/routers/kimi-k2.6-synthetic-test")).toEqual(offOnly);
    expect(thinkingProfile(modelId)).toEqual(offOnly);
    expect(thinkingProfile(FIREWORKS_DEFAULT_MODEL_ID)).toBeUndefined();
    expect(resolveThinkingProfile({ modelId })).toEqual(offOnly);
    expect(
      resolveThinkingProfile({ modelId: "accounts/fireworks/models/qwen3.6-plus" }),
    ).toBeUndefined();
  });
});
