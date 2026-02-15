import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BridgeClient } from "./bridge-client.js";

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("BridgeClient", () => {
  it("strips trailing slash from URL", () => {
    const client = new BridgeClient({ url: "http://localhost:8585/" });
    // Verify by making a call and checking the URL
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    client.mcpCall("test_tool");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8585/mcp/call",
      expect.any(Object),
    );
  });

  describe("mcpCall", () => {
    it("sends POST with correct payload", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, result: { count: 5 } }));

      const result = await client.mcpCall("messages_list", { platform: "zoom", days: 7 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8585/mcp/call",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("messages_list");
      expect(body.arguments).toEqual({ platform: "zoom", days: 7 });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ count: 5 });
    });

    it("passes empty args by default", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.mcpCall("accounts_list");

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.arguments).toEqual({});
    });
  });

  describe("health", () => {
    it("returns ok: true for successful response", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok", task_running: false }));

      const result = await client.health();

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ status: "ok", task_running: false });
    });

    it("returns ok: false on fetch error", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await client.health();

      expect(result.ok).toBe(false);
      expect(result.error).toBe("ECONNREFUSED");
    });
  });

  describe("convenience wrappers", () => {
    it("ingestEmails calls correct tool", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.ingestEmails("xcellerate", 2, 10);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("ingest_emails");
      expect(body.arguments).toEqual({ account: "xcellerate", days: 2, max_emails: 10 });
    });

    it("messagesList calls correct tool", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.messagesList("zoom", 3, 25);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("messages_list");
      expect(body.arguments).toEqual({ platform: "zoom", days: 3, limit: 25 });
    });

    it("messagesSend calls correct tool with is_channel flag", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.messagesSend("ch-123", "Hello", "zoom", true);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("messages_send");
      expect(body.arguments.is_channel).toBe(true);
    });

    it("confirmSend calls correct tool", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.confirmSend("ps-abc123");

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("confirm_send");
      expect(body.arguments.pending_id).toBe("ps-abc123");
    });

    it("createReplyDraft calls correct tool", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.createReplyDraft("email-123", "Thank you", "vvg");

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("create_reply_draft");
      expect(body.arguments).toEqual({ email_id: "email-123", body: "Thank you", account: "vvg" });
    });

    it("readAttachment calls correct tool", async () => {
      const client = new BridgeClient({ url: "http://localhost:8585" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, result: { content: "data" } }));

      const result = await client.readAttachment("file-abc");

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.tool_name).toBe("read_attachment");
      expect(body.arguments.file_id).toBe("file-abc");
    });
  });
});
