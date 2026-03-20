import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("duckduckgo plugin", () => {
  it("exports a valid plugin entry with correct id and name", () => {
    expect(plugin.id).toBe("duckduckgo");
    expect(plugin.name).toBe("DuckDuckGo Plugin");
    expect(typeof plugin.register).toBe("function");
  });

  it("registers web search provider and one tool", () => {
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
    expect(registrations.tools).toHaveLength(1);

    const provider = registrations.webSearchProviders[0] as Record<
      string,
      unknown
    >;
    expect(provider.id).toBe("duckduckgo");
    expect(provider.autoDetectOrder).toBe(100);
    expect(provider.envVars).toEqual([]);

    const toolNames = registrations.tools.map(
      (t) => (t as Record<string, unknown>).name,
    );
    expect(toolNames).toContain("duckduckgo_search");
  });

  it("provider reports credential without API key", () => {
    const registrations: { webSearchProviders: unknown[] } = {
      webSearchProviders: [],
    };

    const mockApi = {
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
      registerTool() {},
      config: {},
    };

    plugin.register(mockApi as never);

    const provider = registrations.webSearchProviders[0] as Record<
      string,
      unknown
    >;
    const getCredentialValue = provider.getCredentialValue as (
      config?: Record<string, unknown>,
    ) => unknown;
    expect(getCredentialValue()).toBe("duckduckgo-no-key-needed");
  });
});
