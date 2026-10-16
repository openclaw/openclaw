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

  it("rejects unusable explanations and continuations at their respective byte limits", () => {
    for (const { field, max } of [
      { field: "explanation", max: 16_384 },
      { field: "continuation", max: 256 },
    ]) {
      for (const invalid of [undefined, " \n ", "🙂".repeat(max + 1)]) {
        const explanation = field === "explanation" ? invalid : "Review the action.";
        const message = field === "continuation" ? invalid : "Continue safely.";
        expect(readProviderRefusalReview({ explanation, continuation: { message } })).toEqual(
          field === "explanation" ? undefined : { explanation },
        );
      }
    }
  });
});
