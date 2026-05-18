import { describe, expect, it } from "vitest";
import { __testing } from "./composio-client.js";

describe("composio client", () => {
  it("normalizes Composio organic results into OpenClaw web search results", () => {
    expect(
      __testing.normalizeComposioSearchResult({
        title: "OpenClaw",
        link: "https://openclaw.ai/docs",
        snippet: "Agent runtime",
      }),
    ).toEqual({
      title: "OpenClaw",
      url: "https://openclaw.ai/docs",
      snippet: "Agent runtime",
      siteName: "openclaw.ai",
    });
  });

  it("bounds result counts", () => {
    expect(__testing.resolveSearchCount(undefined)).toBe(5);
    expect(__testing.resolveSearchCount(0)).toBe(1);
    expect(__testing.resolveSearchCount(50)).toBe(10);
  });

  it("surfaces explicit Composio failures", () => {
    expect(() =>
      __testing.readComposioResults({ successful: false, error: "quota exceeded" }),
    ).toThrow("Composio Search failed: quota exceeded");
  });
});
