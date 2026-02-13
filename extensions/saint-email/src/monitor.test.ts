import { describe, expect, it } from "vitest";
import { __testing } from "./monitor.js";

describe("saint-email inbound parsing", () => {
  it("extracts email address from RFC822 From header", () => {
    expect(__testing.extractEmailAddress("Alice <alice@example.com>")).toBe("alice@example.com");
    expect(__testing.extractEmailAddress("bob@example.com")).toBe("bob@example.com");
  });

  it("extracts text/plain body from gmail payload", () => {
    const data = Buffer.from("Hello team", "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const text = __testing.decodePartText({
      mimeType: "text/plain",
      body: { data },
    });

    expect(text).toBe("Hello team");
  });

  it("normalizes inbound gmail message", () => {
    const data = Buffer.from("Hello", "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const message = __testing.toInboundMessage({
      message: {
        id: "abc",
        threadId: "thread-1",
        internalDate: "1700000000000",
        payload: {
          headers: [
            { name: "From", value: "Client <client@example.com>" },
            { name: "To", value: "bot@example.com" },
            { name: "Subject", value: "Question" },
          ],
          mimeType: "text/plain",
          body: { data },
        },
        snippet: "Hello",
      },
      attachments: [],
    });

    expect(message?.fromEmail).toBe("client@example.com");
    expect(message?.subject).toBe("Question");
    expect(message?.text).toBe("Hello");
    expect(message?.attachments).toEqual([]);
  });

  it("collects attachment candidates recursively", () => {
    const candidates = __testing.collectAttachmentCandidates({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: "SGVsbG8" },
        },
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "att-1", size: 1200 },
        },
      ],
    });

    expect(candidates).toEqual([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1200,
        attachmentId: "att-1",
        inlineData: undefined,
      },
    ]);
  });
});
