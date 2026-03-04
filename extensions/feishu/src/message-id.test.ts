import { describe, expect, it } from "vitest";
import { stripReactionSuffix } from "./message-id.js";

describe("stripReactionSuffix", () => {
  it("strips :reaction:<emoji>:<uuid> suffix", () => {
    const raw = "om_abc123";
    const suffixed = `${raw}:reaction:THUMBSUP:a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(stripReactionSuffix(suffixed)).toBe(raw);
  });

  it("returns the original ID when no suffix is present", () => {
    expect(stripReactionSuffix("om_abc123")).toBe("om_abc123");
  });

  it("handles emoji names with mixed case and underscores", () => {
    const raw = "om_xyz";
    const suffixed = `${raw}:reaction:Heart_Eyes:deadbeef-1234-5678-9abc-def012345678`;
    expect(stripReactionSuffix(suffixed)).toBe(raw);
  });

  it("does not strip partial or malformed suffixes", () => {
    // Missing UUID
    expect(stripReactionSuffix("om_abc:reaction:THUMBSUP")).toBe("om_abc:reaction:THUMBSUP");
    // Incomplete UUID
    expect(stripReactionSuffix("om_abc:reaction:THUMBSUP:not-a-uuid")).toBe(
      "om_abc:reaction:THUMBSUP:not-a-uuid",
    );
  });
});
