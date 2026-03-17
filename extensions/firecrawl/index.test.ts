import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { __testing as firecrawlClientTesting } from "./src/firecrawl-client.js";

describe("firecrawl plugin", () => {
  it("registers a web search provider and tools", () => {
    const tools: Array<{ name: string }> = [];
    const webSearchProviders: Array<{ id: string }> = [];

    plugin.register?.({
      config: {},
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      registerWebSearchProvider(provider: { id: string }) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(webSearchProviders.map((provider) => provider.id)).toEqual(["firecrawl"]);
    expect(tools.map((tool) => tool.name)).toEqual(["firecrawl_search", "firecrawl_scrape"]);
  });

  it("parses scrape payloads into wrapped external-content results", () => {
    const result = firecrawlClientTesting.parseFirecrawlScrapePayload({
      payload: {
        success: true,
        data: {
          markdown: "# Hello\n\nWorld",
          metadata: {
            title: "Example page",
            sourceURL: "https://example.com/final",
            statusCode: 200,
          },
        },
      },
      url: "https://example.com/start",
      extractMode: "text",
      maxChars: 1000,
    });

    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.status).toBe(200);
    expect(result.extractor).toBe("firecrawl");
    expect(typeof result.text).toBe("string");
  });

  it("extracts search items from flexible Firecrawl payload shapes", () => {
    const items = firecrawlClientTesting.resolveSearchItems({
      success: true,
      data: [
        {
          title: "Docs",
          url: "https://docs.example.com/path",
          description: "Reference docs",
          markdown: "Body",
        },
      ],
    });

    expect(items).toEqual([
      {
        title: "Docs",
        url: "https://docs.example.com/path",
        description: "Reference docs",
        content: "Body",
        published: undefined,
        siteName: "docs.example.com",
      },
    ]);
  });

  it("extracts search items from Firecrawl v2 data.web payloads", () => {
    const items = firecrawlClientTesting.resolveSearchItems({
      success: true,
      data: {
        web: [
          {
            title: "API Platform - OpenAI",
            url: "https://openai.com/api/",
            description: "Build on the OpenAI API platform.",
            markdown: "# API Platform",
            position: 1,
          },
        ],
      },
    });

    expect(items).toEqual([
      {
        title: "API Platform - OpenAI",
        url: "https://openai.com/api/",
        description: "Build on the OpenAI API platform.",
        content: "# API Platform",
        published: undefined,
        siteName: "openai.com",
      },
    ]);
  });
});
