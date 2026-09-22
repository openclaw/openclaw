import { describe, expect, it } from "vitest";
import {
  OPENAI_CHATGPT_MODERN_MODEL_IDS,
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  isOpenAIDualRouteModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import { buildOpenAICodexProviderHooks } from "./openai-chatgpt-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";

function resolveUnconfiguredModel(modelId: string) {
  return resolveModelRoutes({
    provider: "openai",
    modelId,
    env: {},
  });
}

describe("OpenAI model route contract", () => {
  it("preserves custom model spelling while matching built-in routes case-insensitively", () => {
    expect(normalizeOpenAIModelRouteId("  openai/Future-MODEL  ")).toBe("openai/Future-MODEL");
    expect(normalizeOpenAIModelRouteId("future-model")).toBe("future-model");
    expect(normalizeOpenAIModelRouteId("GPT-5.4-CODEX")).toBe("gpt-5.4");

    expect(isOpenAIDualRouteModelId("GPT-5.5")).toBe(true);
    expect(isOpenAIDualRouteModelId("gpt-6-astra")).toBe(true);
    expect(isOpenAIPlatformOnlyRouteModelId("CHAT-LATEST")).toBe(true);
    expect(isOpenAISubscriptionOnlyRouteModelId("GPT-5.3-CODEX-SPARK")).toBe(true);
  });

  it("keeps route eligibility aligned with both provider runtime surfaces", () => {
    const provider = buildOpenAIProvider();
    const chatGPTHooks = buildOpenAICodexProviderHooks();
    const routeModelIds = [
      ...new Set([...OPENAI_PROVIDER_MODERN_MODEL_IDS, ...OPENAI_CHATGPT_MODERN_MODEL_IDS]),
    ];
    const dualRouteModelIds = routeModelIds.filter(isOpenAIDualRouteModelId);
    const platformOnlyRouteModelIds = routeModelIds.filter(isOpenAIPlatformOnlyRouteModelId);
    const subscriptionOnlyRouteModelIds = routeModelIds.filter(
      isOpenAISubscriptionOnlyRouteModelId,
    );

    expect(
      new Set([
        ...dualRouteModelIds,
        ...platformOnlyRouteModelIds,
        ...subscriptionOnlyRouteModelIds,
      ]).size,
    ).toBe(
      dualRouteModelIds.length +
        platformOnlyRouteModelIds.length +
        subscriptionOnlyRouteModelIds.length,
    );

    for (const modelId of OPENAI_PROVIDER_MODERN_MODEL_IDS) {
      expect(provider.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }
    for (const modelId of OPENAI_CHATGPT_MODERN_MODEL_IDS) {
      expect(chatGPTHooks.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }

    for (const modelId of dualRouteModelIds) {
      const resolution = resolveUnconfiguredModel(modelId);
      expect(
        resolution.kind === "routes" ? resolution.routes.map((route) => route.api) : [],
      ).toEqual(["openai-responses", "openai-chatgpt-responses"]);
    }
    for (const modelId of platformOnlyRouteModelIds) {
      expect(resolveUnconfiguredModel(modelId)).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-responses", authRequirement: "api-key" }],
      });
    }
    for (const modelId of subscriptionOnlyRouteModelIds) {
      expect(resolveUnconfiguredModel(modelId)).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
      });
    }
  });
});

describe("OpenAI billing route intent", () => {
  it.each([undefined, { runtimeId: "codex", source: "inherited" } as const])(
    "keeps subscription eligible with a legacy official Completions adapter (%j)",
    (routeIntent) => {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.4-mini",
          configuredProvider: {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
          routeIntent,
        }),
      ).toMatchObject({
        kind: "routes",
        preferredAuthRequirement: "subscription",
        routes: [
          { api: "openai-completions", authRequirement: "api-key" },
          { api: "openai-chatgpt-responses", authRequirement: "subscription" },
        ],
      });
    },
  );

  it.each([
    { authRequirement: "api-key", source: "explicit" },
    { authRequirement: "api-key", source: "inherited" },
  ] as const)("honors the prepared API route intent %j", (routeIntent) => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        configuredProvider: { api: "openai-completions" },
        routeIntent,
      }),
    ).toMatchObject({
      kind: "routes",
      routes:
        routeIntent.source === "explicit"
          ? [{ api: "openai-completions", authRequirement: "api-key" }]
          : [
              { api: "openai-completions", authRequirement: "api-key" },
              { api: "openai-chatgpt-responses", authRequirement: "subscription" },
            ],
      ...(routeIntent.source === "inherited" ? { preferredAuthRequirement: "api-key" } : {}),
    });
  });

  it("keeps subscription eligible for an OpenClaw runtime pin with no API credential", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        configuredProvider: { api: "openai-completions" },
        routeIntent: { runtimeId: "openclaw", source: "explicit" },
      }),
    ).toMatchObject({
      kind: "routes",
      preferredAuthRequirement: "api-key",
      routes: [{ authRequirement: "api-key" }, { authRequirement: "subscription" }],
    });
  });
  it("retains the provider adapter for API-key callers when the model overrides its official URL", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://api.openai.com/v1" },
        configuredProvider: { api: "openai-completions" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      preferredAuthRequirement: "subscription",
      routes: [
        {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });
});
