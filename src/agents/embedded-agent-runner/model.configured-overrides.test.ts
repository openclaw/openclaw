// Guards which configured transport routes may replace a catalog model's native route.
import { describe, expect, it } from "vitest";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  applyConfiguredProviderOverrides,
  hasConfiguredModelRouteSupport,
} from "./model.configured-overrides.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

const providerMetadataOwners = {
  ...makeEmptyPluginMetadataOwners(),
  providerEndpoints: [
    { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
    { endpointClass: "vercel-ai-gateway", hosts: ["ai-gateway.vercel.sh"] },
  ],
};
const catalogModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};

function supportsRoute(baseUrl: string): boolean {
  return hasConfiguredModelRouteSupport({
    provider: "anthropic",
    modelId: catalogModel.id,
    catalogModel: catalogModel as never,
    manifestAlias: { provider: "anthropic" },
    route: { api: "anthropic-messages", baseUrl },
    providerMetadataOwners: providerMetadataOwners as never,
  });
}

describe("hasConfiguredModelRouteSupport", () => {
  it("keeps catalog models routed through Vercel AI Gateway as operator proxy routes", () => {
    expect(supportsRoute("https://ai-gateway.vercel.sh")).toBe(true);
    expect(supportsRoute("https://proxy.example.com")).toBe(true);
  });
});

it.each(["provider", "model"] as const)(
  "honors an explicit %s GenerateContent override over Flash's catalog route",
  (scope) => {
    const model: ProviderRuntimeModel = {
      ...makeModel("gemini-3.8-flash"),
      ...catalogModel,
      input: ["text"],
      provider: "google",
      id: "gemini-3.8-flash",
      name: "Gemini Flash",
      api: "google-interactions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    };
    const resolved = applyConfiguredProviderOverrides({
      provider: "google",
      modelId: model.id,
      discoveredModel: model,
      providerConfig: {
        baseUrl: model.baseUrl,
        ...(scope === "provider" ? { api: "google-generative-ai" as const } : {}),
        models:
          scope === "model"
            ? [
                {
                  id: model.id,
                  name: model.name,
                  api: "google-generative-ai" as const,
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1,
                  maxTokens: 1,
                },
              ]
            : [],
      },
      manifestAlias: { provider: "google" },
      providerMetadataOwners,
      runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: [] }),
    });
    expect(resolved).toMatchObject({
      id: model.id,
      api: "google-generative-ai",
      baseUrl: model.baseUrl,
    });
  },
);
