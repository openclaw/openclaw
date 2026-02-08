import { describe, expect, it, vi } from "vitest";
import {
  parseJsonOrThrow,
  zulipAddReaction,
  zulipSetTypingStatus,
  zulipSendMessage,
} from "./client.js";

describe("parseJsonOrThrow", () => {
  it("throws a helpful error for HTML auth pages", async () => {
    const res = new Response("<!doctype html><html><body>CF Access</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    await expect(parseJsonOrThrow(res)).rejects.toThrow(/received HTML instead of JSON/i);
  });

  it("throws when payload.result != success", async () => {
    const res = new Response(JSON.stringify({ result: "error", msg: "bad" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(parseJsonOrThrow(res)).rejects.toThrow(/bad/);
  });
});

describe("client outbound payloads", () => {
  it("sends reactions as emoji_name=eyes", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body as string;
      const params = new URLSearchParams(body);
      expect(params.get("emoji_name")).toBe("eyes");
      return new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await zulipAddReaction(
      { baseUrl: "https://zulip.example.com", email: "bot@example.com", apiKey: "x" },
      { messageId: 123, emojiName: "eyes" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v1/messages/123/reactions");
  });

  it("sends typing payload with op start/stop and to [user_id]", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body as string;
      const params = new URLSearchParams(body);
      expect(params.get("type")).toBe("direct");
      expect(["start", "stop"]).toContain(params.get("op"));
      expect(params.get("to")).toBe(JSON.stringify([42]));
      return new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await zulipSetTypingStatus(
      { baseUrl: "https://zulip.example.com", email: "bot@example.com", apiKey: "x" },
      { op: "start", to: [42] },
    );

    await zulipSetTypingStatus(
      { baseUrl: "https://zulip.example.com", email: "bot@example.com", apiKey: "x" },
      { op: "stop", to: [42] },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v1/typing");
  });

  it("DM send supports numeric user_ids", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body as string;
      const params = new URLSearchParams(body);
      expect(params.get("type")).toBe("private");
      expect(params.get("to")).toBe(JSON.stringify([42]));
      return new Response(JSON.stringify({ result: "success", id: 999 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await zulipSendMessage(
      { baseUrl: "https://zulip.example.com", email: "bot@example.com", apiKey: "x" },
      { type: "private", to: [42], content: "hi" },
    );
    expect(res).toEqual({ id: 999 });
  });
});
