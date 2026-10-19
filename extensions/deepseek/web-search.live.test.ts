import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { createDeepSeekWebSearchProvider } from "./web-search-provider.js";

const enabled =
  isLiveTestEnabled(["DEEPSEEK_SEARCH_LIVE_TEST"]) && Boolean(process.env.DEEPSEEK_API_KEY);
const describeLive = enabled ? describe : describe.skip;

describeLive("DeepSeek search live API", () => {
  it("returns usable sources through the production provider", async () => {
    const tool = createDeepSeekWebSearchProvider().createTool({
      config: {},
      searchConfig: { cacheTtlMinutes: 0, timeoutSeconds: 30 },
    });
    if (!tool) {
      throw new Error("Expected DeepSeek search tool");
    }
    const result = await tool.execute({ query: "OpenClaw site:docs.openclaw.ai", count: 3 });
    expect(result).not.toHaveProperty("error");
    expect(result.provider).toBe("deepseek");
    expect(Array.isArray(result.results)).toBe(true);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(
      results.some(
        (entry) =>
          typeof entry.url === "string" &&
          entry.url.startsWith("https://docs.openclaw.ai/") &&
          typeof entry.snippet === "string" &&
          entry.snippet.length > 0,
      ),
    ).toBe(true);
    expect(result).not.toHaveProperty("cached");
  }, 45_000);
});
