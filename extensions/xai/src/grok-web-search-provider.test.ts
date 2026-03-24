import { describe, expect, it } from "vitest";
import { withEnv } from "../../../test/helpers/extensions/env.js";
import { __testing } from "./grok-web-search-provider.js";

describe("xai web search helpers", () => {
  it("uses sane defaults for model and inline citations", () => {
    expect(__testing.resolveXaiWebSearchModel()).toBe(__testing.XAI_DEFAULT_WEB_SEARCH_MODEL);
    expect(__testing.resolveXaiInlineCitations()).toBe(false);
  });

  it("reads grok-scoped overrides for model and inline citations", () => {
    const searchConfig = { grok: { model: "xai/grok-4-fast", inlineCitations: true } };
    expect(__testing.resolveXaiWebSearchModel(searchConfig)).toBe("xai/grok-4-fast");
    expect(__testing.resolveXaiInlineCitations(searchConfig)).toBe(true);
  });

  it("extracts text and deduplicated citations from response output", () => {
    expect(
      __testing.extractXaiWebSearchContent({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "hello",
                annotations: [
                  { type: "url_citation", url: "https://a.test" },
                  { type: "url_citation", url: "https://a.test" },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual({ text: "hello", annotationCitations: ["https://a.test"] });
  });

  it("builds wrapped payloads with optional inline citations", () => {
    expect(
      __testing.buildXaiWebSearchPayload({
        query: "q",
        provider: "grok",
        model: "grok-4-fast",
        tookMs: 12,
        content: "body",
        citations: ["https://a.test"],
      }),
    ).toMatchObject({
      query: "q",
      provider: "grok",
      model: "grok-4-fast",
      tookMs: 12,
      citations: ["https://a.test"],
      externalContent: expect.objectContaining({ wrapped: true }),
    });
  });
});

describe("grok web search provider helpers", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(__testing.resolveGrokApiKey({ apiKey: "xai-secret" })).toBe("xai-secret"); // pragma: allowlist secret
    expect(__testing.resolveGrokModel()).toBe("grok-4-1-fast");
    expect(__testing.resolveGrokInlineCitations()).toBe(false);
  });

  it("falls back to XAI_API_KEY env var when no config key set", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(__testing.resolveGrokApiKey({})).toBeUndefined();
    });
  });

  it("reads grok-specific overrides from scoped config", () => {
    expect(__testing.resolveGrokModel({ model: "xai/grok-4-fast" })).toBe("xai/grok-4-fast");
    expect(__testing.resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
  });

  it("normalizes deprecated grok 4.20 beta model ids to GA ids", () => {
    expect(
      __testing.resolveGrokModel({ model: "grok-4.20-experimental-beta-0304-reasoning" }),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      __testing.resolveGrokModel({ model: "grok-4.20-experimental-beta-0304-non-reasoning" }),
    ).toBe("grok-4.20-beta-latest-non-reasoning");
  });
});

describe("grok web search baseUrl resolution", () => {
  it("returns default base URL when not configured", () => {
    expect(__testing.resolveXaiBaseUrl({})).toBe("https://api.x.ai/v1");
    expect(__testing.resolveXaiBaseUrl(undefined)).toBe("https://api.x.ai/v1");
  });

  it("returns configured baseUrl", () => {
    expect(__testing.resolveXaiBaseUrl({ grok: { baseUrl: "https://proxy.example.com/v1" } })).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("strips trailing slash", () => {
    expect(
      __testing.resolveXaiBaseUrl({ grok: { baseUrl: "https://proxy.example.com/v1/" } }),
    ).toBe("https://proxy.example.com/v1");
  });

  it("trims whitespace", () => {
    expect(
      __testing.resolveXaiBaseUrl({ grok: { baseUrl: "  https://proxy.example.com/v1  " } }),
    ).toBe("https://proxy.example.com/v1");
  });
});
