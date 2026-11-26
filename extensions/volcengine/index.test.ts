import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS } from "./api.js";
import plugin from "./index.js";

describe("volcengine plugin", () => {
  it("marks direct and coding models with tool schema keyword compat", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.hookAliases).toContain("volcengine-plan");
    const normalized = provider.normalizeResolvedModel?.({
      model: { compat: { unsupportedToolSchemaKeywords: ["not"] } },
    } as never);
    expect(normalized?.compat).toEqual({
      unsupportedToolSchemaKeywords: ["not", ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS],
    });
    const normalizedAgain = provider.normalizeResolvedModel?.({ model: normalized } as never);
    expect(normalizedAgain).toBe(normalized);
  });
});
