import { describe, expect, it } from "vitest";
import { appendSessionToolTruncationWarning } from "./render-utils.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("appendSessionToolTruncationWarning", () => {
  it("leaves output unchanged when no truncation metadata is present", () => {
    expect(appendSessionToolTruncationWarning("output", theme, {})).toBe("output");
  });

  it("combines limit, byte, and additional warnings in order", () => {
    expect(
      appendSessionToolTruncationWarning("output", theme, {
        limit: { count: 5, noun: "matches" },
        truncation: { truncated: true, maxBytes: 1024 },
        additionalWarnings: ["some lines truncated"],
      }),
    ).toBe(
      "output\n<warning>[Truncated: 5 matches limit, 1.0KB limit, some lines truncated]</warning>",
    );
  });
});
