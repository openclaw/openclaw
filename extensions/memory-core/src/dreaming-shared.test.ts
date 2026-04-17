import { describe, expect, it } from "vitest";
import { isMetadataGarbageText, sanitizeDreamingMetadataText } from "./dreaming-shared.js";

describe("memory-core dreaming shared helpers", () => {
  it("preserves non-transcript bracket prefixes when no role follows", () => {
    expect(sanitizeDreamingMetadataText("[P1] rotate keys weekly")).toBe("[P1] rotate keys weekly");
    expect(sanitizeDreamingMetadataText("[Fri 2026-04-17 09:00] outage recap")).toBe(
      "[Fri 2026-04-17 09:00] outage recap",
    );
  });

  it("still strips transcript scaffolding when a chat role follows", () => {
    expect(
      sanitizeDreamingMetadataText(
        "[slack] [Fri 2026-04-17 09:00] User: Move backups to S3 Glacier. [[reply_to_current]]",
      ),
    ).toBe("User: Move backups to S3 Glacier.");
  });

  it("treats reordered JSON metadata payloads as transport garbage", () => {
    expect(isMetadataGarbageText('{"type":"message","message_id":"5417"}')).toBe(true);
    expect(isMetadataGarbageText("Webhook parser expects message_id: 5417 for retries.")).toBe(
      false,
    );
  });
});
