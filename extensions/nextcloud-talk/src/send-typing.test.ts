import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(() => ({
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value", // pragma: allowlist secret
    config: {},
  })),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "test-random",
    signature: "test-signature",
  })),
  stripNextcloudTalkTargetPrefix: vi.fn((token: string) =>
    token.startsWith("room:") ? token.slice(5) : token,
  ),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: async () => {},
  })),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => ({})),
}));

vi.mock("./send.runtime.js", () => ({
  getNextcloudTalkRuntime: () => ({
    config: { loadConfig: hoisted.loadConfig },
  }),
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
  generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
}));

vi.mock("./normalize.js", () => ({
  stripNextcloudTalkTargetPrefix: hoisted.stripNextcloudTalkTargetPrefix,
}));

import { resolveTypingIndicatorEnabled, sendTypingNextcloudTalk } from "./send-typing.js";

describe("sendTypingNextcloudTalk", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends typing=true and returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendTypingNextcloudTalk("abc123", true);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/typing",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ typing: true });
    expect((init?.headers as Record<string, string>)["X-Nextcloud-Talk-Bot-Random"]).toBe(
      "test-random",
    );
    expect((init?.headers as Record<string, string>)["X-Nextcloud-Talk-Bot-Signature"]).toBe(
      "test-signature",
    );
  });

  it("sends typing=false and returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendTypingNextcloudTalk("room:abc123", false);

    expect(result).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/typing",
    );
    expect(JSON.parse(init?.body as string)).toEqual({ typing: false });
  });

  it("strips room: prefix from room token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await sendTypingNextcloudTalk("room:my-token", true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/bot/my-token/typing");
  });

  it("returns false and warns on 404 (endpoint not supported)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const result = await sendTypingNextcloudTalk("abc123", true);

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not supported by server (404)"));
    warnSpy.mockRestore();
  });

  it("returns false and warns on other non-ok response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));

    const result = await sendTypingNextcloudTalk("abc123", true);

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Typing indicator failed (403)"));
    warnSpy.mockRestore();
  });

  it("returns false and warns on network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const result = await sendTypingNextcloudTalk("abc123", true);

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Typing indicator request failed"),
    );
    warnSpy.mockRestore();
  });

  it("uses provided baseUrl and secret opts", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendTypingNextcloudTalk("abc123", true, {
      baseUrl: "https://custom.example.com",
      secret: "custom-secret", // pragma: allowlist secret
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://custom.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/typing");
  });

  it("returns false for empty room token", async () => {
    hoisted.stripNextcloudTalkTargetPrefix.mockReturnValueOnce("");
    const result = await sendTypingNextcloudTalk("", true);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when account resolution fails", async () => {
    hoisted.resolveNextcloudTalkAccount.mockImplementationOnce(() => {
      throw new Error("No account found");
    });

    const result = await sendTypingNextcloudTalk("abc123", true);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes OCS-APIRequest header", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await sendTypingNextcloudTalk("abc123", true);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["OCS-APIRequest"]).toBe("true");
  });

  it("passes SSRF policy derived from account config", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await sendTypingNextcloudTalk("abc123", true);
    expect(hoisted.ssrfPolicyFromPrivateNetworkOptIn).toHaveBeenCalledWith({});
    expect(hoisted.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ auditContext: "nextcloud-talk-typing" }),
    );
  });
});

describe("resolveTypingIndicatorEnabled", () => {
  it("returns false by default when both are undefined", () => {
    expect(resolveTypingIndicatorEnabled({})).toBe(false);
  });

  it("returns true when account-level is true", () => {
    expect(resolveTypingIndicatorEnabled({ accountTypingIndicator: true })).toBe(true);
  });

  it("returns false when account-level is false", () => {
    expect(resolveTypingIndicatorEnabled({ accountTypingIndicator: false })).toBe(false);
  });

  it("room-level true overrides account-level false", () => {
    expect(
      resolveTypingIndicatorEnabled({ accountTypingIndicator: false, roomTypingIndicator: true }),
    ).toBe(true);
  });

  it("room-level false overrides account-level true", () => {
    expect(
      resolveTypingIndicatorEnabled({ accountTypingIndicator: true, roomTypingIndicator: false }),
    ).toBe(false);
  });

  it("room-level true works with no account-level set", () => {
    expect(resolveTypingIndicatorEnabled({ roomTypingIndicator: true })).toBe(true);
  });
});
