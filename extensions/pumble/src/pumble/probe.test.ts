import { describe, expect, it, vi } from "vitest";
import { probePumble } from "./probe.js";

describe("probePumble", () => {
  it("returns ok:false when token is empty", async () => {
    const result = await probePumble("", 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bot token missing");
  });

  it("returns ok:true on successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workspaceUserId: "BOT1", workspaceUserName: "TestBot" }),
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      const result = await probePumble("test-token", 5000);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.bot?.id).toBe("BOT1");
      // Verify correct Pumble auth header and endpoint
      const [url, init] = mockFetch.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toContain("/oauth2/me");
      expect(init.headers?.["token"]).toBe("test-token");
      expect(init.headers?.["Authorization"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns ok:false on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"message":"invalid token"}',
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      const result = await probePumble("bad-token", 5000);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns ok:false on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);
    try {
      const result = await probePumble("test-token", 5000);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network down");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
