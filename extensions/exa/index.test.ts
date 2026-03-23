import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("exa plugin", () => {
  it("registers the web search provider", () => {
    const registrations: { webSearchProviders: unknown[] } = { webSearchProviders: [] };

    const mockApi = {
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
      config: {},
    };

    plugin.register(mockApi as never);

    expect(plugin.id).toBe("exa");
    expect(plugin.name).toBe("Exa Plugin");
    expect(registrations.webSearchProviders).toHaveLength(1);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("exa");
    expect(provider.autoDetectOrder).toBe(65);
    expect(provider.envVars).toEqual(["EXA_API_KEY"]);
  });
});
