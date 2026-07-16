import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import llmrouterPlugin from "./index.js";
import { applyLlmrouterConfig } from "./onboard.js";

describe("LLMRouter provider registration", () => {
  it("registers api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "llmrouter-api-key",
    });

    expect(provider).toMatchObject({
      id: "llmrouter",
      label: "LLMRouter",
      docsPath: "/providers/llmrouter",
      envVars: ["LLMROUTER_API_KEY"],
      resolveDynamicModel: expect.any(Function),
    });
    expect(provider.auth).toHaveLength(1);
    expect(choice?.provider.id).toBe("llmrouter");
    expect(choice?.method.id).toBe("api-key");
  });

  it("builds the static auto-routing catalog", async () => {
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    const catalog = await runSingleProviderCatalog(provider);

    expect(catalog).toMatchObject({
      baseUrl: "https://api.llmrouter.sh/v1",
      api: "openai-completions",
      apiKey: "test-key",
    });
    expect(catalog.models?.map((model) => model.id)).toEqual(["auto"]);
    const autoModel = catalog.models?.[0];
    expect(autoModel?.reasoning).toBe(false);
    expect(autoModel?.input).toEqual(["text", "image"]);
    expect(autoModel?.contextWindow).toBe(200_000);
    expect(autoModel?.maxTokens).toBe(8192);
    expect(autoModel?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("sets llmrouter/auto as the default model on apply", () => {
    expect(resolveAgentModelPrimaryValue(applyLlmrouterConfig({}).agents?.defaults?.model)).toBe(
      "llmrouter/auto",
    );
  });

  it.each([
    ["claude-opus-4.6", "anthropic"],
    ["gpt-5.4", "openai"],
    ["gemini-2.5-pro", "google"],
    ["deepseek-r1", "deepseek"],
  ])("resolves unknown model id %s as a pinned pass-through slug", async (modelId) => {
    // LLMRouter's registry uses bare slugs with no provider prefix (`GET
    // /v1/models`), so a pinned model ref stays exactly `llmrouter/<slug>`
    // regardless of which upstream family it resolves to.
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    const resolved = provider.resolveDynamicModel?.({
      provider: "llmrouter",
      modelId,
    } as never);

    expect(resolved).toMatchObject({
      id: modelId,
      name: modelId,
      provider: "llmrouter",
      api: "openai-completions",
      baseUrl: "https://api.llmrouter.sh/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("does not shadow the static catalog's auto model with a dynamic passthrough", async () => {
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    expect(
      provider.resolveDynamicModel?.({ provider: "llmrouter", modelId: "auto" } as never),
    ).toBeUndefined();
  });

  it("owns OpenAI-compatible replay policy and drops reasoning across auto-routed turns", async () => {
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    const replayPolicy = provider.buildReplayPolicy?.({
      modelApi: "openai-completions",
    } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    // "auto" can route different turns to different backend models, so a prior
    // turn's reasoning content is not safe to replay into the next request.
    expect(replayPolicy?.dropReasoningFromHistory).toBe(true);
  });

  it("treats llmrouter model refs as modern", async () => {
    const provider = await registerSingleProviderPlugin(llmrouterPlugin);
    expect(provider.isModernModelRef?.({ provider: "llmrouter", modelId: "auto" } as never)).toBe(
      true,
    );
  });
});
