import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("you plugin", () => {
  it("exports a valid plugin entry with correct id and name", () => {
    expect(plugin.id).toBe("you");
    expect(plugin.name).toBe("You.com Plugin");
    expect(typeof plugin.register).toBe("function");
  });

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

    expect(registrations.webSearchProviders).toHaveLength(1);
    expect(registrations.tools).toHaveLength(2);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("you");
    expect(provider.autoDetectOrder).toBe(80);
    expect(provider.envVars).toEqual(["YDC_API_KEY"]);
    expect(provider.requiresCredential).toBe(false);

    const toolNames = registrations.tools.map((t) => (t as Record<string, unknown>).name);
    expect(toolNames).toContain("web_research");
    expect(toolNames).toContain("web_contents");
  });
});
