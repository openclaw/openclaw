import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressErrorCode,
} from "openclaw/plugin-sdk/gateway-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, deferred, fixture, HTTP, ORIGINS, WS } from "./ui-tunnel.test-helpers.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
  const f = fixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.stop()));
});

async function opened(f: ReturnType<typeof fixture>) {
  await f.receive(WS);
  expect(await f.frames.next()).toEqual({ type: "ui.ws.opened", sid: WS.sid });
  return f.sockets[0]!;
}

async function response(f: ReturnType<typeof fixture>) {
  const head = await f.frames.next();
  const chunks: Buffer[] = [];
  for (;;) {
    const frame = await f.frames.next();
    expect(frame.type).toBe("ui.http.body");
    chunks.push(Buffer.from(String(frame.b64), "base64"));
    if (frame.more === false) {
      return { head, body: Buffer.concat(chunks) };
    }
  }
}

describe("Control UI relay tunnel", () => {
  it("streams HTTP chunks in both directions with unchanged paths, safe headers and read cookies", async () => {
    const f = setup();
    const upload = Buffer.alloc(512 * 1024, 3);
    const download = Buffer.alloc(512 * 1024 + 9, 7);
    vi.mocked(f.handle.request).mockImplementation(async (input) => {
      expect(input.pathAndQuery).toBe("/control/?x=1");
      expect(input.headers).toEqual([
        ["accept", "text/html"],
        ["accept-encoding", "br, gzip"],
        ["cookie", "asset=ok"],
      ]);
      expect(Buffer.from(await new Response(input.body).arrayBuffer())).toEqual(
        Buffer.concat([upload, Buffer.from("end")]),
      );
      return {
        response: new Response(download, {
          headers: {
            "content-type": "text/html",
            "cache-control": "public, max-age=31536000, immutable",
            "content-security-policy": "frame-ancestors https://chatgpt.com",
            "set-cookie": "evil=x",
            "content-length": "99",
            "content-encoding": "gzip",
            "service-worker-allowed": "/",
            "clear-site-data": '"cookies"',
            connection: "x-hop",
            "x-hop": "drop",
          },
        }),
        pluginReadCookies: [
          { name: "asset", value: "signed", path: "/", maxAgeSeconds: 300, kind: "native-assets" },
        ],
      };
    });
    await f.receive({
      ...HTTP,
      method: "POST",
      b64: upload.toString("base64"),
      more: true,
      headers: [
        ["Accept", "text/html"],
        ["Accept-Encoding", "br, gzip"],
        ["Cookie", "__Host-oc_ui=secret; asset=ok"],
        ["Connection", "x-hop"],
        ["x-hop", "drop"],
        ...[
          "Host",
          "Upgrade",
          "Keep-Alive",
          "TE",
          "Trailer",
          "Transfer-Encoding",
          "Proxy-Authorization",
          "Content-Length",
          "Forwarded",
          "X-Forwarded-For",
          "X-Real-IP",
          "True-Client-IP",
          "Cdn-Loop",
          "CF-Connecting-IP",
          "X-Relay-Secret",
        ].map((name) => [name, "drop"]),
      ],
    });
    await f.receive({
      type: "ui.http.body",
      sid: HTTP.sid,
      b64: Buffer.from("end").toString("base64"),
      more: false,
    });
    const result = await response(f);
    expect(result.body).toEqual(download);
    expect(result.head).toEqual({
      type: "ui.http.head",
      sid: HTTP.sid,
      status: 200,
      headers: [
        ["cache-control", "public, max-age=31536000, immutable"],
        ["content-encoding", "gzip"],
        ["content-security-policy", "frame-ancestors https://chatgpt.com"],
        ["content-type", "text/html"],
        ["referrer-policy", "no-referrer"],
        ["origin-agent-cluster", "?1"],
      ],
      cookies: [{ name: "asset", value: "signed", path: "/", maxAgeSeconds: 300 }],
    });
    const bodies = f.frames.values.filter((frame) => frame.type === "ui.http.body");
    expect(bodies.map((frame) => Buffer.from(String(frame.b64), "base64").length)).toEqual([
      512 * 1024,
      9,
      0,
    ]);
    expect(bodies.map((frame) => frame.more)).toEqual([true, true, false]);
    expect(f.factory.open).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceId: "gr_one",
        ...ORIGINS,
        frameAncestors: ["https://chatgpt.com"],
        operatorScopeCeiling: ["operator.read", "operator.write"],
      }),
    );
  });

  it.each<[GatewayControlUiIngressErrorCode, string]>([
    ["unsupported-auth", "unavailable"],
    ["unavailable", "unavailable"],
    ["closed", "unavailable"],
    ["invalid-options", "invalid"],
    ["forbidden", "forbidden"],
    ["limit-exceeded", "limit_exceeded"],
  ])("maps core %s to a terminal ui.error", async (code, expected) => {
    const f = setup();
    vi.mocked(f.factory.open).mockRejectedValue(
      new GatewayControlUiIngressError(code, "Configure token or password authentication."),
    );
    await f.receive(HTTP);
    expect(await f.frames.next()).toEqual({
      type: "ui.error",
      sid: HTTP.sid,
      code: expected,
      message: "Configure token or password authentication.",
    });
    if (code === "unsupported-auth") {
      expect(f.onUnsupportedAuth).toHaveBeenCalledWith(
        "Configure token or password authentication.",
      );
      vi.mocked(f.factory.open).mockResolvedValue(f.handle);
      await f.receive({ ...HTTP, sid: "http0002" });
      expect((await response(f)).head.status).toBe(200);
      expect(f.factory.open).toHaveBeenCalledTimes(2);
    }
  });

  it("bridges fragmented text and binary messages, drains final core messages, and publishes close", async () => {
    const f = setup();
    const socket = await opened(f);
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, text: "hello ", more: true });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, text: "world", more: false });
    expect(await socket.sent.next()).toEqual({ kind: "text", text: "hello world" });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "AQI=", more: true });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "Aw==", more: false });
    expect(await socket.sent.next()).toEqual({ kind: "binary", bytes: Buffer.from([1, 2, 3]) });
    socket.incoming.push({ kind: "binary", bytes: Buffer.alloc(512 * 1024 + 1, 5) });
    const first = await f.frames.next();
    const last = await f.frames.next();
    expect([first.more, last.more]).toEqual([true, false]);
    expect(Buffer.from(String(first.b64), "base64").length).toBe(512 * 1024);
    expect(Buffer.from(String(last.b64), "base64")).toEqual(Buffer.from([5]));
    socket.incoming.push({ kind: "text", text: "final" });
    socket.close(1000, "done");
    expect(await f.frames.next()).toEqual({
      type: "ui.ws.msg",
      sid: WS.sid,
      text: "final",
      more: false,
    });
    expect(await f.frames.next()).toEqual({
      type: "ui.ws.close",
      sid: WS.sid,
      code: 1000,
      reason: "done",
    });
  });

  it("splits escaped Unicode text into bounded JSON frames without breaking surrogate pairs", async () => {
    const f = setup();
    const socket = await opened(f);
    const text = "\0😀".repeat(160_000);
    socket.incoming.push({ kind: "text", text });
    let received = "";
    for (;;) {
      const frame = await f.frames.next();
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1024 * 1024);
      if (typeof frame.text !== "string") {
        throw new Error("Expected a WebSocket text chunk");
      }
      expect(Buffer.byteLength(frame.text)).toBeLessThanOrEqual(512 * 1024);
      expect(/[\uD800-\uDFFF]/u.test(frame.text)).toBe(false);
      received += frame.text;
      if (!frame.more) {
        break;
      }
    }
    expect(received).toBe(text);
  });

  it("rejects sandbox socket opens without rewriting browser origins", async () => {
    const f = setup();
    await f.receive({ ...WS, origin: ORIGINS.sandboxOrigin });
    expect((await f.frames.next()).code).toBe("forbidden");
    expect(f.handle.openWebSocket).not.toHaveBeenCalled();
  });

  it("cancels an HTTP read and passes a relay socket close to core", async () => {
    const f = setup();
    const request = deferred<AbortSignal>();
    vi.mocked(f.handle.request).mockImplementation(async (input) => {
      request.resolve(input.signal);
      return abortable(input.signal);
    });
    await f.receive(HTTP);
    const signal = await request.promise;
    await f.receive({ type: "ui.cancel", sid: HTTP.sid });
    expect(signal.aborted).toBe(true);
    const socket = await opened(f);
    await f.receive({ type: "ui.ws.close", sid: WS.sid, code: 1000, reason: "browser left" });
    expect(socket.closes[0]).toEqual({ code: 1000, reason: "browser left" });
  });

  it("discards queued work when relay cancellations arrive before dispatch", async () => {
    const f = setup();
    for (let i = 0; i < 128; i++) {
      const sid = `cancel_${String(i).padStart(3, "0")}`;
      f.tunnel.receive({ ...HTTP, sid });
      f.tunnel.receive({ type: "ui.cancel", sid });
    }
    await f.clock.advanceBy(0);
    expect(f.handle.request).not.toHaveBeenCalled();
    expect(f.frames.values).toEqual([]);
    expect(f.clock.armedAtMs).toBeNull();
    await f.receive(HTTP);
    expect((await response(f)).head.status).toBe(200);
  });

  it("settles cancelled admission jobs while the shared factory open remains pending", async () => {
    const f = setup();
    const admission = deferred<typeof f.handle>();
    vi.mocked(f.factory.open).mockReturnValue(admission.promise);
    try {
      for (let i = 0; i < 128; i++) {
        const sid = `pending_${String(i).padStart(3, "0")}`;
        const http = i % 2 === 0;
        f.tunnel.receive(
          http ? { ...HTTP, sid, headers: [["accept", "text/html"]] } : { ...WS, sid },
        );
        const dispatch = f.clock.advanceBy(0);
        f.tunnel.receive(
          http
            ? { type: "ui.cancel", sid }
            : { type: "ui.ws.close", sid, code: 1000, reason: "cancelled" },
        );
        await dispatch;
      }
      expect(f.factory.open).toHaveBeenCalledTimes(1);
      expect(f.handle.request).not.toHaveBeenCalled();
      expect(f.handle.openWebSocket).not.toHaveBeenCalled();
      expect(f.clock.armedAtMs).toBeNull();
      expect(f.tunnel.bufferedBytes).toBe(0);
      expect(f.frames.values).toEqual([]);
      await f.receive(HTTP);
      admission.resolve(f.handle);
      expect((await response(f)).head.status).toBe(200);
    } finally {
      admission.resolve(f.handle);
    }
  });

  it("revokes the live handle, aborts HTTP, closes sockets, and fences retained assertions", async () => {
    const f = setup();
    const socket = await opened(f);
    const request = deferred<AbortSignal>();
    vi.mocked(f.handle.request).mockImplementation(async (input) => {
      request.resolve(input.signal);
      return abortable(input.signal);
    });
    await f.receive(HTTP);
    const signal = await request.promise;
    const options = vi.mocked(f.factory.open).mock.calls[0]![0];
    f.active.delete("gr_one");
    expect(() => options.assertCurrent()).toThrow("Grant revoked");
    f.tunnel.revoke("gr_one");
    expect(signal.aborted).toBe(true);
    expect(socket.closes[0]?.code).toBe(1008);
    expect((await f.frames.next()).code).toBe("grant_revoked");
    expect((await f.frames.next()).code).toBe("grant_revoked");
    await f.stop();
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });

  it("closes every stream and handle on relay disconnect, including a late handle open", async () => {
    const f = setup();
    const admission = deferred<typeof f.handle>();
    vi.mocked(f.factory.open).mockReturnValue(admission.promise);
    await f.receive(HTTP);
    const stopping = f.tunnel.close();
    admission.resolve(f.handle);
    await stopping;
    expect(f.handle.close).toHaveBeenCalledTimes(1);
    expect(f.handle.request).not.toHaveBeenCalled();
    expect(f.frames.values).toEqual([]);
  });

  it("retires old origins and opens a new handle for the next real frame", async () => {
    const f = setup();
    const socket = await opened(f);
    await f.receive({
      ...HTTP,
      publicOrigin: "https://new.ui.example",
      sandboxOrigin: "https://new-sb.ui.example",
    });
    expect((await f.frames.next()).code).toBe("unavailable");
    await response(f);
    expect(socket.closes[0]?.code).toBe(1011);
    expect(f.factory.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.factory.open).mock.calls[1]![0].publicOrigin).toBe("https://new.ui.example");
  });

  it("rejects missing grants, duplicate IDs, invalid origins and oversized chunks", async () => {
    const f = setup();
    for (const [extra, code] of [
      [{ grantId: "gr_missing" }, "grant_revoked"],
      [{ sandboxOrigin: ORIGINS.publicOrigin }, "invalid"],
      [{ publicOrigin: "https://grant.ui.example/path" }, "invalid"],
      [{ b64: Buffer.alloc(512 * 1024 + 1).toString("base64") }, "invalid"],
    ] as const) {
      await f.receive({ ...HTTP, ...extra });
      expect((await f.frames.next()).code).toBe(code);
    }
    vi.mocked(f.handle.request).mockImplementation(async (input) => abortable(input.signal));
    await f.receive(HTTP);
    await f.receive(HTTP);
    expect((await f.frames.next()).code).toBe("invalid");
  });

  it("enforces per-connection HTTP and pending socket counts", async () => {
    const f = setup();
    vi.mocked(f.handle.request).mockImplementation(async (input) => abortable(input.signal));
    vi.mocked(f.handle.openWebSocket).mockImplementation(async (input) => abortable(input.signal));
    for (let i = 0; i < 65; i++) {
      await f.receive({ ...HTTP, sid: `http_${String(i).padStart(3, "0")}` });
    }
    expect(await f.frames.next()).toMatchObject({
      type: "ui.error",
      code: "limit_exceeded",
      sid: "http_064",
    });
    for (let i = 0; i < 9; i++) {
      await f.receive({ ...WS, sid: `socket_${i}` });
    }
    expect(await f.frames.next()).toMatchObject({
      type: "ui.error",
      code: "limit_exceeded",
      sid: "socket_8",
    });
  });

  it("bounds HTTP uploads even when the Gateway consumes chunks promptly", async () => {
    const f = setup();
    vi.mocked(f.handle.request).mockImplementation(async (input) => {
      await new Response(input.body).arrayBuffer();
      return { response: new Response(), pluginReadCookies: [] };
    });
    const b64 = Buffer.alloc(512 * 1024).toString("base64");
    await f.receive({ ...HTTP, method: "POST", b64, more: true });
    for (let i = 1; i < 33; i++) {
      await f.receive({ type: "ui.http.body", sid: HTTP.sid, b64, more: true });
    }
    expect((await f.frames.next()).code).toBe("limit_exceeded");
  });

  it("expires incomplete messages and enforces head and socket-open deadlines", async () => {
    const f = setup();
    const socket = await opened(f);
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, text: "partial", more: true });
    await f.clock.advanceBy(60_000);
    expect((await f.frames.next()).code).toBe("unavailable");
    expect(socket.closes[0]?.code).toBe(1011);
    vi.mocked(f.handle.request).mockImplementation(async (input) => abortable(input.signal));
    await f.receive(HTTP);
    await f.clock.advanceBy(60_000);
    expect((await f.frames.next()).message).toContain("60 seconds");
    vi.mocked(f.handle.openWebSocket).mockImplementation(async (input) => abortable(input.signal));
    await f.receive({ ...WS, sid: "socket02" });
    await f.clock.advanceBy(10_000);
    expect((await f.frames.next()).message).toContain("10 seconds");
  });

  it("closes the relay if native socket backpressure leaves no room for a terminal error", async () => {
    const f = setup();
    f.setBuffered(32 * 1024 * 1024);
    await f.receive(HTTP);
    await f.relayClosed;
    await f.stop();
    expect(f.closeRelay).toHaveBeenCalledOnce();
    expect(f.frames.values).toEqual([]);
  });

  it("rejects unsafe core cookies before publishing the response head", async () => {
    const f = setup();
    vi.mocked(f.handle.request).mockResolvedValue({
      response: new Response("private"),
      pluginReadCookies: [
        {
          name: "__Host-oc_ui",
          value: "replace",
          path: "/",
          maxAgeSeconds: 300,
          kind: "iframe-read",
        },
      ],
    });
    await f.receive(HTTP);
    expect(await f.frames.next()).toMatchObject({ type: "ui.error", code: "invalid" });
  });
});
