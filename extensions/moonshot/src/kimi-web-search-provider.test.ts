import { describe, expect, it } from "vitest";
import { __testing } from "./kimi-web-search-provider.js";

describe("kimi web search provider", () => {
  it("uses configured model and base url overrides with sane defaults", () => {
    expect(__testing.resolveKimiModel()).toBe("moonshot-v1-128k");
    expect(__testing.resolveKimiModel({ model: "kimi-k2" })).toBe("kimi-k2");
    expect(__testing.resolveKimiBaseUrl()).toBe("https://api.moonshot.ai/v1");
    expect(__testing.resolveKimiBaseUrl({ baseUrl: "https://kimi.example/v1" })).toBe(
      "https://kimi.example/v1",
    );
  });

  it("extracts unique citations from search results and tool call arguments", () => {
    expect(
      __testing.extractKimiCitations({
        search_results: [{ url: "https://a.test" }, { url: "https://b.test" }],
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      url: "https://a.test",
                      search_results: [{ url: "https://c.test" }],
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
  });

  it("builds tool result content by echoing search_id from tool call arguments", () => {
    // The Kimi $web_search builtin returns a search_id in the tool call arguments.
    // buildKimiToolResultContent must pass it back unchanged so Kimi can resolve
    // the cached search results on the next round.
    const searchId = "abc123";
    const result = __testing.buildKimiToolResultContent({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "t-web_search-1",
                function: {
                  name: "$web_search",
                  arguments: JSON.stringify({ search_result: { search_id: searchId } }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.parse(result)).toEqual({ search_result: { search_id: searchId } });
  });

  it("falls back to search_results array when no search_id is present in tool call arguments", () => {
    const result = __testing.buildKimiToolResultContent({
      search_results: [
        { title: "Page A", url: "https://a.test", content: "content A" },
        { title: "Page B", url: "https://b.test", content: "content B" },
      ],
    });
    expect(JSON.parse(result)).toEqual({
      search_results: [
        { title: "Page A", url: "https://a.test", content: "content A" },
        { title: "Page B", url: "https://b.test", content: "content B" },
      ],
    });
  });

  it("falls back gracefully when tool call arguments are malformed JSON", () => {
    const result = __testing.buildKimiToolResultContent({
      choices: [
        {
          message: {
            tool_calls: [{ function: { arguments: "not-valid-json" } }],
          },
        },
      ],
    });
    expect(JSON.parse(result)).toEqual({ search_results: [] });
  });
});
