import { describe, expect, it, vi } from "vitest";
import { DaemonClient, resolveDaemonBaseUrl } from "./daemon-client.js";

const mkResp = (init: { ok: boolean; status: number; body?: string }): Response =>
  ({
    ok: init.ok,
    status: init.status,
    text: () => Promise.resolve(init.body ?? ""),
  }) as unknown as Response;

describe("DaemonClient.whoami", () => {
  it("calls GET /sender/whoami with channel + handle + optional session/group keys", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        mkResp({ ok: true, status: 200, body: JSON.stringify({ role: "owner", is_owner: true }) }),
      ),
    );
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090", fetchImpl });
    const resp = await client.whoami({
      channel: "whatsapp",
      handle: "+15551234",
      sessionKey: "agent:main:main",
      groupKey: "g-1",
    });
    expect(resp.is_owner).toBe(true);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url.startsWith("http://127.0.0.1:8090/sender/whoami?")).toBe(true);
    expect(url).toContain("channel=whatsapp");
    expect(url).toContain("handle=%2B15551234"); // URL-encoded "+"
    expect(url).toContain("session_key=agent%3Amain%3Amain");
    expect(url).toContain("group_key=g-1");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
  });

  it("returns degraded stranger envelope when the daemon errors", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(mkResp({ ok: false, status: 502 })));
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090", fetchImpl });
    const resp = await client.whoami({ channel: "whatsapp", handle: "+1" });
    expect(resp).toEqual({ role: "stranger", is_owner: false });
  });

  it("returns degraded stranger envelope when fetch itself throws", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090", fetchImpl });
    const resp = await client.whoami({ channel: "whatsapp", handle: "+1" });
    expect(resp.role).toBe("stranger");
    expect(resp.is_owner).toBe(false);
  });

  it("strips trailing slashes in baseUrl so URL doesn't get double-//", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(mkResp({ ok: true, status: 200, body: "{}" })));
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090////", fetchImpl });
    await client.whoami({ channel: "x", handle: "y" });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8090\/sender\/whoami\?/u);
  });
});

describe("DaemonClient.verifyChannelToken", () => {
  it("posts JSON body and returns parsed result", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        mkResp({
          ok: true,
          status: 200,
          body: JSON.stringify({
            handle_id: "h-1",
            user_id: "u-1",
            channel: "telegram",
            handle_normalized: "12345",
            handle_display: "Alice",
            status: "verified",
          }),
        }),
      ),
    );
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090", fetchImpl });
    const resp = await client.verifyChannelToken({
      channel: "telegram",
      handle: "12345",
      handleDisplay: "Alice",
      token: "abcdefghijklmnop",
    });
    expect(resp.handle_id).toBe("h-1");
    expect(resp.status).toBe("verified");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      channel: "telegram",
      handle: "12345",
      handle_display: "Alice",
      token: "abcdefghijklmnop",
    });
  });

  it("throws on non-2xx so the caller can distinguish failure modes", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(mkResp({ ok: false, status: 401 })));
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8090", fetchImpl });
    await expect(
      client.verifyChannelToken({
        channel: "telegram",
        handle: "12345",
        token: "abcdefghijklmnop",
      }),
    ).rejects.toThrow(/401/u);
  });
});

describe("resolveDaemonBaseUrl", () => {
  it("prefers an explicit override", () => {
    const orig = process.env.DAEMON_PORT;
    process.env.DAEMON_PORT = "9999";
    try {
      expect(resolveDaemonBaseUrl("http://override:1")).toBe("http://override:1");
    } finally {
      if (orig === undefined) {
        delete process.env.DAEMON_PORT;
      } else {
        process.env.DAEMON_PORT = orig;
      }
    }
  });

  it("falls back to DAEMON_PORT env when no override", () => {
    const orig = process.env.DAEMON_PORT;
    process.env.DAEMON_PORT = "8090";
    try {
      expect(resolveDaemonBaseUrl(undefined)).toBe("http://127.0.0.1:8090");
    } finally {
      if (orig === undefined) {
        delete process.env.DAEMON_PORT;
      } else {
        process.env.DAEMON_PORT = orig;
      }
    }
  });

  it("returns null when neither override nor env is set", () => {
    const orig = process.env.DAEMON_PORT;
    delete process.env.DAEMON_PORT;
    try {
      expect(resolveDaemonBaseUrl(undefined)).toBeNull();
      expect(resolveDaemonBaseUrl("   ")).toBeNull();
    } finally {
      if (orig !== undefined) {
        process.env.DAEMON_PORT = orig;
      }
    }
  });
});
