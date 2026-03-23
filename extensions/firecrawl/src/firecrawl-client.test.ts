import { describe, expect, it } from "vitest";
import { __testing } from "./firecrawl-client.js";

describe("firecrawl client helpers", () => {
  it("normalizes mixed search payload shapes into search items", () => {
    expect(
      __testing.resolveSearchItems({
        data: {
          results: [
            {
              sourceURL: "https://www.example.com/post",
              snippet: "Snippet text",
              markdown: "# Title\nBody",
              metadata: {
                title: "Example title",
                publishedDate: "2026-03-22",
              },
            },
            {
              url: "",
            },
          ],
        },
      }),
    ).toEqual([
      {
        title: "Example title",
        url: "https://www.example.com/post",
        description: "Snippet text",
        content: "# Title\nBody",
        published: "2026-03-22",
        siteName: "example.com",
      },
    ]);
  });

  it("parses scrape payloads, extracts text, and marks truncation", () => {
    const result = __testing.parseFirecrawlScrapePayload({
      payload: {
        data: {
          markdown: "# Hello\n\nThis is a long body for scraping.",
          metadata: {
            title: "Example page",
            sourceURL: "https://docs.example.com/page",
            statusCode: 200,
          },
        },
        warning: "cached result",
      },
      url: "https://docs.example.com/page",
      extractMode: "text",
      maxChars: 12,
    });

    expect(result.finalUrl).toBe("https://docs.example.com/page");
    expect(result.status).toBe(200);
    expect(result.extractMode).toBe("text");
    expect(result.truncated).toBe(true);
    expect(result.rawLength).toBeGreaterThan(12);
    expect(String(result.text)).toContain("Hello");
    expect(String(result.title)).toContain("Example page");
    expect(String(result.warning)).toContain("cached result");
  });

  it("throws when scrape payload has no usable content", () => {
    expect(() =>
      __testing.parseFirecrawlScrapePayload({
        payload: {
          data: {},
        },
        url: "https://docs.example.com/page",
        extractMode: "markdown",
        maxChars: 100,
      }),
    ).toThrow("Firecrawl scrape returned no content.");
  });
});
