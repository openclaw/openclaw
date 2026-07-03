import { describe, expect, it } from "vitest";
import { formatVoiceLogPreview } from "./log-preview.js";

describe("formatVoiceLogPreview", () => {
  it("collapses whitespace and trims the preview", () => {
    expect(formatVoiceLogPreview("  hello \n world\t")).toBe("hello world");
  });

  it("truncates long previews after 500 characters", () => {
    const preview = formatVoiceLogPreview("x".repeat(501));
    expect(preview).toBe(`${"x".repeat(500)}...`);
  });
});
