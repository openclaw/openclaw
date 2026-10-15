import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressErrorCode,
} from "openclaw/plugin-sdk/gateway-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, createTunnelFixture, HTTP, ORIGINS, WS } from "./relay.test-helpers.js";

const fixtures: ReturnType<typeof createTunnelFixture>[] = [];
function setup() {
  const f = createTunnelFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.stop()));
});

async function opened(f: ReturnType<typeof createTunnelFixture>) {
  await f.receive(WS);
  expect(await f.frames.next()).toEqual({ type: "ui.ws.opened", sid: WS.sid });
  return f.sockets[0]!;
}

async function response(f: ReturnType<typeof createTunnelFixture>) {
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
  it("limits queued upload bytes before core admission finishes", async () => {
    const f = setup();
    const admission = Promise.withResolvers<typeof f.handle>();
    vi.mocked(f.open).mockReturnValue(admission.promise);
    const b64 = Buffer.alloc(512 * 1024).toString("base64");
    try {
      await f.receive({ ...HTTP, method: "POST", b64, more: true });
      for (let index = 1; index < 200; index++) {
        await f.receive({ type: "ui.http.body", sid: HTTP.sid, b64, more: true });
      }
      expect(f.frames.values).toEqual([]);
      await f.receive({ type: "ui.http.body", sid: HTTP.sid, b64: "AA==", more: false });
      expect(f.frames.values).toHaveLength(1);
      expect(await f.frames.next()).toEqual({
        type: "ui.error",
        sid: HTTP.sid,
        code: "limit_exceeded",
        message: "HTTP request bodies must not exceed 100 MiB.",
      });
      expect(f.handle.request).not.toHaveBeenCalled();
    } finally {
      admission.resolve(f.handle);
    }
    await f.receive({ ...HTTP, sid: "http0002" });
    expect((await response(f)).head.status).toBe(200);
  });

  it("streams HTTP chunks in both directions with unchanged paths, safe headers and read cookies", async () => {
    const f = setup();
    const upload = Buffer.alloc(512 * 1024, 3);
    const download = Buffer.alloc(512 * 1024 + 9);
    for (let index = 0; index < download.length; index++) {
      download[index] = index % 251;
    }
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
    for (const frame of bodies.slice(0, -1)) {
      const bytes = Buffer.from(String(frame.b64), "base64");
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
      expect(frame.more).toBe(true);
    }
    expect(bodies.at(-1)).toEqual({ type: "ui.http.body", sid: HTTP.sid, b64: "", more: false });
    expect(f.open).toHaveBeenCalledWith("gr_one", {
      ...ORIGINS,
      frameAncestors: ["https://chatgpt.com"],
    });
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
    vi.mocked(f.open).mockRejectedValue(
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
      vi.mocked(f.open).mockResolvedValue(f.handle);
      await f.receive({ ...HTTP, sid: "http0002" });
      expect((await response(f)).head.status).toBe(200);
      expect(f.open).toHaveBeenCalledTimes(2);
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

  it("copies fragmented messages linearly instead of concatenating every prefix", async () => {
    const f = setup();
    const socket = await opened(f);
    const chunk = Buffer.alloc(1024, 7);
    const b64 = chunk.toString("base64");
    let copiedBytes = 0;
    const concat = Buffer.concat.bind(Buffer);
    const copy = Buffer.prototype.copy;
    const concatSpy = vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
      copiedBytes += totalLength ?? list.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      return concat(list, totalLength);
    });
    const copySpy = vi.spyOn(Buffer.prototype, "copy").mockImplementation(function (
      this: Buffer,
      target,
      targetStart,
      sourceStart,
      sourceEnd,
    ) {
      const copied = copy.call(this, target, targetStart, sourceStart, sourceEnd);
      copiedBytes += copied;
      return copied;
    });
    try {
      for (let i = 0; i < 64; i++) {
        await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64, more: i < 63 });
      }
    } finally {
      concatSpy.mockRestore();
      copySpy.mockRestore();
    }
    expect(await socket.sent.next()).toEqual({
      kind: "binary",
      bytes: Buffer.alloc(64 * 1024, 7),
    });
    expect(copiedBytes).toBeLessThanOrEqual(3 * 64 * 1024);
  });

  it("keeps logical length and earlier binary messages across assembly reuse", async () => {
    const f = setup();
    const socket = await opened(f);
    for (const b64 of ["", "AQ==", "", "Ag=="]) {
      await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64, more: true });
    }
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "Aw==", more: false });
    const first = await socket.sent.next();
    expect(first).toEqual({ kind: "binary", bytes: Buffer.from([1, 2, 3]) });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "BAU=", more: true });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "Bg==", more: false });
    expect(await socket.sent.next()).toEqual({ kind: "binary", bytes: Buffer.from([4, 5, 6]) });
    expect(first).toEqual({ kind: "binary", bytes: Buffer.from([1, 2, 3]) });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "", more: false });
    expect(await socket.sent.next()).toEqual({ kind: "binary", bytes: Buffer.alloc(0) });
  });

  it("discards partial bytes on socket close before reusing the stream ID", async () => {
    const f = setup();
    const socket = await opened(f);
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "AQI=", more: true });
    await f.receive({ type: "ui.ws.close", sid: WS.sid, code: 1000, reason: "browser left" });
    expect(socket.closes[0]).toEqual({ code: 1000, reason: "browser left" });
    expect(socket.sent.values).toHaveLength(0);
    await f.receive(WS);
    expect(await f.frames.next()).toEqual({ type: "ui.ws.opened", sid: WS.sid });
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, b64: "Aw==", more: false });
    expect(await f.sockets[1]!.sent.next()).toEqual({ kind: "binary", bytes: Buffer.from([3]) });
  });

  it("assembles complete Unicode and empty fragments without exposing spare capacity", async () => {
    const f = setup();
    const socket = await opened(f);
    for (const text of ["", "😀", "é", "", "z"]) {
      await f.receive({ type: "ui.ws.msg", sid: WS.sid, text, more: true });
    }
    await f.receive({ type: "ui.ws.msg", sid: WS.sid, text: "", more: false });
    expect(await socket.sent.next()).toEqual({ kind: "text", text: "😀éz" });
  });

  it.each([{ b64: "AQ==" }, { text: "\ud800" }])(
    "rejects invalid text continuation %j and leaves other streams available",
    async (fragment) => {
      const f = setup();
      const socket = await opened(f);
      await f.receive({ type: "ui.ws.msg", sid: WS.sid, text: "prefix", more: true });
      await f.receive({ type: "ui.ws.msg", sid: WS.sid, ...fragment, more: false });
      expect(await f.frames.next()).toMatchObject({ type: "ui.error", code: "invalid" });
      expect(socket.sent.values).toHaveLength(0);
      expect(socket.closes[0]?.code).toBe(1011);
      await f.receive(HTTP);
      expect((await response(f)).head.status).toBe(200);
    },
  );

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

  it.each(["text", "binary"] as const)(
    "bounds assembled %s messages at 25 MiB and closes only the oversized socket",
    async (kind) => {
      const f = setup();
      const socket = await opened(f);
      const chunk =
        kind === "text"
          ? { text: "x".repeat(512 * 1024) }
          : {
              b64: Buffer.alloc(512 * 1024).toString("base64"),
            };
      for (let i = 0; i < 50; i++) {
        await f.receive({ type: "ui.ws.msg", sid: WS.sid, ...chunk, more: i < 49 });
      }
      const message = await socket.sent.next();
      expect(
        message.kind === "text" ? Buffer.byteLength(message.text) : message.bytes.byteLength,
      ).toBe(25 * 1024 * 1024);
      for (let i = 0; i < 50; i++) {
        await f.receive({ type: "ui.ws.msg", sid: WS.sid, ...chunk, more: true });
      }
      await f.receive({ type: "ui.ws.msg", sid: WS.sid, ...chunk, more: false });
      expect(await f.frames.next()).toMatchObject({
        type: "ui.error",
        sid: WS.sid,
        code: "limit_exceeded",
        message: "WebSocket messages must not exceed 25 MiB.",
      });
      expect(socket.closes[0]?.code).toBe(1011);
      expect(socket.sent.values).toHaveLength(1);
      await f.receive(HTTP);
      expect((await response(f)).head.status).toBe(200);
    },
  );

  it("evicts a retired UI handle before the next open", async () => {
    const f = setup();
    await f.receive(HTTP);
    await response(f);
    vi.mocked(f.handle.request).mockRejectedValueOnce(
      new GatewayControlUiIngressError("closed", "Remote Control UI ingress is closed."),
    );
    await f.receive({ ...HTTP, sid: "stale001" });
    expect(await f.frames.next()).toMatchObject({ type: "ui.error", code: "unavailable" });
    await f.receive({ ...HTTP, sid: "fresh001" });
    expect((await response(f)).head.status).toBe(200);
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it("rejects sandbox socket opens without rewriting browser origins", async () => {
    const f = setup();
    await f.receive({ ...WS, origin: ORIGINS.sandboxOrigin });
    expect((await f.frames.next()).code).toBe("forbidden");
    expect(f.handle.openWebSocket).not.toHaveBeenCalled();
  });

  it("cancels an HTTP read and passes a relay socket close to core", async () => {
    const f = setup();
    const request = Promise.withResolvers<AbortSignal>();
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

  it("revokes the live handle, aborts HTTP, closes sockets, and refuses subsequent frames", async () => {
    const f = setup();
    const socket = await opened(f);
    const request = Promise.withResolvers<AbortSignal>();
    vi.mocked(f.handle.request).mockImplementation(async (input) => {
      request.resolve(input.signal);
      return abortable(input.signal);
    });
    await f.receive(HTTP);
    const signal = await request.promise;
    f.active.delete("gr_one");
    f.tunnel.revoke("gr_one");
    expect(signal.aborted).toBe(true);
    expect(socket.closes[0]?.code).toBe(1008);
    expect((await f.frames.next()).code).toBe("grant_revoked");
    expect((await f.frames.next()).code).toBe("grant_revoked");
    await f.receive({ ...HTTP, sid: "revoked1" });
    expect((await f.frames.next()).code).toBe("grant_revoked");
    await f.stop();
    expect(f.handle.close).toHaveBeenCalledTimes(1);
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
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.open).mock.calls[1]![1].publicOrigin).toBe("https://new.ui.example");
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
