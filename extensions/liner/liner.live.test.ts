import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createLinerWebSearchProvider } from "./src/liner-web-search-provider.js";

const LINER_API_KEY = process.env.LINER_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && LINER_API_KEY.length > 0 ? describe : describe.skip;

const LINER_LIVE_TIMEOUT_MS = 120_000;

describeLive("liner plugin live", () => {
  it(
    "runs Liner web search through the provider tool",
    async () => {
      const provider = createLinerWebSearchProvider();
      const tool = provider.createTool?.({
        config: {},
        searchConfig: { liner: { apiKey: LINER_API_KEY } },
      });
      if (!tool) {
        throw new Error("Expected Liner provider tool");
      }

      const result = (await tool.execute({
        query: "openclaw github repository",
        count: 3,
      })) as {
        provider?: string;
        count?: number;
        results?: Array<{ url?: string; title?: string; description?: string }>;
        requestId?: string;
      };

      expect(result.provider).toBe("liner");
      expect(typeof result.count).toBe("number");
      expect(Array.isArray(result.results)).toBe(true);
      expect((result.results ?? []).length).toBeGreaterThan(0);
      const first = result.results?.[0];
      expect((first?.url ?? "").startsWith("http")).toBe(true);
    },
    LINER_LIVE_TIMEOUT_MS,
  );
});
