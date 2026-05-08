import { describe, expect, it } from "vitest";
import {
  buildGmailApiUrl,
  buildGmailDraftCreateRequest,
  buildGmailDraftMime,
  buildGmailSearchQuery,
  encodeBase64UrlUtf8,
} from "./gmail-api.js";

describe("buildGmailSearchQuery", () => {
  it("combines inbox, unread, sender, subject, labels, and free-text terms", () => {
    expect(
      buildGmailSearchQuery({
        inInbox: true,
        unread: true,
        from: "boss@example.com",
        subject: "quarterly review",
        labels: ["IMPORTANT"],
        hasWords: ["follow up", "budget"],
        query: "newer_than:7d",
      }),
    ).toBe(
      'in:inbox is:unread label:IMPORTANT from:boss@example.com subject:(quarterly review) "follow up" "budget" newer_than:7d',
    );
  });
});

describe("buildGmailDraftMime", () => {
  it("builds a plain-text MIME message", () => {
    const mime = buildGmailDraftMime({
      to: ["alex@example.com"],
      cc: "team@example.com",
      subject: "Hello",
      textBody: "Thanks for the update.",
      inReplyTo: "<msg-1@example.com>",
    });

    expect(mime).toContain("To: alex@example.com");
    expect(mime).toContain("Cc: team@example.com");
    expect(mime).toContain("Subject: Hello");
    expect(mime).toContain("In-Reply-To: <msg-1@example.com>");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("Thanks for the update.");
  });

  it("builds a multipart alternative MIME message when html is present", () => {
    const mime = buildGmailDraftMime({
      to: "alex@example.com",
      subject: "Hello",
      textBody: "Plain version",
      htmlBody: "<p>HTML version</p>",
    });

    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain("Plain version");
    expect(mime).toContain("<p>HTML version</p>");
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      buildGmailDraftMime({
        to: [],
        subject: "Hello",
        textBody: "hi",
      }),
    ).toThrow(/recipient/);

    expect(() =>
      buildGmailDraftMime({
        to: "a@example.com",
        subject: "",
        textBody: "hi",
      }),
    ).toThrow(/subject/);

    expect(() =>
      buildGmailDraftMime({
        to: "a@example.com",
        subject: "Hello",
      }),
    ).toThrow(/textBody or htmlBody/);
  });
});

describe("buildGmailDraftCreateRequest", () => {
  it("encodes the MIME payload as base64url and preserves thread id", () => {
    const request = buildGmailDraftCreateRequest({
      to: "alex@example.com",
      subject: "Draft",
      textBody: "Body",
      threadId: "thread-123",
    });

    expect(request.message.threadId).toBe("thread-123");
    expect(request.message.raw).not.toContain("+");
    expect(request.message.raw).not.toContain("/");
    expect(request.message.raw).not.toContain("=");
  });
});

describe("buildGmailApiUrl", () => {
  it("builds a Gmail API URL with query params", () => {
    expect(
      buildGmailApiUrl("/messages", {
        maxResults: 25,
        q: "in:inbox",
        includeSpamTrash: false,
      }),
    ).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=in%3Ainbox");
  });
});

describe("encodeBase64UrlUtf8", () => {
  it("produces base64url output", () => {
    expect(encodeBase64UrlUtf8("hello?")).toBe("aGVsbG8_");
  });
});
