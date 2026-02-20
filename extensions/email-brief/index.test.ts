import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { GmailMessage } from "./gmail-body.js";

// Shared mock client that all GmailClient instances will use
const sharedMockClient = {
  listMessages: vi.fn(),
  getMessages: vi.fn(),
};

// Mock the modules before importing the handler
vi.mock("./gmail-client.js", () => {
  return {
    GmailClient: class MockGmailClient {
      listMessages = sharedMockClient.listMessages;
      getMessages = sharedMockClient.getMessages;
    },
    resolveGmailConfig: vi.fn(),
  };
});

vi.mock("./summarize.js", () => ({
  summarizeEmails: vi.fn(),
  formatFallback: vi.fn((emails: Array<{ from: string; subject: string; date: string }>) =>
    emails.length === 0
      ? "No emails found."
      : emails.map((e, i) => `${i + 1}. [${e.from}] ${e.subject} (${e.date})`).join("\n"),
  ),
}));

vi.mock("../../src/auto-reply/chunk.js", () => ({
  chunkMarkdownText: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit) {
      chunks.push(text.slice(i, i + limit));
    }
    return chunks;
  }),
}));

import { resolveGmailConfig } from "./gmail-client.js";
import register from "./index.js";
import { summarizeEmails } from "./summarize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockClient = sharedMockClient;

function fakeApi(overrides: Record<string, unknown> = {}): any {
  let commandHandler: any = null;
  return {
    id: "email-brief",
    name: "email-brief",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerCommand(def: any) {
      commandHandler = def;
    },
    _getCommand() {
      return commandHandler;
    },
    ...overrides,
  };
}

function fakeCtx(args = "", overrides: Record<string, unknown> = {}): any {
  return {
    senderId: "user-1",
    channel: "telegram",
    isAuthorizedSender: true,
    args,
    commandBody: `/email_brief ${args}`,
    config: {},
    ...overrides,
  };
}

const sampleGmailMessages: GmailMessage[] = [
  {
    id: "msg1",
    snippet: "Meeting at 10am",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "Subject", value: "Meeting tomorrow" },
        { name: "Date", value: "Thu, 20 Feb 2026 09:00:00 +0000" },
      ],
      body: {
        size: 100,
        data: Buffer.from("Let's meet at 10am to discuss the project.").toString("base64url"),
      },
    },
  },
  {
    id: "msg2",
    snippet: "Quarterly results",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "bob@example.com" },
        { name: "Subject", value: "Q4 Results" },
        { name: "Date", value: "Wed, 19 Feb 2026 14:00:00 +0000" },
      ],
      body: {
        size: 80,
        data: Buffer.from("Q4 revenue is up 15% year over year.").toString("base64url"),
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email-brief command handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers command with requireAuth: true", () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();
    expect(cmd).not.toBeNull();
    expect(cmd.name).toBe("email_brief");
    expect(cmd.requireAuth).toBe(true);
    expect(cmd.acceptsArgs).toBe(true);
  });

  it("returns error when gmail config is missing", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockImplementation(() => {
      throw new Error("Gmail Service Account credentials not found.");
    });

    const result = await cmd.handler(fakeCtx());
    expect(result.text).toContain("Service Account credentials not found");
  });

  it("full happy path: fetch emails and summarize", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockResolvedValue(["msg1", "msg2"]);
    (mockClient.getMessages as any).mockResolvedValue(sampleGmailMessages);
    (summarizeEmails as any).mockResolvedValue(
      "**Meeting tomorrow** — Alice wants to meet at 10am\n**Q4 Results** — Revenue up 15%",
    );

    const result = await cmd.handler(fakeCtx("7d"));
    expect(result.text).toContain("Meeting tomorrow");
    expect(result.text).toContain("Q4 Results");
    expect(summarizeEmails).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ from: "alice@example.com", subject: "Meeting tomorrow" }),
        expect.objectContaining({ from: "bob@example.com", subject: "Q4 Results" }),
      ]),
      expect.objectContaining({ urgent: false }),
    );
  });

  it("returns empty inbox message with period-widening suggestion", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockResolvedValue([]);

    const result = await cmd.handler(fakeCtx());
    expect(result.text).toContain("No emails found");
    expect(result.text).toContain("Try widening the period");
    expect(mockClient.getMessages).not.toHaveBeenCalled();
  });

  it("handles Gmail API error gracefully", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockRejectedValue(
      new Error("Gmail API returned 403 Forbidden. Ensure domain-wide delegation is configured."),
    );

    const result = await cmd.handler(fakeCtx());
    expect(result.text).toContain("domain-wide delegation");
  });

  it("falls back to metadata list when LLM fails", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockResolvedValue(["msg1", "msg2"]);
    (mockClient.getMessages as any).mockResolvedValue(sampleGmailMessages);
    (summarizeEmails as any).mockRejectedValue(new Error("LLM timeout"));

    const result = await cmd.handler(fakeCtx());
    expect(result.text).toContain("alice@example.com");
    expect(result.text).toContain("Meeting tomorrow");
  });

  it("chunks long responses for Telegram", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockResolvedValue(["msg1"]);
    (mockClient.getMessages as any).mockResolvedValue([sampleGmailMessages[0]]);

    // Return a very long summary
    const longSummary = "A".repeat(5000);
    (summarizeEmails as any).mockResolvedValue(longSummary);

    const result = await cmd.handler(fakeCtx());
    expect(result.text).toContain("Part 1/");
    expect(result.text.length).toBeLessThan(5000);
  });

  it("sanitizes private key from error messages", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockImplementation(() => {
      throw new Error(
        "Failed to parse: -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      );
    });

    const result = await cmd.handler(fakeCtx());
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.text).toContain("[REDACTED]");
  });

  it("passes urgent flag from parsed args", async () => {
    const api = fakeApi();
    register(api);
    const cmd = api._getCommand();

    (resolveGmailConfig as any).mockReturnValue({
      serviceAccountKey: { client_email: "test@test.iam.gserviceaccount.com", private_key: "pk" },
      userEmail: "user@company.com",
      maxEmails: 20,
    });

    (mockClient.listMessages as any).mockResolvedValue(["msg1"]);
    (mockClient.getMessages as any).mockResolvedValue([sampleGmailMessages[0]]);
    (summarizeEmails as any).mockResolvedValue("Urgent summary");

    await cmd.handler(fakeCtx("urgent 3d"));
    expect(summarizeEmails).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ urgent: true }),
    );
  });
});
