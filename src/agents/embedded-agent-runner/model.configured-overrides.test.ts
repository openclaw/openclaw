// Guards which configured transport routes may replace a catalog model's native route.
import { describe, expect, it } from "vitest";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import {
  hasConfiguredModelRouteSupport,
  resolveConfiguredProviderDefaultApi,
} from "./model.configured-overrides.js";
import { resolveRuntimeHooks } from "./model.provider-hooks.js";

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

it("resolves a configured provider transport with the node's supplied environment", () => {
  const env = { OPENCLAW_TEST_TRANSPORT: "native" };
  const api = resolveConfiguredProviderDefaultApi({
    provider: "node-fixture",
    providerConfig: { baseUrl: "https://models.example/v1", models: [] },
    env,
    runtimeHooks: {
      ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
      normalizeProviderTransportWithPlugin: ({ env: lookupEnv }) => ({
        api:
          lookupEnv?.OPENCLAW_TEST_TRANSPORT === "native"
            ? "anthropic-messages"
            : "openai-completions",
      }),
    },
  });
  expect(api).toBe("anthropic-messages");
});
