import type { LookupFn } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const mockFetch = vi.fn();

describe("UrbitSSEClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends subscriptions added after connect", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const lookupFn = (async () => [{ address: "1.1.1.1", family: 4 }]) as unknown as LookupFn;

    const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
      lookupFn,
    });
    (client as { isConnected: boolean }).isConnected = true;

    await client.subscribe({
      app: "chat",
      path: "/dm/~zod",
      event: () => {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(client.channelUrl);
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      action: "subscribe",
      app: "chat",
      path: "/dm/~zod",
    });
  });
});
