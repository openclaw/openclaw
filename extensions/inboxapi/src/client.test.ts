import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboxApiClientOptions } from "./client.js";
import { whoami, getEmailCount, sendEmail, sendReply } from "./client.js";

const opts: InboxApiClientOptions = {
  mcpEndpoint: "https://mcp.inboxapi.ai/mcp",
  accessToken: "test-token",
  fromName: "TestBot",
};

function mcpResponse(result: any) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, statusText: string) {
  return new Response(null, { status, statusText });
}

describe("whoami", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("calls whoami tool and parses result", async () => {
    const identity = {
      accountName: "test-bot",
      email: "test-bot@b24510.inboxapi.ai",
      domain: "b24510.inboxapi.ai",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        content: [{ type: "text", text: JSON.stringify(identity) }],
      }),
    );

    const result = await whoami(opts);
    expect(result).toEqual(identity);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://mcp.inboxapi.ai/mcp");
    expect((init as any).method).toBe("POST");
    expect((init as any).headers.Authorization).toBe("Bearer test-token");

    const body = JSON.parse((init as any).body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("whoami");
  });
});

describe("getEmailCount", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns count from result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        content: [{ type: "text", text: JSON.stringify({ count: 42 }) }],
      }),
    );
    const count = await getEmailCount(opts);
    expect(count).toBe(42);
  });

  it("passes since parameter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        content: [{ type: "text", text: "5" }],
      }),
    );
    const count = await getEmailCount(opts, "2026-03-09T00:00:00Z");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
    expect(body.params.arguments.since).toBe("2026-03-09T00:00:00Z");
    expect(count).toBe(5);
  });
});

describe("sendEmail", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends email with correct params", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        content: [{ type: "text", text: JSON.stringify({ success: true, messageId: "m1" }) }],
      }),
    );

    const result = await sendEmail(opts, {
      to: "user@example.com",
      subject: "Test",
      body: "Hello",
    });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("m1");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
    expect(body.params.name).toBe("send_email");
    expect(body.params.arguments.to).toBe("user@example.com");
    expect(body.params.arguments.subject).toBe("Test");
    expect(body.params.arguments.from_name).toBe("TestBot");
  });
});

describe("sendReply", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("replies with correct params", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        content: [{ type: "text", text: JSON.stringify({ success: true }) }],
      }),
    );

    const result = await sendReply(opts, {
      email_id: "e123",
      body: "Reply text",
    });
    expect(result.success).toBe(true);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
    expect(body.params.name).toBe("send_reply");
    expect(body.params.arguments.email_id).toBe("e123");
  });
});

describe("error handling", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("throws on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      errorResponse(500, "Internal Server Error"),
    );
    await expect(whoami(opts)).rejects.toThrow("InboxAPI MCP call failed: 500");
  });

  it("retries on 429", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(errorResponse(429, "Too Many Requests")).mockResolvedValueOnce(
      mcpResponse({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              accountName: "bot",
              email: "bot@test.ai",
              domain: "test.ai",
            }),
          },
        ],
      }),
    );

    const result = await whoami(opts);
    expect(result.accountName).toBe("bot");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws on MCP error result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mcpResponse({
        isError: true,
        content: [{ type: "text", text: "auth failed" }],
      }),
    );
    await expect(whoami(opts)).rejects.toThrow("InboxAPI error: auth failed");
  });
});
