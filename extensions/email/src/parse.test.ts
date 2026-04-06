import { describe, expect, it } from "vitest";
import { buildInboundText } from "./parse.js";

describe("buildInboundText", () => {
  it("formats a plain email correctly", () => {
    const result = buildInboundText({
      messageId: "<abc@example.com>",
      from: "alice@example.com",
      subject: "Hello",
      date: "2024-01-01T12:00:00.000Z",
      text: "Hi there!",
      attachments: [],
    });
    expect(result).toContain("Email received.");
    expect(result).toContain("From: alice@example.com");
    expect(result).toContain("Subject: Hello");
    expect(result).toContain("Message-ID: <abc@example.com>");
    expect(result).toContain("Hi there!");
  });

  it("lists attachments when present", () => {
    const result = buildInboundText({
      messageId: "<xyz@example.com>",
      from: "bob@example.com",
      subject: "Report",
      date: "2024-01-02T08:00:00.000Z",
      text: "Please see attached.",
      attachments: [
        { filename: "report.pdf", contentType: "application/pdf", sizeBytes: 12345 },
      ],
    });
    expect(result).toContain("Attachments:");
    expect(result).toContain("report.pdf");
    expect(result).toContain("application/pdf");
    expect(result).toContain("12345 bytes");
  });

  it("omits attachments section when none", () => {
    const result = buildInboundText({
      messageId: "",
      from: "carol@example.com",
      subject: "Quick note",
      date: "2024-01-03T10:00:00.000Z",
      text: "Just a note.",
      attachments: [],
    });
    expect(result).not.toContain("Attachments:");
  });
});
