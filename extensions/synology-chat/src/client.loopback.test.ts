import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { synologyChatPlugin as plugin } from "./channel.js";
import { resolveLegacyWebhookNameToChatUserId, sendMessage } from "./client.js";

const { hostedCapabilityUrl, hostedCapabilityCleanup } = vi.hoisted(() => ({
  hostedCapabilityUrl:
    "https://gateway.example.com/webhook/synology?__openclaw_synology_media_token_aaaaaaaaaaaaaaaaaaaaaaaa=secret",
  hostedCapabilityCleanup: vi.fn(async () => undefined),
}));
vi.mock("./outbound-media.js", () => ({
  prepareSynologyHostedMedia: vi.fn(async () => ({
    url: hostedCapabilityUrl,
    cleanup: hostedCapabilityCleanup,
  })),
  resolveSynologyHostedMediaRoute: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  // client.test.ts covers send-slot timing; keep retry and deadline timers real.
  sleep: async () => undefined,
}));

const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

function respond(res: http.ServerResponse, success: boolean, status = 200, data?: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success, data }));
}

function readForm(req: http.IncomingMessage, done: (payload: string | null) => void) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => done(new URLSearchParams(body).get("payload")));
}

function config(incomingUrl: string, token = "loopback-token") {
  return { channels: { "synology-chat": { enabled: true, token, incomingUrl } } };
}

function readPayload(req: http.IncomingMessage, done: (payload: Record<string, unknown>) => void) {
  readForm(req, (body) => done(JSON.parse(body ?? "{}") as Record<string, unknown>));
}

function drip(res: http.ServerResponse) {
  // Keep bytes flowing so the socket-idle timeout cannot end the response.
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write("x");
    }
  }, 20);
  res.on("close", () => clearInterval(timer));
  res.write("x");
}

function shortenDeadline(deadline: number, replacement: number) {
  const nativeSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout");
  spy.mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    nativeSetTimeout(
      callback,
      delay === deadline ? replacement : delay,
      ...args,
    )) as typeof setTimeout);
  return spy;
}

describe("Synology Chat client loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener, port = 0): Promise<number> {
    server = http.createServer(handler);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  async function reserveLoopbackPort(): Promise<number> {
    const reservation = http.createServer();
    const port = await listenOnLoopback(reservation);
    await reservation[Symbol.asyncDispose]();
    return port;
  }

  async function capturePayloads(
    reply: (payload: Record<string, unknown>, index: number, res: http.ServerResponse) => void = (
      _payload,
      _index,
      res,
    ) => respond(res, true),
  ) {
    const payloads: Record<string, unknown>[] = [];
    const endpoint =
      "/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=synology-loopback-proof";
    const port = await listenLoopback((req, res) => {
      if (req.method !== "POST" || req.url !== endpoint) {
        respond(res, false, 403);
        return;
      }
      readPayload(req, (payload) => {
        payloads.push(payload);
        reply(payload, payloads.length - 1, res);
      });
    });
    const incomingUrl = `http://127.0.0.1:${port}${endpoint}`;
    return { payloads, incomingUrl, cfg: config(incomingUrl, "synology-loopback-proof") };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      const closed = server[Symbol.asyncDispose]();
      server?.closeAllConnections?.();
      await closed;
      server = undefined;
    }
  });

  it.each([
    [500, "acceptance could not be confirmed", 0],
    [0, "request did not start", 1],
    [403, "rejected the attachment request", 1],
  ] as const)("keeps staged-byte custody for outcome %i", async (status, error, cleanups) => {
    const port = await listenLoopback((_req, res) => respond(res, false, status || 200));
    hostedCapabilityCleanup.mockClear();
    await expect(
      plugin.outbound.sendMedia({
        cfg: config(status ? `http://127.0.0.1:${port}/incoming` : "not-a-url"),
        mediaUrl: "https://example.com/img.png",
        to: "user1",
      }),
    ).rejects.toThrow(error);
    expect(hostedCapabilityCleanup).toHaveBeenCalledTimes(cleanups);
  });

  it("retries once when a real connection refusal occurs before the listener starts", async () => {
    const port = await reserveLoopbackPort();
    const nativeSetTimeout = globalThis.setTimeout;
    let releaseRetry: (() => void) | undefined;
    const { promise: retryScheduled, resolve: markRetryScheduled } = Promise.withResolvers<void>();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    timeoutSpy.mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 300 && releaseRetry === undefined) {
        const heldTimer = nativeSetTimeout(() => {}, 10_000);
        heldTimer.unref?.();
        releaseRetry = () => {
          clearTimeout(heldTimer);
          callback(...args);
        };
        markRetryScheduled();
        return heldTimer;
      }
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const send = sendMessage(incomingUrl, "retry after refusal");
    const firstOutcome = await Promise.race([
      retryScheduled.then(() => "retry-scheduled" as const),
      send.then((sendResult) => ({ sendResult })),
    ]);
    expect(firstOutcome).toBe("retry-scheduled");
    let receivedRequests = 0;
    await listenLoopback((req, res) => {
      receivedRequests += 1;
      req.resume();
      req.on("end", () => respond(res, true));
    }, port);
    if (!releaseRetry) {
      throw new Error("expected pre-connect retry backoff");
    }
    releaseRetry();
    await expect(send).resolves.toEqual({ messageIds: [] });
    expect(receivedRequests).toBe(1);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 300)).toHaveLength(1);
  });

  it("does not replay after the server receives the upload and disconnects", async () => {
    const { payloads, incomingUrl } = await capturePayloads((_payload, _index, res) =>
      res.destroy(),
    );
    await expect(sendMessage(incomingUrl, "post-upload disconnect")).resolves.toBe(false);
    expect(payloads).toEqual([{ text: "post-upload disconnect" }]);
  });

  it("acquires durable send custody before webhook bytes cross the loopback boundary", async () => {
    const { payloads, cfg } = await capturePayloads();
    const marker = `autoqa-synology-custody-${randomUUID()}`;
    const sendContext = { cfg, text: marker, to: "42" };
    const custodyFailure = new Error(`fault-injected custody failure: ${marker}`);
    const rejectedDispatch = vi.fn(async () => {
      throw custodyFailure;
    });
    await expect(
      plugin.message.send?.text?.({
        ...sendContext,
        onPlatformSendDispatch: rejectedDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedDispatch).toHaveBeenCalledOnce();
    expect(payloads).toEqual([]);
    const acceptedDispatch = vi.fn(async () => undefined);
    await plugin.message.send?.text?.({
      ...sendContext,
      onPlatformSendDispatch: acceptedDispatch,
    });
    expect(acceptedDispatch).toHaveBeenCalledOnce();
    expect(payloads).toEqual([{ text: marker, user_ids: [42] }]);
    rejectedDispatch.mockClear();
    hostedCapabilityCleanup.mockClear();
    await expect(
      plugin.message.send?.media?.({
        ...sendContext,
        mediaUrl: "https://example.com/custody-proof.png",
        onPlatformSendDispatch: rejectedDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedDispatch).toHaveBeenCalledOnce();
    expect(hostedCapabilityCleanup).toHaveBeenCalledOnce();
    expect(payloads).toHaveLength(1);
  });

  it("rejects invalid recipients before HTTP and delivers normalized numeric IDs", async () => {
    const { payloads, cfg } = await capturePayloads();
    const channel: ChannelPlugin = plugin;
    const resolve = (to: string) =>
      channel.outbound?.resolveTarget?.({ cfg, to, mode: "explicit" });
    const invalid = resolve("42oops");
    if (invalid?.ok) {
      await plugin.outbound.sendText({
        cfg,
        text: "invalid recipient",
        to: invalid.to,
      });
    }
    expect(invalid).toMatchObject({ ok: false });
    expect(payloads).toEqual([]);
    const valid = resolve("synology-chat:00042");
    expect(valid).toEqual({ ok: true, to: "42" });
    if (!valid?.ok) {
      throw new Error("Expected a normalized recipient");
    }
    await plugin.outbound.sendText({ cfg, text: "normalized recipient", to: valid.to });
    expect(payloads).toEqual([{ text: "normalized recipient", user_ids: [42] }]);
  });

  it.each([true, false])(
    "bounds attachment captions and preserves media custody when overflow acceptance is %s",
    async (acceptOverflow) => {
      const dispatchOrder: string[] = [];
      const { payloads, cfg } = await capturePayloads((payload, _index, res) => {
        dispatchOrder.push("post");
        const accepted =
          typeof payload.text === "string" &&
          payload.text.length <= 2_000 &&
          (Boolean(payload.file_url) || acceptOverflow);
        respond(res, accepted, accepted ? 200 : 413);
      });
      hostedCapabilityCleanup.mockClear();
      const delivery = plugin.message.send?.media?.({
        cfg,
        text: "x".repeat(2_001),
        to: "42",
        mediaUrl: "https://example.com/caption.png",
        onPlatformSendDispatch: async () => {
          dispatchOrder.push("dispatch");
        },
      });
      if (acceptOverflow) {
        await delivery;
      } else {
        await expect(delivery).rejects.toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: {
            visibleReplySent: true,
            content: "x".repeat(2_000),
            receipt: { threadId: "42", platformMessageIds: [] },
          },
        });
      }
      expect(payloads).toEqual([
        { file_url: hostedCapabilityUrl, text: "x".repeat(2_000), user_ids: [42] },
        { text: "x", user_ids: [42] },
      ]);
      expect(dispatchOrder).toEqual(["dispatch", "post", "dispatch", "post"]);
      expect(hostedCapabilityCleanup).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["all text chunks", 4001, false, -1, ["25769804017", "25769804018", "25769804019"]],
    ["partially identified text", 2001, false, 1, []],
    ["hosted media", 0, true, -1, ["25769804017"]],
    ["unidentified text", 5, false, 0, []],
    ["unidentified media", 5, true, 0, []],
  ] as const)(
    "preserves genuine webhook identities for %s",
    async (_name, length, media, missingChunk, ids) => {
      const text = "x".repeat(length);
      const { payloads, cfg } = await capturePayloads((_payload, index, res) => {
        const user_id_post_map = {
          "123456": index === missingChunk ? undefined : 25769804017 + index,
        };
        respond(res, true, 200, missingChunk === 0 ? undefined : { succ: { user_id_post_map } });
      });
      const context = { cfg, text, to: "123456" };
      const result = media
        ? await (missingChunk === 0 ? plugin.outbound.sendMedia : plugin.message.send?.media)?.({
            ...context,
            mediaUrl: "https://example.com/proof.png",
          })
        : await (missingChunk === 0 ? plugin.outbound.sendText : plugin.message.send?.text)?.(
            context,
          );
      expect(payloads).toEqual(
        media
          ? [{ ...(text ? { text } : {}), user_ids: [123456], file_url: hostedCapabilityUrl }]
          : Array.from({ length: Math.ceil(length / 2000) }, (_, index) => ({
              text: text.slice(index * 2000, (index + 1) * 2000),
              user_ids: [123456],
            })),
      );
      expect(result).toMatchObject({
        channel: "synology-chat",
        messageId: ids[0] ?? "",
        target: { kind: "chat", id: "123456" },
        receipt: { platformMessageIds: ids, threadId: "123456" },
      });
      expect(result?.receipt.parts.map((part) => part.platformMessageId)).toEqual(ids);
      if (missingChunk === 0) {
        expect(result?.receipt.parts).toEqual([]);
        expect(result?.receipt.primaryPlatformMessageId).toBeUndefined();
      }
    },
  );

  it.each(["overflow", "deadline"] as const)(
    "returns stale identity after a streamed user_list %s",
    async (failure) => {
      let requestCount = 0;
      const port = await listenLoopback((_req, res) => {
        requestCount += 1;
        res.on("error", () => {});
        res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
        if (requestCount === 1) {
          res.end(
            JSON.stringify({
              success: true,
              data: {
                users: [{ user_id: 17, username: "cached", nickname: "cached-user" }],
              },
            }),
          );
        } else if (failure === "deadline") {
          drip(res);
        } else {
          res.write(Buffer.alloc(USER_LIST_RESPONSE_MAX_BYTES, 0x78));
          res.end(Buffer.from("x"));
        }
      });
      const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi?method=chatbot&token=${randomUUID()}`;
      const warnings: string[] = [];
      const lookup = () =>
        resolveLegacyWebhookNameToChatUserId({
          incomingUrl,
          mutableWebhookUsername: "cached-user",
          log: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
        });
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      await expect(lookup()).resolves.toBe(17);
      now.mockReturnValue(1_700_000_000_000 + 10 * 60 * 1000);
      const timeoutMs = 250;
      const timeoutSpy = failure === "deadline" ? shortenDeadline(15_000, timeoutMs) : undefined;
      const startedAt = performance.now();
      await expect(lookup()).resolves.toBe(17);
      const elapsedMs = performance.now() - startedAt;
      expect(requestCount).toBe(2);
      if (failure === "deadline") {
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
        expect(warnings).toContain("fetchChatUsers: request timed out, using cached data");
        expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
        expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
      } else {
        expect(warnings).toContain(
          `fetchChatUsers: user_list response exceeded ${USER_LIST_RESPONSE_MAX_BYTES} bytes, using cached data`,
        );
      }
    },
  );

  it("does not replay a code-less wall-clock timeout from a dripping chatbot response", async () => {
    let requestCount = 0;
    const port = await listenLoopback((_req, res) => {
      requestCount += 1;
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      drip(res);
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const timeoutMs = 250;
    const timeoutSpy = shortenDeadline(30_000, timeoutMs);
    const startedAt = performance.now();
    await expect(sendMessage(incomingUrl, "hello")).resolves.toBe(false);
    const elapsedMs = performance.now() - startedAt;
    expect(requestCount).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });
});
