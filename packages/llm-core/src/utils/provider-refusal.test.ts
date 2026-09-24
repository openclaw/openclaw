import { describe, expect, it } from "vitest";
import { readProviderRefusalReview } from "./provider-refusal.js";

describe("provider refusal review", () => {
  it("preserves the exact maximum UTF-8 explanation and continuation", () => {
    const review = {
      explanation: "🙂".repeat(16_384),
      continuation: { message: ` ${"🙂".repeat(255)}   ` },
      errorType: "a_future_provider_category",
    };
    expect(readProviderRefusalReview(review)).toEqual(review);
  });

  it.each([undefined, "", " \n ", "🙂".repeat(16_385)])(
    "does not offer a review without a substantive bounded explanation",
    (explanation) => {
      expect(
        readProviderRefusalReview({ explanation, continuation: { message: "Continue safely." } }),
      ).toBeUndefined();
    },
  );

  it.each([undefined, "", " \n ", 42, "🙂".repeat(257)])(
    "keeps findings without manufacturing a usable continuation",
    (message) => {
      expect(
        readProviderRefusalReview({ explanation: "Review the action.", continuation: { message } }),
      ).toEqual({ explanation: "Review the action." });
    },
  );
});
