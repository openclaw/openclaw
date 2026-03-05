import { describe, it, expect } from "vitest";
import { scanOutboundMessage, type MessageScanResult } from "./message-guard.js";

describe("scanOutboundMessage", () => {
  it("flags bulk structured data (>500 chars of emails)", () => {
    const emails = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`).join(", ");
    const result = scanOutboundMessage(emails);
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain("bulk structured data");
  });

  it("does not flag normal short messages", () => {
    const result = scanOutboundMessage("Sure, I'll schedule the meeting for tomorrow at 3pm.");
    expect(result.flagged).toBe(false);
  });

  it("flags JSON array data dumps", () => {
    const jsonDump = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        name: `Person ${i}`,
        email: `p${i}@test.com`,
        phone: `+1-555-000-${String(i).padStart(4, "0")}`,
      })),
    );
    const result = scanOutboundMessage(jsonDump);
    expect(result.flagged).toBe(true);
  });

  it("does not flag a single email address mention", () => {
    const result = scanOutboundMessage("I sent the email to alice@example.com as requested.");
    expect(result.flagged).toBe(false);
  });
});
