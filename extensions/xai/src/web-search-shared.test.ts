import { describe, expect, it } from "vitest";
import { __testing } from "./web-search-shared.js";

describe("xai web search shared helpers", () => {
  it("uses sane defaults for model and inline citations", () => {
    expect(__testing.resolveXaiWebSearchModel()).toBe(__testing.XAI_DEFAULT_WEB_SEARCH_MODEL);
    expect(__testing.resolveXaiInlineCitations()).toBe(false);
  });

  it("reads grok-scoped overrides for model and inline citations", () => {
    const searchConfig = {
      grok: {
        model: "xai/grok-4-fast",
        inlineCitations: true,
      },
    };

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
    ).toEqual({
      text: "hello",
      annotationCitations: ["https://a.test"],
    });
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
