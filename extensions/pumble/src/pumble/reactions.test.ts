import { afterEach, describe, expect, it, vi } from "vitest";
import { addPumbleReaction, removePumbleReaction } from "./reactions.js";

vi.mock("./accounts.js", () => ({
  resolvePumbleAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test-token",
    appIdSource: "config",
    config: {},
  })),
}));

function createMockFetch(responses: Array<{ ok: boolean; status: number; body?: unknown }>) {
  let callIndex = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.ok ? "OK" : "Error",
      json: async () => resp.body ?? {},
      text: async () => JSON.stringify(resp.body ?? {}),
    } as unknown as Response;
  });
}

describe("addPumbleReaction", () => {
  it("adds a reaction successfully", async () => {
    const mockFetch = createMockFetch([{ ok: true, status: 200, body: {} }]);

    const result = await addPumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-123",
      emojiName: "thumbsup",
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const reactionCall = mockFetch.mock.calls[0]!;
    expect(reactionCall[0]).toContain("/v1/messages/msg-123/reactions");
    expect(JSON.parse(reactionCall[1]?.body as string)).toEqual({ code: ":thumbsup:" });
  });

  it("strips colons from emoji name", async () => {
    const mockFetch = createMockFetch([{ ok: true, status: 200, body: {} }]);

    await addPumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-123",
      emojiName: ":wave:",
      fetchImpl: mockFetch,
    });

    const reactionCall = mockFetch.mock.calls[0]!;
    expect(JSON.parse(reactionCall[1]?.body as string)).toEqual({ code: ":wave:" });
  });

  it("returns error when bot token is missing", async () => {
    vi.mocked((await import("./accounts.js")).resolvePumbleAccount).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      botToken: undefined,
      appIdSource: "none",
      config: {},
    });

    const result = await addPumbleReaction({
      cfg: {},
      messageId: "msg-123",
      emojiName: "thumbsup",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("botToken missing");
    }
  });

  it("returns error when API call fails", async () => {
    const mockFetch = createMockFetch([{ ok: false, status: 403, body: { message: "forbidden" } }]);

    const result = await addPumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-123",
      emojiName: "thumbsup",
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("add reaction failed");
    }
  });

  it("bot user id is resolved via shared helper", async () => {
    const mockFetch = createMockFetch([
      { ok: true, status: 200, body: {} },
      { ok: true, status: 200, body: {} },
    ]);

    await addPumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-1",
      emojiName: "thumbsup",
      fetchImpl: mockFetch,
    });

    await addPumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-2",
      emojiName: "heart",
      fetchImpl: mockFetch,
    });

    // 2 calls total: just the reaction API calls (bot id from shared helper)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("removePumbleReaction", () => {
  it("removes a reaction successfully", async () => {
    const mockFetch = createMockFetch([{ ok: true, status: 200, body: {} }]);

    const result = await removePumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-123",
      emojiName: "thumbsup",
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({ ok: true });
    const reactionCall = mockFetch.mock.calls[0]!;
    expect(reactionCall[1]?.method).toBe("DELETE");
  });

  it("returns error on API failure", async () => {
    const mockFetch = createMockFetch([{ ok: false, status: 404, body: { message: "not found" } }]);

    const result = await removePumbleReaction({
      cfg: { channels: { pumble: { botToken: "xoxb-test" } } },
      messageId: "msg-123",
      emojiName: "thumbsup",
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("remove reaction failed");
    }
  });
});
