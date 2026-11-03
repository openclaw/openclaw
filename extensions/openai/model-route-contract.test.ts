import { describe, expect, it } from "vitest";
import {
  OPENAI_CHATGPT_MODERN_MODEL_IDS,
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  isOpenAIDualRouteModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";

function resolveUnconfiguredModel(modelId: string) {
  return resolveModelRoutes({ provider: "openai", modelId, env: {} });
}
const platformRoute = { api: "openai-completions", authRequirement: "api-key" };
const subscriptionRoute = { api: "openai-chatgpt-responses", authRequirement: "subscription" };
const dualApis = ["openai-responses", "openai-chatgpt-responses"];
const completions = { api: "openai-completions" } as const;
function resolveBilling(overrides: Partial<Parameters<typeof resolveModelRoutes>[0]>) {
  return resolveModelRoutes({
    provider: "openai",
    modelId: "gpt-5.4-mini",
    configuredProvider: completions,
    ...overrides,
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

  it("keeps route eligibility aligned with the registered provider", () => {
    const provider = buildOpenAIProvider();
    const routeModelIds = [
      ...new Set([...OPENAI_PROVIDER_MODERN_MODEL_IDS, ...OPENAI_CHATGPT_MODERN_MODEL_IDS]),
    ];
    const dual = routeModelIds.filter(isOpenAIDualRouteModelId);
    const platform = routeModelIds.filter(isOpenAIPlatformOnlyRouteModelId);
    const subscription = routeModelIds.filter(isOpenAISubscriptionOnlyRouteModelId);
    const eligible = [...dual, ...platform, ...subscription];
    expect(new Set(eligible).size).toBe(eligible.length);

    for (const modelId of OPENAI_PROVIDER_MODERN_MODEL_IDS) {
      expect(provider.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }
    for (const modelId of dual) {
      const resolution = resolveUnconfiguredModel(modelId);
      expect(
        resolution.kind === "routes" ? resolution.routes.map((route) => route.api) : [],
      ).toEqual(dualApis);
    }
    for (const [models, route] of [
      [platform, { api: "openai-responses", authRequirement: "api-key" }],
      [subscription, subscriptionRoute],
    ] as const) {
      for (const modelId of models) {
        expect(resolveUnconfiguredModel(modelId)).toMatchObject({
          kind: "routes",
          defaultRuntimeId: "codex",
          routes: [route],
        });
      }
    }
  });
});

describe("OpenAI billing route intent", () => {
  it.each([undefined, { runtimeId: "codex", source: "inherited" } as const])(
    "keeps subscription eligible with a legacy official Completions adapter (%j)",
    (routeIntent) => {
      expect(
        resolveBilling({
          configuredProvider: { ...completions, baseUrl: "https://api.openai.com/v1" },
          routeIntent,
        }),
      ).toMatchObject({
        kind: "routes",
        preferredAuthRequirement: "subscription",
        routes: [platformRoute, subscriptionRoute],
      });
    },
  );

  it.each([
    { authRequirement: "api-key", source: "explicit" },
    { authRequirement: "api-key", source: "inherited" },
  ] as const)("honors the prepared API route intent %j", (routeIntent) => {
    expect(resolveBilling({ routeIntent })).toMatchObject({
      kind: "routes",
      routes:
        routeIntent.source === "explicit" ? [platformRoute] : [platformRoute, subscriptionRoute],
      ...(routeIntent.source === "inherited" ? { preferredAuthRequirement: "api-key" } : {}),
    });
  });

  it("keeps subscription eligible for an OpenClaw runtime pin with no API credential", () => {
    const routeIntent = { runtimeId: "openclaw", source: "explicit" } as const;
    expect(resolveBilling({ routeIntent })).toMatchObject({
      kind: "routes",
      preferredAuthRequirement: "api-key",
      routes: [{ authRequirement: "api-key" }, { authRequirement: "subscription" }],
    });
  });
  it("retains the provider adapter for API-key callers when the model overrides its official URL", () => {
    expect(
      resolveBilling({
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      preferredAuthRequirement: "subscription",
      routes: [
        {
          ...platformRoute,
          baseUrl: "https://api.openai.com/v1",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
        {
          ...subscriptionRoute,
          baseUrl: "https://chatgpt.com/backend-api/codex",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });
});
