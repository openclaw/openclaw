import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("searxng plugin", () => {
  it("registers web search provider", () => {
    const registrations: {
      webSearchProviders: unknown[];
      tools: unknown[];
    } = { webSearchProviders: [], tools: [] };

    const mockApi = {
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
      registerTool(tool: unknown) {
        registrations.tools.push(tool);
      },
      config: {},
    };

    plugin.register(mockApi as never);

    expect(plugin.id).toBe("searxng");
    expect(registrations.webSearchProviders).toHaveLength(1);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("searxng");
    expect(provider.autoDetectOrder).toBe(80);
    expect(provider.envVars).toEqual(["SEARXNG_API_KEY"]);
  });
});
