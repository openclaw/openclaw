import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginMiniMaxPortalOAuth, type MiniMaxRegion } from "./oauth.js";

const mockFetch = vi.fn<typeof fetch>();

describe("loginMiniMaxPortalOAuth", () => {
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

  // The MiniMax OAuth code uses `while (Date.now() < expireTimeMs)` where `expireTimeMs`
  // is the raw `expired_in` value from the server. To keep the while-loop alive long enough
  // for our poll mock to respond, we pass `expired_in` as a value far in the future
  // relative to `Date.now()` (in the same millisecond scale that Date.now() returns).
  const futureExpiry = () => Date.now() + 30_000;

  function makeTokenResponse(
    overrides?: Partial<{
      status: string;
      access_token: string;
      refresh_token: string;
      expired_in: number;
      resource_url: string;
      notification_message: string;
    }>,
  ) {
    return {
      status: "success",
      access_token: "mm-access-token",
      refresh_token: "mm-refresh-token",
      expired_in: 3600,
      ...overrides,
    };
  }

  /**
   * Sets up a successful two-step fetch mock:
   * 1. Code endpoint: captures the PKCE state, returns it in the response so validation passes.
   * 2. Token endpoint: returns a success payload.
   */
  function setupSuccessfulFlow(
    region: MiniMaxRegion = "global",
    tokenOverrides?: Parameters<typeof makeTokenResponse>[0],
  ) {
    const baseUrl = region === "cn" ? "https://api.minimaxi.com" : "https://api.minimax.io";

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/oauth/code")) {
        const body = init?.body as string | undefined;
        const match = body?.match(/(?:^|&)state=([^&]+)/);
        const state = match ? decodeURIComponent(match[1]) : "";

        return new Response(
          JSON.stringify({
            user_code: "MINIMAX-1234",
            verification_uri: `${baseUrl}/oauth/verify`,
            expired_in: futureExpiry(),
            interval: 1,
            state,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify(makeTokenResponse(tokenOverrides)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });
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

  it("returns a token when flow completes successfully (global region)", async () => {
    setupSuccessfulFlow("global");

    const promise = loginMiniMaxPortalOAuth({ ...baseParams, region: "global" });
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("mm-access-token");
    expect(token.refresh).toBe("mm-refresh-token");
  });

  it("returns a token when flow completes successfully (cn region)", async () => {
    setupSuccessfulFlow("cn");

    const promise = loginMiniMaxPortalOAuth({ ...baseParams, region: "cn" });
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("mm-access-token");
    expect(token.refresh).toBe("mm-refresh-token");
  });

  it("defaults to global region when none is specified", async () => {
    setupSuccessfulFlow("global");

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("mm-access-token");
    // Verify the code endpoint was called against the global base URL
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("minimax.io"),
      expect.anything(),
    );
  });

  it("uses CN base URL when region is cn", async () => {
    setupSuccessfulFlow("cn");

    const promise = loginMiniMaxPortalOAuth({ ...baseParams, region: "cn" });
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("minimaxi.com"),
      expect.anything(),
    );
  });

  it("opens verification URL after requesting device code", async () => {
    setupSuccessfulFlow("global");

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockOpenUrl).toHaveBeenCalledWith(expect.stringContaining("minimax.io"));
  });

  it("shows a note with verification URL and user code", async () => {
    setupSuccessfulFlow("global");

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockNote).toHaveBeenCalledWith(expect.stringContaining("MINIMAX-1234"), "MiniMax OAuth");
  });

  it("includes resourceUrl in returned token when server provides it", async () => {
    setupSuccessfulFlow("global", { resource_url: "https://api.minimax.io/anthropic" });

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.resourceUrl).toBe("https://api.minimax.io/anthropic");
  });

  it("includes notification_message in returned token when server provides it", async () => {
    setupSuccessfulFlow("global", { notification_message: "Welcome to MiniMax!" });

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.notification_message).toBe("Welcome to MiniMax!");
  });

  it("throws when the code endpoint returns an HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    // The function throws immediately (before any timers), so no runAllTimersAsync needed.
    await expect(loginMiniMaxPortalOAuth(baseParams)).rejects.toThrow(
      "MiniMax OAuth authorization failed",
    );
  });

  it("throws when the code response is missing user_code", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          verification_uri: "https://api.minimax.io/oauth/verify",
          expired_in: futureExpiry(),
          state: "some-state",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(loginMiniMaxPortalOAuth(baseParams)).rejects.toThrow("incomplete payload");
  });

  it("throws when state in code response does not match sent state (CSRF protection)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user_code: "MINIMAX-1234",
          verification_uri: "https://api.minimax.io/oauth/verify",
          expired_in: futureExpiry(),
          interval: 1,
          state: "tampered-state-value",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(loginMiniMaxPortalOAuth(baseParams)).rejects.toThrow("state mismatch");
  });

  it("throws when poll returns status=error", async () => {
    let capturedState: string | undefined;

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/oauth/code")) {
        const body = init?.body as string | undefined;
        const match = body?.match(/(?:^|&)state=([^&]+)/);
        capturedState = match ? decodeURIComponent(match[1]) : "";

        return new Response(
          JSON.stringify({
            user_code: "MINIMAX-ERR",
            verification_uri: "https://api.minimax.io/oauth/verify",
            expired_in: futureExpiry(),
            interval: 1,
            state: capturedState,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ status: "error" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });

    const promise = loginMiniMaxPortalOAuth(baseParams);
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;
    await expect(promise).rejects.toThrow("MiniMax OAuth failed");
  });

  it("retries polling when status is not success and eventually succeeds", async () => {
    let pollCount = 0;

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/oauth/code")) {
        const body = init?.body as string | undefined;
        const match = body?.match(/(?:^|&)state=([^&]+)/);
        const state = match ? decodeURIComponent(match[1]) : "";

        return new Response(
          JSON.stringify({
            user_code: "MINIMAX-POLL",
            verification_uri: "https://api.minimax.io/oauth/verify",
            expired_in: futureExpiry(),
            interval: 1,
            state,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/oauth/token")) {
        pollCount++;
        if (pollCount < 3) {
          // Return "pending"-style non-success status
          return new Response(
            JSON.stringify({ status: "pending", base_resp: { status_msg: "Not yet" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(makeTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    const token = await promise;

    expect(token.access).toBe("mm-access-token");
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("continues after openUrl throws (fallback to manual copy-paste)", async () => {
    mockOpenUrl.mockRejectedValueOnce(new Error("Cannot open browser"));
    setupSuccessfulFlow("global");

    const promise = loginMiniMaxPortalOAuth(baseParams);
    await vi.runAllTimersAsync();
    // Should not throw even though openUrl threw
    const token = await promise;

    expect(token.access).toBe("mm-access-token");
  });
});
