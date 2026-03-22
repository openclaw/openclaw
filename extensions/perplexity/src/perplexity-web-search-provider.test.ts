import { describe, expect, it } from "vitest";
import { __testing } from "./perplexity-web-search-provider.js";

describe("perplexity web search provider", () => {
  it("infers provider routing from api key prefixes", () => {
    expect(__testing.inferPerplexityBaseUrlFromApiKey("pplx-abc")).toBe("direct");
    expect(__testing.inferPerplexityBaseUrlFromApiKey("sk-or-v1-abc")).toBe("openrouter");
    expect(__testing.inferPerplexityBaseUrlFromApiKey("unknown")).toBeUndefined();
  });

  it("resolves base url from auth source and request model by transport", () => {
    expect(__testing.resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe(
      "https://api.perplexity.ai",
    );
    expect(__testing.resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(__testing.resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
    expect(
      __testing.resolvePerplexityRequestModel(
        "https://openrouter.ai/api/v1",
        "perplexity/sonar-pro",
      ),
    ).toBe("perplexity/sonar-pro");
  });

  it("chooses direct search_api transport only for direct base urls without legacy overrides", () => {
    expect(
      __testing.resolvePerplexityTransport({
        baseUrl: "https://api.perplexity.ai",
      }).transport,
    ).toBe("chat_completions");

    expect(
      __testing.resolvePerplexityTransport({
        apiKey: "pplx-secret",
      }).transport,
    ).toBe("search_api");
  });
});
