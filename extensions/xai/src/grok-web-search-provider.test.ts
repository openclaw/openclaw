import { describe, expect, it } from "vitest";
import { withEnv } from "../../../src/test-utils/env.js";
import { __testing } from "./grok-web-search-provider.js";

describe("grok web search provider", () => {
  it("uses config apiKey when provided", () => {
    expect(__testing.resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("falls back to env apiKey", () => {
    withEnv({ XAI_API_KEY: "xai-env-key" }, () => {
      expect(__testing.resolveGrokApiKey({})).toBe("xai-env-key");
    });
  });

  it("uses config model when provided", () => {
    expect(__testing.resolveGrokModel({ model: "grok-4-fast" })).toBe("grok-4-fast");
  });

  it("normalizes deprecated grok 4.20 beta ids to GA ids", () => {
    expect(
      __testing.resolveGrokModel({ model: "grok-4.20-experimental-beta-0304-reasoning" }),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      __testing.resolveGrokModel({ model: "grok-4.20-experimental-beta-0304-non-reasoning" }),
    ).toBe("grok-4.20-beta-latest-non-reasoning");
  });

  it("falls back to default model", () => {
    expect(__testing.resolveGrokModel({})).toBe("grok-4-1-fast");
  });

  it("resolves inline citations flag", () => {
    expect(__testing.resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(__testing.resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
    expect(__testing.resolveGrokInlineCitations({})).toBe(false);
  });

  it("extracts content and annotation citations", () => {
    expect(
      __testing.extractGrokContent({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Result",
                annotations: [{ type: "url_citation", url: "https://example.com" }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      text: "Result",
      annotationCitations: ["https://example.com"],
    });
  });
});
