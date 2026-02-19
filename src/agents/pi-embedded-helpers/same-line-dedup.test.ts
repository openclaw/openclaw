import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";

describe("same-line duplicate collapse", () => {
  it("removes duplicated sentences joined after tag stripping", () => {
    const input = "Running on Opus 4.6. What do you need?Running on Opus 4.6. What do you need?";
    expect(sanitizeUserFacingText(input)).toBe("Running on Opus 4.6. What do you need?");
  });

  it("keeps trailing different text after duplicate", () => {
    const input =
      "Atlas here, Dion. What do you need?Atlas here, Dion. What do you need?Fair point.";
    expect(sanitizeUserFacingText(input)).toBe("Atlas here, Dion. What do you need?Fair point.");
  });

  it("does not touch short repeated words like ok ok", () => {
    expect(sanitizeUserFacingText("ok ok")).toBe("ok ok");
    expect(sanitizeUserFacingText("no no no")).toBe("no no no");
  });

  it("still collapses paragraph-level duplicates", () => {
    expect(sanitizeUserFacingText("Hello!\n\nHello!")).toBe("Hello!");
  });

  it("does not affect normal text", () => {
    const normal = "This is a perfectly normal response. Nothing weird here.";
    expect(sanitizeUserFacingText(normal)).toBe(normal);
  });
});
