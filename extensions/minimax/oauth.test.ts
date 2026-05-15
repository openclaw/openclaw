import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { refreshMiniMaxPortalOAuth } from "./oauth.js";

const ORIGINAL_FETCH = globalThis.fetch;

function makeJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("refreshMiniMaxPortalOAuth", () => {
  it("posts to account.minimax.io/oauth2/token for global region with refresh_token grant", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = (init?.body as string) ?? "";
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("client_id=78257093-7e40-4613-99e0-527b14b39113");
      expect(body).toContain("refresh_token=stale-rt");
      return makeJsonResponse({
        status: "success",
        access_token: "fresh-access",
        refresh_token: "rotated-rt",
        expired_in: 1_700_000_000_000,
        resource_url: "https://api.minimax.io/anthropic",
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const token = await refreshMiniMaxPortalOAuth({
      refreshToken: "stale-rt",
      region: "global",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://account.minimax.io/oauth2/token");
    expect(token.access).toBe("fresh-access");
    expect(token.refresh).toBe("rotated-rt");
    expect(token.expires).toBe(1_700_000_000_000);
    expect(token.resourceUrl).toBe("https://api.minimax.io/anthropic");
  });

  it("posts to account.minimaxi.com/oauth2/token for cn region", async () => {
    const fetchMock = vi.fn(async () =>
      makeJsonResponse({
        status: "success",
        access_token: "cn-access",
        refresh_token: "cn-rotated-rt",
        expired_in: 1_700_000_000_000,
        resource_url: "https://api.minimaxi.com/anthropic",
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const token = await refreshMiniMaxPortalOAuth({
      refreshToken: "stale-rt",
      region: "cn",
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://account.minimaxi.com/oauth2/token");
    expect(token.access).toBe("cn-access");
    expect(token.resourceUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("falls back to the previous refresh_token if the server omits a new one", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse({
        status: "success",
        access_token: "fresh-access",
        // refresh_token intentionally missing
        expired_in: 1_700_000_000_000,
      })) as typeof fetch;

    const token = await refreshMiniMaxPortalOAuth({
      refreshToken: "old-rt-stays",
      region: "global",
    });

    expect(token.refresh).toBe("old-rt-stays");
  });

  it("throws on non-2xx (caller should treat as re-login required)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1, status_msg: "invalid_grant" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await expect(
      refreshMiniMaxPortalOAuth({ refreshToken: "rotten-rt", region: "global" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("throws when status is not success even with HTTP 200", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse({
        status: "error",
        base_resp: { status_code: 5, status_msg: "refresh_token_reused" },
      })) as typeof fetch;

    await expect(
      refreshMiniMaxPortalOAuth({ refreshToken: "rt", region: "global" }),
    ).rejects.toThrow(/incomplete or unsuccessful/);
  });

  it("throws when payload omits access_token (incomplete response)", async () => {
    globalThis.fetch = (async () =>
      makeJsonResponse({
        status: "success",
        // access_token missing
        refresh_token: "rotated-rt",
        expired_in: 1_700_000_000_000,
      })) as typeof fetch;

    await expect(
      refreshMiniMaxPortalOAuth({ refreshToken: "rt", region: "global" }),
    ).rejects.toThrow(/incomplete or unsuccessful/);
  });
});
