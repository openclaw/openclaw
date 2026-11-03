import { describe, expect, it } from "vitest";
import { formatGitHubPublicationTranscript } from "./publication-transcript-api.js";

describe("publication transcript formatting", () => {
  it("includes the failure and next action under its stable retry identity", () => {
    expect(
      formatGitHubPublicationTranscript({
        requestId: "formatter-failure",
        status: "failed",
        code: "push_rejected",
        message: "GitHub publication failed.",
        nextAction: "Check repository write access and retry.",
      }),
    ).toEqual({
      responseId: "github-publication:formatter-failure",
      text: "GitHub publication failed. Check repository write access and retry.",
    });
  });
});
