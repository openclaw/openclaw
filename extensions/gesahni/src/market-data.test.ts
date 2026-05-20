import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketDataClient } from "./market-data.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...original,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

function mockJsonResponse(payload: unknown, status = 200) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn(async () => payload),
    },
    release,
  });
  return release;
}

describe("gesahni market data", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("fetches Alpaca quotes through the SSRF guard", async () => {
    const release = mockJsonResponse({
      quotes: {
        AAPL: {
          bp: 209.9,
          ap: 210.1,
          t: "2026-05-06T14:30:00Z",
        },
      },
    });
    const client = createMarketDataClient({
      marketData: {
        alpaca: {
          keyId: "key-id",
          secretKey: "secret-key",
          stockFeed: "iex",
        },
      },
    });

    await expect(client.quote("aapl")).resolves.toMatchObject({
      symbol: "AAPL",
      mark: 210,
      source: "Alpaca",
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      init: {
        headers: {
          "APCA-API-KEY-ID": "key-id",
          "APCA-API-SECRET-KEY": "secret-key",
        },
      },
      policy: { allowedHostnames: ["data.alpaca.markets"] },
      auditContext: "gesahni.market-data.alpaca",
    });
    expect(new URL(request.url).pathname).toBe("/v2/stocks/quotes/latest");
    expect(new URL(request.url).searchParams.get("symbols")).toBe("AAPL");
    expect(new URL(request.url).searchParams.get("feed")).toBe("iex");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fetches bridge quotes through the SSRF guard with the configured timeout", async () => {
    const release = mockJsonResponse({
      items: [
        {
          symbol: "MSFT",
          mark: 427.5,
          source: "Gesahni bridge",
          timestamp: "2026-05-06T14:30:00Z",
        },
      ],
    });
    const client = createMarketDataClient({
      bridge: {
        baseUrl: "https://gesahni.example",
        readBridgeToken: "read-token",
        userId: "tg:123",
        defaultTimeoutMs: 1234,
      },
    });

    await expect(client.quote("msft")).resolves.toMatchObject({
      symbol: "MSFT",
      mark: 427.5,
      source: "Gesahni bridge",
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      init: {
        headers: {
          Authorization: "Bearer read-token",
          "X-User-Id": "tg:123",
        },
      },
      policy: { allowedHostnames: ["gesahni.example"] },
      timeoutMs: 1234,
      auditContext: "gesahni.market-data.bridge",
    });
    expect(new URL(request.url).pathname).toBe("/v1/bridge/options/quotes_batch");
    expect(new URL(request.url).searchParams.get("symbols")).toBe("MSFT");
    expect(release).toHaveBeenCalledOnce();
  });
});
