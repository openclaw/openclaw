// Tencent tests cover index plugin behavior.
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import tencentPlugin from "./index.js";

type OpenAICompletionsModel = Model<"openai-completions">;

const registerTencentPlugin = () =>
  registerProviderPlugin({
    plugin: tencentPlugin,
    id: "tencent",
    name: "Tencent Cloud Provider",
  });

async function getTokenHubProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenhub");
}

async function getTokenPlanProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenplan");
}

function hyReasoningModel(params: {
  provider: "tencent-tokenhub" | "tencent-tokenplan";
  id: "hy3" | "hy3-preview";
  baseUrl: string;
}): OpenAICompletionsModel {
  return {
    provider: params.provider,
    id: params.id,
    name: params.id,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 64_000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "high"],
    },
  } as OpenAICompletionsModel;
}

describe("tencent provider plugin", () => {
  it("registers Tencent TokenHub api-key auth metadata", async () => {
    const { providers } = await registerTencentPlugin();
    const provider = requireRegisteredProvider(providers, "tencent-tokenhub");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "tencent-tokenhub-api-key",
    });

    expect(provider.id).toBe("tencent-tokenhub");
    expect(provider.label).toBe("Tencent TokenHub");
    expect(provider.envVars).toEqual(["TENCENT_TOKENHUB_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Tencent TokenHub api-key auth choice");
    }
    expect(resolved.provider.id).toBe("tencent-tokenhub");
    expect(resolved.method.id).toBe("api-key");
  });

  it("registers Tencent TokenPlan api-key auth metadata", async () => {
    const { providers } = await registerTencentPlugin();
    const provider = requireRegisteredProvider(providers, "tencent-tokenplan");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "tencent-tokenplan-api-key",
    });

    expect(provider.id).toBe("tencent-tokenplan");
    expect(provider.label).toBe("Tencent TokenPlan");
    expect(provider.envVars).toEqual(["TENCENT_TOKENPLAN_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Tencent TokenPlan api-key auth choice");
    }
    expect(resolved.provider.id).toBe("tencent-tokenplan");
    expect(resolved.method.id).toBe("api-key");
  });

  it("does not resolve legacy short-name auth choices (manifest is source of truth)", async () => {
    const { providers } = await registerTencentPlugin();
    expect(resolveProviderPluginChoice({ providers, choice: "tokenhub-api-key" })).toBeNull();
    expect(resolveProviderPluginChoice({ providers, choice: "tokenplan-api-key" })).toBeNull();
  });

  it("builds the static Tencent TokenHub model catalog with reasoning flags", async () => {
    const provider = await getTokenHubProvider();
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://tokenhub.tencentmaas.com/v1");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toContain("hy3");
    expect(modelIds).toContain("hy3-preview");

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);

    const hy3Preview = catalogProvider.models?.find((m) => m.id === "hy3-preview");
    expect(hy3Preview?.reasoning).toBe(true);
    expect(hy3Preview?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3Preview?.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);
  });

  it("builds the static Tencent TokenPlan model catalog with reasoning flags", async () => {
    const provider = await getTokenPlanProvider();
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toEqual(["hy3"]);

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);
  });

  it("injects reasoning_effort into TokenPlan hy3 chat-completions payload", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenplan",
      id: "hy3",
      baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "high",
    } as never);

    expect(payload.model).toBe("hy3");
    expect(payload.reasoning_effort).toBe("high");
  });

  it("emits reasoning_effort=high when high effort is requested for TokenHub hy3", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "high",
    } as never);

    expect(payload.reasoning_effort).toBe("high");
  });

  it("emits reasoning_effort=none when none effort is requested for TokenHub hy3", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "none",
    } as never);

    expect(payload.reasoning_effort).toBe("none");
  });

  it("defaults hy3-preview reasoning_effort to high when no effort is provided", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3-preview",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, undefined);

    expect(payload.reasoning_effort).toBe("high");
  });
});
