import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("duckduckgo plugin", () => {
  it("registers a keyless web search provider", () => {
    const webSearchProviders: unknown[] = [];

    plugin.register({
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(plugin.id).toBe("duckduckgo");
    expect(webSearchProviders).toHaveLength(1);

    const provider = webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("duckduckgo");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
  });
});
