// Guards which configured transport routes may replace a catalog model's native route.
import { describe, expect, it } from "vitest";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import { hasConfiguredModelRouteSupport } from "./model.configured-overrides.js";

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
    manifestAlias: {},
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
