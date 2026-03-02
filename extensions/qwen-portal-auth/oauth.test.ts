import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginQwenPortalOAuth } from "./oauth.js";

const mockFetch = vi.fn<typeof fetch>();

describe("loginQwenPortalOAuth", () => {
  const mockOpenUrl = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const mockNote = vi
    .fn<(message: string, title?: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const mockProgressUpdate = vi.fn<(message: string) => void>();
  const mockProgressStop = vi.fn<(message?: string) => void>();

  const mockProgress = {
    update: mockProgressUpdate,
    stop: mockProgressStop,
  };

  const baseParams = {
    openUrl: mockOpenUrl,
    note: mockNote,
    progress: mockProgress,
  };

  // A device authorization response that expires in 1 second (just enough for tests)
  function makeDeviceAuthResponse(
    overrides?: Partial<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>,
  ) {
    return {
      device_code: "test-device-code",
      user_code: "TEST-1234",
      verification_uri: "https://chat.qwen.ai/activate",
      verification_uri_complete: "https://chat.qwen.ai/activate?code=TEST-1234",
      expires_in: 10,
      interval: 1,
      ...overrides,
    };
  }

  function makeTokenResponse(
    overrides?: Partial<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      resource_url: string;
    }>,
  ) {
    return {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockOpenUrl.mockReset().mockResolvedValue(undefined);
    mockNote.mockReset().mockResolvedValue(undefined);
    mockProgressUpdate.mockReset();
    mockProgressStop.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns a token when device code flow succeeds immediately", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeDeviceAuthResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("test-access-token");
    expect(token.refresh).toBe("test-refresh-token");
    expect(token.expires).toBeGreaterThan(Date.now());
  });

  it("opens the verification URL after requesting device code", async () => {
    const deviceAuth = makeDeviceAuthResponse({
      verification_uri_complete: "https://chat.qwen.ai/activate?code=XYZ",
    });
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockOpenUrl).toHaveBeenCalledWith("https://chat.qwen.ai/activate?code=XYZ");
  });

  it("shows a note with the verification URI and user code", async () => {
    const deviceAuth = makeDeviceAuthResponse({
      user_code: "ABCD-5678",
      verification_uri: "https://chat.qwen.ai/activate",
    });
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockNote).toHaveBeenCalledWith(expect.stringContaining("ABCD-5678"), "Qwen OAuth");
  });

  it("retries polling when authorization is pending and succeeds on second attempt", async () => {
    const pendingPayload = { error: "authorization_pending" };
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 30, interval: 1 });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // First poll: pending
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pendingPayload), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      // Second poll: success
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("test-access-token");
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 device + 2 polls
  });

  it("increases poll interval when server responds with slow_down", async () => {
    const slowDownPayload = { error: "slow_down" };
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 60, interval: 1 });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(slowDownPayload), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("test-access-token");
  });

  it("throws when device code request fails with HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    // The function throws immediately (before any timers), so we don't need runAllTimersAsync.
    await expect(loginQwenPortalOAuth(baseParams)).rejects.toThrow(
      "Qwen device authorization failed",
    );
  });

  it("throws when token poll returns a non-pending error", async () => {
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 30, interval: 1 });
    const errorPayload = { error: "access_denied", error_description: "User denied access" };

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorPayload), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

    // Attach a no-op catch handler before advancing timers so the rejection is not "unhandled"
    // while runAllTimersAsync is running — the outer expect(...).rejects will handle it.
    const promise = loginQwenPortalOAuth(baseParams);
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;
    await expect(promise).rejects.toThrow("Qwen OAuth failed");
  });

  it("throws when token payload is missing required fields", async () => {
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 30, interval: 1 });
    const incompleteToken = { access_token: "abc" }; // missing refresh_token and expires_in

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(incompleteToken), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    // Same pattern: prevent "unhandled rejection" while timers run.
    const promise = loginQwenPortalOAuth(baseParams);
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;
    await expect(promise).rejects.toThrow("Qwen OAuth failed");
  });

  it("falls back to verification_uri when verification_uri_complete is absent", async () => {
    const deviceAuth = {
      device_code: "test-device-code",
      user_code: "XYZ-0000",
      verification_uri: "https://chat.qwen.ai/activate",
      expires_in: 30,
      interval: 1,
    };

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockOpenUrl).toHaveBeenCalledWith("https://chat.qwen.ai/activate");
  });

  it("includes resourceUrl in returned token when server provides it", async () => {
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 30, interval: 1 });
    const tokenWithResource = makeTokenResponse({ resource_url: "https://portal.qwen.ai/v1" });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(tokenWithResource), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.resourceUrl).toBe("https://portal.qwen.ai/v1");
  });

  it("continues polling without crashing when openUrl throws", async () => {
    mockOpenUrl.mockRejectedValueOnce(new Error("Browser not available"));
    const deviceAuth = makeDeviceAuthResponse({ expires_in: 30, interval: 1 });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deviceAuth), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const promise = loginQwenPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    // Should not throw even though openUrl failed
    const token = await promise;
    expect(token.access).toBe("test-access-token");
  });
});
