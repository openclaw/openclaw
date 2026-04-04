import { describe, expect, it } from "vitest";
import { __testing } from "./responses-tool-shared.js";

describe("xai responses tool helpers", () => {
  it("builds the shared xAI Responses tool body", () => {
    expect(
      __testing.buildXaiResponsesToolBody({
        model: "grok-4-1-fast",
        inputText: "search for openclaw",
        tools: [{ type: "x_search" }],
        maxTurns: 2,
      }),
    ).toEqual({
      model: "grok-4-1-fast",
      input: [{ role: "user", content: "search for openclaw" }],
      tools: [{ type: "x_search" }],
      max_turns: 2,
    });
  });

  it("falls back to annotation citations when the API omits top-level citations", () => {
    expect(
      __testing.resolveXaiResponseTextAndCitations({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Found it",
                annotations: [{ type: "url_citation", url: "https://example.com/a" }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      content: "Found it",
      citations: ["https://example.com/a"],
    });
  });

  it("prefers explicit top-level citations when present", () => {
    expect(
      __testing.resolveXaiResponseTextAndCitations({
        output_text: "Done",
        citations: ["https://example.com/b"],
      }),
    ).toEqual({
      content: "Done",
      citations: ["https://example.com/b"],
    });
  });
});
