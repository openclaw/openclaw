import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { synologyChatPlugin } from "./channel.js";
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

function respond(res: http.ServerResponse, success: boolean, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success }));
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

function shortenDeadline(deadline: number, replacement: number, onceOnly = false) {
  const nativeSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout");
  const schedule = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    nativeSetTimeout(
      callback,
      onceOnly || delay === deadline ? replacement : delay,
      ...args,
    )) as typeof setTimeout;
  if (onceOnly) {
    spy.mockImplementationOnce(schedule);
  } else {
    spy.mockImplementation(schedule);
  }
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
      synologyChatPlugin.outbound.sendMedia({
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
      req.on("end", () => {
        respond(res, true);
      });
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
    let requestCount = 0;
    let uploadedBody = "";
    const port = await listenLoopback((req, res) => {
      requestCount += 1;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        uploadedBody += chunk;
      });
      req.on("end", () => {
        res.destroy();
      });
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    await expect(sendMessage(incomingUrl, "post-upload disconnect")).resolves.toBe(false);
    expect(requestCount).toBe(1);
    expect(new URLSearchParams(uploadedBody).get("payload")).toBe(
      JSON.stringify({ text: "post-upload disconnect" }),
    );
  });

  it("acquires durable send custody before webhook bytes cross the loopback boundary", async () => {
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const port = await listenLoopback((req, res) => {
      readPayload(req, (payload) => {
        receivedPayloads.push(payload);
        respond(res, true);
      });
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const cfg = config(incomingUrl, "synology-custody-proof");
    const marker = `autoqa-synology-custody-${randomUUID()}`;
    const sendContext = { cfg, text: marker, to: "42" };
    const custodyFailure = new Error(`fault-injected custody failure: ${marker}`);
    const rejectedDispatch = vi.fn(async () => {
      throw custodyFailure;
    });
    await expect(
      synologyChatPlugin.message.send?.text?.({
        ...sendContext,
        onPlatformSendDispatch: rejectedDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedDispatch).toHaveBeenCalledOnce();
    expect(receivedPayloads).toEqual([]);
    const acceptedDispatch = vi.fn(async () => undefined);
    await synologyChatPlugin.message.send?.text?.({
      ...sendContext,
      onPlatformSendDispatch: acceptedDispatch,
    });
    expect(acceptedDispatch).toHaveBeenCalledOnce();
    expect(receivedPayloads).toEqual([{ text: marker, user_ids: [42] }]);
    const rejectedMediaDispatch = vi.fn(async () => {
      throw custodyFailure;
    });
    hostedCapabilityCleanup.mockClear();
    await expect(
      synologyChatPlugin.message.send?.media?.({
        ...sendContext,
        mediaUrl: "https://example.com/custody-proof.png",
        onPlatformSendDispatch: rejectedMediaDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedMediaDispatch).toHaveBeenCalledOnce();
    expect(hostedCapabilityCleanup).toHaveBeenCalledOnce();
    expect(receivedPayloads).toHaveLength(1);
  });

  it("rejects invalid recipients before HTTP and delivers normalized numeric IDs", async () => {
    const payloads: unknown[] = [];
    const port = await listenLoopback((req, res) => {
      readPayload(req, (payload) => {
        payloads.push(payload);
        respond(res, true);
      });
    });
    const cfg = config(`http://127.0.0.1:${port}/webapi/entry.cgi`);
    const plugin: ChannelPlugin = synologyChatPlugin;
    const resolve = (to: string) => plugin.outbound?.resolveTarget?.({ cfg, to, mode: "explicit" });
    const invalid = resolve("42oops");
    if (invalid?.ok) {
      await synologyChatPlugin.outbound.sendText({
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
    await synologyChatPlugin.outbound.sendText({ cfg, text: "normalized recipient", to: valid.to });
    expect(payloads).toEqual([{ text: "normalized recipient", user_ids: [42] }]);
  });

  it("delivers authenticated text and media without inventing platform message ids", async () => {
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const port = await listenLoopback((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== "/webapi/entry.cgi" ||
        requestUrl.searchParams.get("api") !== "SYNO.Chat.External" ||
        requestUrl.searchParams.get("method") !== "chatbot" ||
        requestUrl.searchParams.get("version") !== "2" ||
        requestUrl.searchParams.get("token") !== "synology-loopback-proof"
      ) {
        respond(res, false, 403);
        return;
      }
      readForm(req, (payload) => {
        if (!payload) {
          respond(res, false, 400);
          return;
        }
        receivedPayloads.push(JSON.parse(payload) as Record<string, unknown>);
        respond(res, true);
      });
    });
    const incomingUrl =
      `http://127.0.0.1:${port}/webapi/entry.cgi?` +
      "api=SYNO.Chat.External&method=chatbot&version=2&token=synology-loopback-proof";
    const cfg = config(incomingUrl, "synology-loopback-proof");
    const mediaUrl = "https://example.com/synology-receipt-proof.png";
    const sendContext = { cfg, to: "42" };
    const outboundText = await synologyChatPlugin.outbound.sendText({
      ...sendContext,
      text: "native outbound text",
    });
    const outboundMedia = await synologyChatPlugin.outbound.sendMedia({
      ...sendContext,
      text: "native outbound media",
      mediaUrl,
    });
    const durableText = await synologyChatPlugin.message.send?.text?.({
      ...sendContext,
      text: "durable adapter text",
    });
    const durableMedia = await synologyChatPlugin.message.send?.media?.({
      ...sendContext,
      text: "durable adapter media",
      mediaUrl,
    });
    expect(receivedPayloads).toEqual([
      { text: "native outbound text", user_ids: [42] },
      { file_url: hostedCapabilityUrl, text: "native outbound media", user_ids: [42] },
      { text: "durable adapter text", user_ids: [42] },
      { file_url: hostedCapabilityUrl, text: "durable adapter media", user_ids: [42] },
    ]);
    expect(durableText).toBeDefined();
    expect(durableMedia).toBeDefined();
    for (const result of [outboundText, outboundMedia, durableText, durableMedia]) {
      expect(result).toMatchObject({
        channel: "synology-chat",
        messageId: "",
        target: { kind: "chat", id: "42" },
        receipt: {
          platformMessageIds: [],
          parts: [],
          threadId: "42",
        },
      });
      expect(result?.receipt.primaryPlatformMessageId).toBeUndefined();
    }
  });

  it.each([true, false])(
    "bounds attachment captions and preserves media custody when overflow acceptance is %s",
    async (acceptOverflow) => {
      const receivedPayloads: Array<Record<string, unknown>> = [];
      const dispatchOrder: string[] = [];
      const port = await listenLoopback((req, res) => {
        dispatchOrder.push("post");
        readPayload(req, (payload) => {
          receivedPayloads.push(payload);
          const accepted =
            typeof payload.text === "string" &&
            payload.text.length <= 2_000 &&
            (Boolean(payload.file_url) || acceptOverflow);
          respond(res, accepted, accepted ? 200 : 413);
        });
      });
      const cfg = config(`http://127.0.0.1:${port}/webapi/entry.cgi`);
      hostedCapabilityCleanup.mockClear();
      const delivery = synologyChatPlugin.message.send?.media?.({
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
      expect(receivedPayloads).toEqual([
        { file_url: hostedCapabilityUrl, text: "x".repeat(2_000), user_ids: [42] },
        { text: "x", user_ids: [42] },
      ]);
      expect(dispatchOrder).toEqual(["dispatch", "post", "dispatch", "post"]);
      expect(hostedCapabilityCleanup).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "all text chunks",
      text: "x".repeat(4001),
      media: false,
      missingChunk: -1,
      ids: ["25769804017", "25769804018", "25769804019"],
    },
    {
      name: "partially identified text",
      text: "x".repeat(2001),
      media: false,
      missingChunk: 1,
      ids: [],
    },
    { name: "hosted media", text: "", media: true, missingChunk: -1, ids: ["25769804017"] },
  ])(
    "preserves genuine webhook identities for $name",
    async ({ text, media, missingChunk, ids }) => {
      let requestCount = 0;
      const payloads: Record<string, unknown>[] = [];
      const port = await listenLoopback((req, res) => {
        readPayload(req, (payload) => {
          payloads.push(payload);
          const index = requestCount++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                succ: {
                  user_id_post_map: {
                    "123456": index === missingChunk ? undefined : 25769804017 + index,
                  },
                },
              },
            }),
          );
        });
      });
      const cfg = config(`http://127.0.0.1:${port}/incoming`);
      const context = { cfg, text, to: "123456" };
      const result = media
        ? await synologyChatPlugin.message.send?.media?.({
            ...context,
            mediaUrl: "https://example.com/proof.png",
          })
        : await synologyChatPlugin.message.send?.text?.(context);
      expect(requestCount).toBe(media ? 1 : Math.ceil(text.length / 2000));
      expect(result?.messageId).toBe(ids[0] ?? "");
      expect(result?.receipt.platformMessageIds).toEqual(ids);
      expect(result?.receipt.parts.map((part) => part.platformMessageId)).toEqual(ids);
      if (!media) {
        expect(payloads.map((payload) => payload.text).join("")).toBe(text);
        for (const [index, payload] of payloads.entries()) {
          expect(typeof payload.text).toBe("string");
          expect(payload.text).toHaveLength(Math.min(2_000, text.length - index * 2_000));
          expect(payload.user_ids).toEqual([123456]);
        }
      }
    },
  );

  it("rejects unauthenticated webhook sends without fabricating delivery receipts", async () => {
    let rejectedRequests = 0;
    const port = await listenLoopback((_req, res) => {
      rejectedRequests += 1;
      respond(res, false, 403);
    });
    const cfg = config(
      `http://127.0.0.1:${port}/webapi/entry.cgi?` +
        "api=SYNO.Chat.External&method=chatbot&version=2&token=synology-loopback-rejected",
      "synology-loopback-rejected",
    );
    await expect(
      synologyChatPlugin.outbound.sendText({ cfg, text: "rejected", to: "42" }),
    ).rejects.toThrow("Failed to send message to Synology Chat");
    expect(rejectedRequests).toBe(1);
    await expect(
      synologyChatPlugin.outbound.sendMedia({
        cfg,
        mediaUrl: "https://example.com/synology-receipt-proof.png",
        to: "42",
      }),
    ).rejects.toThrow("rejected the attachment request");
    expect(rejectedRequests).toBe(2);
  });

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
      const timeoutSpy =
        failure === "deadline" ? shortenDeadline(15_000, timeoutMs, true) : undefined;
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
