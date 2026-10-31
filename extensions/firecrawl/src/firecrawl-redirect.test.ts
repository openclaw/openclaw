import { withServer } from "openclaw/plugin-sdk/test-env";
import { assert, expect, it } from "vitest";
import { createFirecrawlWebFetchProvider } from "./firecrawl-fetch-provider.js";

it.for([
  ["https://docs.example.com/final", "https://docs.example.com/final"],
  [undefined, "https://example.com/requested"],
  ["file:///etc/passwd", "https://example.com/requested"],
])("preserves the resolved scrape URL for metadata.url=%s", async ([url, finalUrl]) => {
  const requested = "https://example.com/requested";
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      request.resume();
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          data: {
            markdown: "Redirect destination content",
            metadata: { sourceURL: requested, url, statusCode: 200 },
          },
        }),
      );
    },
    async (baseUrl) => {
      const config = {
        plugins: {
          entries: {
            firecrawl: { config: { webFetch: { baseUrl, apiKey: "firecrawl-redirect-test-key" } } },
          },
        },
      };
      const tool = createFirecrawlWebFetchProvider().createTool({ config });
      assert(tool, "Expected Firecrawl fetch provider tool");
      const result = await tool.execute({ url: requested });
      expect(result).toMatchObject({ url: requested, finalUrl, status: 200 });
      expect(result.text).toContain("Redirect destination content");
      expect(requests).toEqual(["POST /v2/scrape"]);
    },
  );
});
