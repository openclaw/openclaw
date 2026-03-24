import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("tavily plugin", () => {
  it("registers web search provider and two tools", () => {
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

    expect(plugin.id).toBe("tavily");
    expect(plugin.name).toBe("Tavily Plugin");
    expect(registrations.webSearchProviders).toHaveLength(1);
    expect(registrations.tools).toHaveLength(2);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("tavily");
    expect(provider.autoDetectOrder).toBe(70);
    expect(provider.envVars).toEqual(["TAVILY_API_KEY"]);

    const toolNames = registrations.tools.map((t) => (t as Record<string, unknown>).name);
    expect(toolNames).toContain("tavily_search");
    expect(toolNames).toContain("tavily_extract");
  });
});
