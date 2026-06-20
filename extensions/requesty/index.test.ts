// Requesty tests cover index plugin behavior.
import fs from "node:fs";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import {
  buildRequestyProvider,
  normalizeRequestyBaseUrl,
  projectRequestyModelCapabilities,
  REQUESTY_BASE_URL,
  REQUESTY_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

type RequestyManifest = {
  providerAuthChoices?: Array<Record<string, unknown>>;
};

function readManifest(): RequestyManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as RequestyManifest;
}

async function registerRequestyProvider() {
  return registerSingleProviderPlugin(plugin);
}

describe("requesty provider hooks", () => {
  it("registers the requesty provider with correct metadata", async () => {
    const provider = await registerRequestyProvider();

    expect(provider.id).toBe("requesty");
    expect(provider.label).toBe("Requesty");
    expect(provider.envVars).toEqual(["REQUESTY_API_KEY"]);
  });

  it("registers API-key auth choice metadata aligned with the manifest", async () => {
    const provider = await registerRequestyProvider();

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "requesty-api-key",
    });
    expect(choice?.provider.id).toBe("requesty");
    expect(choice?.method.id).toBe("api-key");
    expect(readManifest().providerAuthChoices).toStrictEqual([
      {
        provider: "requesty",
        method: "api-key",
        choiceId: "requesty-api-key",
        choiceLabel: "Requesty API key",
        groupId: "requesty",
        groupLabel: "Requesty",
        groupHint: "API key",
        onboardingScopes: ["text-inference"],
        optionKey: "requestyApiKey",
        cliFlag: "--requesty-api-key",
        cliOption: "--requesty-api-key <key>",
        cliDescription: "Requesty API key",
      },
    ]);
  });

  it("resolves the bare provider choice to the API-key method", async () => {
    const provider = await registerRequestyProvider();

    const bareChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "requesty",
    });
    expect(bareChoice?.method.id).toBe("api-key");
  });

  it("exposes a canonical bundled catalog with the default model", () => {
    const modelIds = buildRequestyProvider().models?.map((model) => model.id) ?? [];
    expect(modelIds).toContain(REQUESTY_DEFAULT_MODEL_ID);
    expect(buildRequestyProvider().baseUrl).toBe(REQUESTY_BASE_URL);
    expect(buildRequestyProvider().api).toBe("openai-completions");
  });

  it("canonicalizes the bare host and /v1 base urls", () => {
    expect(normalizeRequestyBaseUrl("https://router.requesty.ai")).toBe(REQUESTY_BASE_URL);
    expect(normalizeRequestyBaseUrl("https://router.requesty.ai/v1/")).toBe(REQUESTY_BASE_URL);
    expect(normalizeRequestyBaseUrl("https://example.com/v1")).toBeUndefined();
  });

  it("projects real per-model capabilities from a /v1/models row", () => {
    const reasoningModel = projectRequestyModelCapabilities({
      id: "anthropic/claude-sonnet-4-5",
      object: "model",
      supports_reasoning: true,
      supports_vision: true,
      supports_tool_calling: true,
      context_window: 1_000_000,
      max_output_tokens: 64_000,
    });
    expect(reasoningModel).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      supportsTools: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });

    const textModel = projectRequestyModelCapabilities({
      id: "openai/gpt-4o-mini",
      object: "model",
      supports_reasoning: false,
      supports_vision: false,
      supports_tool_calling: true,
      context_window: 128_000,
      max_output_tokens: 16_384,
    });
    expect(textModel).toMatchObject({
      reasoning: false,
      input: ["text"],
      supportsTools: true,
    });
  });

  it("resolves arbitrary router model ids dynamically against the requesty base url", async () => {
    const provider = await registerRequestyProvider();

    const resolved = provider.resolveDynamicModel?.({
      provider: "requesty",
      modelId: "requesty/openai/gpt-4o-mini",
      modelRegistry: { find: () => null },
    } as never);

    expect(resolved).toMatchObject({
      id: "requesty/openai/gpt-4o-mini",
      api: "openai-completions",
      provider: "requesty",
      baseUrl: REQUESTY_BASE_URL,
    });
  });

  it("owns passthrough-gemini replay policy for Gemini-backed routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "requesty",
      modelId: "google/gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "requesty",
      modelId: "openai/gpt-4o",
    });
  });
});
