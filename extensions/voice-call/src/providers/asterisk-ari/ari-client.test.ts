import { afterEach, describe, expect, it, vi } from "vitest";
import { AriClient } from "./ari-client.js";

const cfg = {
  baseUrl: "http://127.0.0.1:8088",
  username: "user",
  password: "pass",
  app: "openclaw",
  rtpHost: "127.0.0.1",
  rtpPort: 12000,
  codec: "ulaw",
} as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe("AriClient", () => {
  it("creates ExternalMedia with expected query params", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(JSON.stringify({ id: "chan" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const client = new AriClient(cfg);
    await client.createExternalMedia({
      app: "openclaw",
      externalHost: "127.0.0.1:12000",
      format: "ulaw",
      direction: "both",
      encapsulation: "rtp",
      transport: "udp",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(calledUrl.pathname).toBe("/ari/channels/externalMedia");
    expect(calledUrl.searchParams.get("app")).toBe("openclaw");
    expect(calledUrl.searchParams.get("external_host")).toBe("127.0.0.1:12000");
    expect(calledUrl.searchParams.get("format")).toBe("ulaw");
    expect(calledUrl.searchParams.get("direction")).toBe("both");
    expect(calledUrl.searchParams.get("encapsulation")).toBe("rtp");
    expect(calledUrl.searchParams.get("transport")).toBe("udp");
  });

  it("safeHangupChannel falls back to DELETE when hangup fails", async () => {
    const responses = [
      new Response("fail", { status: 500, statusText: "err" }),
      new Response("", { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const client = new AriClient(cfg);
    await client.safeHangupChannel("chan-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(firstUrl.pathname).toBe("/ari/channels/chan-1/hangup");
    expect(secondUrl.pathname).toBe("/ari/channels/chan-1");
  });

  it("safeHangupChannel treats 404 on hangup as benign and does not fall back", async () => {
    const responses = [new Response("not found", { status: 404, statusText: "Not Found" })];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = new AriClient(cfg);
    await client.safeHangupChannel("chan-404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstUrl.pathname).toBe("/ari/channels/chan-404/hangup");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
