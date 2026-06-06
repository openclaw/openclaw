import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createSeltzWebSearchProvider } from "./src/seltz-web-search-provider.js";

const SELTZ_API_KEY = process.env.SELTZ_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && SELTZ_API_KEY.length > 0 ? describe : describe.skip;

const SELTZ_LIVE_TIMEOUT_MS = 120_000;

describeLive("seltz plugin live", () => {
  it(
    "runs Seltz web search through the provider tool",
    async () => {
      const provider = createSeltzWebSearchProvider();
      const tool = provider.createTool?.({
        config: {},
        searchConfig: { seltz: { apiKey: SELTZ_API_KEY } },
      });
      if (!tool) {
        throw new Error("Expected Seltz provider tool");
      }

      const result = (await tool.execute({
        query: "OpenClaw GitHub repository",
        count: 3,
      })) as {
        provider?: string;
        count?: number;
        results?: Array<{ url?: string; title?: string; description?: string }>;
      };

      expect(result.provider).toBe("seltz");
      expect(typeof result.count).toBe("number");
      expect(Array.isArray(result.results)).toBe(true);
      expect((result.results ?? []).length).toBeGreaterThan(0);
      const first = result.results?.[0];
      expect((first?.url ?? "").startsWith("http")).toBe(true);
      expect(typeof first?.description).toBe("string");
    },
    SELTZ_LIVE_TIMEOUT_MS,
  );
});
