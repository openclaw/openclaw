import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  sanitizeForPlainText,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { apiThrottler } from "./bot.runtime.js";
import { deliverReplies } from "./bot/delivery.js";
import { telegramPlugin } from "./channel.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

describe("Telegram physical send acceptance over HTTP", () => {
  let server: Server;
  let bot: Bot;
  let mediaDir: string;
  let photoPath: string;
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; fields: Record<string, unknown> }> = [];
  const events: string[] = [];
  const rejections: Array<
    | string
    | { error_code: 429; description: string; parameters: { retry_after: number } }
    | { error_code: 421; description: string }
    | { resetConnection: true }
  > = [];
  let requestHold:
    | {
        arrived: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  const cfg = { channels: { telegram: { botToken: "123456:telegram-send-http-fixture" } } };
  const buttons = [[{ text: "Continue", callback_data: "continue" }]];
  const telegramOutbound = createTelegramOutboundAdapter();

  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-physical-send-"));
    photoPath = path.join(mediaDir, "pixel.png");
    await fs.writeFile(
      photoPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const respond = async () => {
        const body = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] ?? "application/json";
        const fields = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(body, { headers: { "content-type": contentType } }).formData(),
            )
          : (JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, fields });
        events.push("http");
        const held = requestHold;
        requestHold = undefined;
        if (held) {
          held.arrived.resolve();
          await held.release.promise;
        }
        response.setHeader("content-type", "application/json");
        const rejection = rejections.shift();
        if (rejection) {
          if (typeof rejection === "object" && "resetConnection" in rejection) {
            response.destroy();
            return;
          }
          const error =
            typeof rejection === "string" ? { error_code: 400, description: rejection } : rejection;
          response.statusCode = error.error_code;
          response.end(JSON.stringify({ ok: false, ...error }));
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            result:
              method === "pinChatMessage" || method === "deleteMessage"
                ? true
                : {
                    message_id: requests.length,
                    date: 1_700_000_000,
                    chat: { id: 123, type: "private" },
                    text: fields.text,
                    caption: fields.caption,
                    ...(fields.message_thread_id
                      ? { message_thread_id: Number(fields.message_thread_id) }
                      : {}),
                  },
          }),
        );
      };
      request.on("end", () => {
        void respond().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    bot = new Bot(cfg.channels.telegram.botToken, {
      client: { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    });
  });

  beforeEach(() => {
    requests.length = 0;
    events.length = 0;
    rejections.length = 0;
  });

  afterAll(async () => {
    resetTelegramClientOptionsCacheForTests();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(mediaDir, { recursive: true, force: true });
  });

  async function sendThrough(
    entry: "direct" | "public",
    text: string,
    dispatch: () => Promise<void>,
    mediaUrl?: string,
    rich = false,
    assertPlatformSendAuthorized?: () => void,
  ) {
    if (entry === "public") {
      return sendMessageTelegram("123", text, {
        cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: rich } } },
        api: bot.api,
        textMode: rich ? undefined : "html",
        replyToMessageId: 7,
        quoteText: "quote",
        onPlatformSendDispatch: dispatch,
        assertPlatformSendAuthorized,
        ...(mediaUrl ? { mediaUrl, mediaLocalRoots: [mediaDir], buttons } : {}),
        ...(rich ? { buttons } : {}),
      });
    }
    return deliverReplies({
      cfg,
      bot,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      runtime: {
        log() {},
        error() {},
        exit: () => {
          throw new Error("unexpected exit");
        },
      },
      replies: [
        {
          text,
          replyToId: "7",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrl || rich ? { channelData: { telegram: { buttons } } } : {}),
        },
      ],
      mediaLocalRoots: [mediaDir],
      replyToMode: "all",
      textLimit: 4000,
      replyQuoteMessageId: 7,
      replyQuoteText: "quote",
      textMode: rich ? undefined : "html",
      richMessages: rich,
      onPlatformSendDispatch: dispatch,
      assertPlatformSendAuthorized,
    });
  }

  async function pinThroughAdapter(
    token: string,
    messageId: number,
    assertDirectAdapterHandoff?: () => void,
  ) {
    await telegramOutbound.pinDeliveredMessage!({
      cfg: {
        channels: {
          telegram: {
            botToken: token,
            apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        },
      },
      target: { channel: "telegram", to: "123", accountId: "default" },
      messageId: String(messageId),
      pin: { enabled: true },
      ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
    });
  }

  it("projects unspaced labeled links through the public Telegram plain-text contract", async () => {
    const source = "<https://example.com/a.pdf|Manual>";
    const text = sanitizeForPlainText(source, { style: "markdown" });

    await sendThrough("public", text, async () => {});

    expect(requests.at(-1)?.fields.text).toBe("Manual");
  });

  it.each(["text", "caption"] as const)(
    "preserves literal code spacing in the %s sent over HTTP",
    async (kind) => {
      await sendMessageTelegram("123", "````\n```\n• literal bullet\n3. literal number\n````", {
        cfg,
        api: bot.api,
        ...(kind === "caption" ? { mediaUrl: photoPath, mediaLocalRoots: [mediaDir] } : {}),
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe(kind === "caption" ? "sendPhoto" : "sendMessage");
      expect(requests[0]?.fields.parse_mode).toBe("HTML");
      expect(requests[0]?.fields[kind]).toBe(
        "<pre><code>```\n• literal bullet\n3. literal number\n</code></pre>",
      );
    },
  );

  it.each(["active", "closed", "aborted"])(
    "checks %s send authority after the real account queue drains",
    async (state) => {
      const token = `123456:telegram-queue-${state}`;
      getOrCreateAccountThrottler(token, () =>
        apiThrottler({ global: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
      );
      const queuedCfg = {
        channels: {
          telegram: {
            botToken: token,
            apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        },
      };
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      requestHold = held;
      const blocker = sendMessageTelegram("123", "queue blocker", { cfg: queuedCfg });
      await held.arrived.promise;
      const checkedBeforeQueue = createDeferred<void>();
      const controller = new AbortController();
      const revoked = new Error("Send authority closed while queued");
      let authorityActive = true;
      const outcome = sendMessageTelegram("123", "queued message", {
        cfg: queuedCfg,
        signal: controller.signal,
        assertPlatformSendAuthorized: () => {
          if (!authorityActive) {
            throw revoked;
          }
          checkedBeforeQueue.resolve();
        },
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await checkedBeforeQueue.promise;
        expect(requests.map(({ fields }) => fields.text)).toEqual(["queue blocker"]);
        authorityActive = state !== "closed";
        if (state === "aborted") {
          controller.abort();
        }
        held.release.resolve();
        await blocker;
        if (state === "active") {
          await expect(outcome).resolves.toMatchObject({ result: { messageId: "2" } });
          expect(requests.map(({ fields }) => fields.text)).toEqual([
            "queue blocker",
            "queued message",
          ]);
        } else {
          await expect(outcome).resolves.toMatchObject({
            error: state === "closed" ? revoked : { name: "AbortError" },
          });
          expect(requests.map(({ fields }) => fields.text)).toEqual(["queue blocker"]);
        }
      } finally {
        held.release.resolve();
        await Promise.allSettled([blocker, outcome]);
      }
    },
  );

  it.each(["active", "closed"] as const)(
    "checks %s adopted-message deletion authority at the registered action boundary",
    async (state) => {
      const revoked = new Error("Progress owner retired");
      const action = telegramPlugin.actions?.handleAction?.({
        channel: "telegram",
        action: "delete",
        params: { chatId: "123", messageId: 42 },
        cfg: {
          channels: {
            telegram: {
              botToken: cfg.channels.telegram.botToken,
              apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            },
          },
        },
        accountId: "default",
        conversationReadOrigin: "direct-operator",
        assertDirectAdapterHandoff: () => {
          if (state === "closed") {
            throw revoked;
          }
        },
      });
      if (state === "closed") {
        await expect(action).rejects.toBe(revoked);
        expect(requests).toEqual([]);
      } else {
        await expect(action).resolves.toMatchObject({ details: { ok: true, deleted: true } });
        expect(requests).toEqual([
          { method: "deleteMessage", fields: { chat_id: "123", message_id: 42 } },
        ]);
        expect(telegramPlugin.actions?.writeAuthorityActions).toContain("delete");
      }
    },
  );

  it("fences provider-owned delivery after async dispatch refresh and before HTTP", async () => {
    const authorityRevoked = new Error("delivery authority revoked after dispatch refresh");
    let authorityActive = true;
    const dispatch = async () => {
      await Promise.resolve();
      authorityActive = false;
    };
    const assertPlatformSendAuthorized = () => {
      if (!authorityActive) {
        throw authorityRevoked;
      }
    };

    await expect(
      sendThrough("direct", "answer", dispatch, undefined, false, assertPlatformSendAuthorized),
    ).rejects.toBe(authorityRevoked);
    expect(requests).toHaveLength(0);
  });

  it("fences queued delivery pins without revoking other clients for the same account", async () => {
    const token = "123456:telegram-pin-queue";
    const queued = createDeferred<void>();
    let queuedPins = 0;
    getOrCreateAccountThrottler(token, () => {
      const throttle = apiThrottler({ global: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } });
      return (prev, method, payload, signal) => {
        const pending = throttle(prev, method, payload, signal);
        if (method === "pinChatMessage" && ++queuedPins === 3) {
          queued.resolve();
        }
        return pending;
      };
    });
    const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
    requestHold = held;
    const revoked = new Error("Pin authority revoked while queued");
    let authorityActive = true;
    let authorizedChecks = 0;
    const blocker = pinThroughAdapter(token, 101);
    const deniedPin = pinThroughAdapter(token, 102, () => {
      if (!authorityActive) {
        throw revoked;
      }
    }).then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    const authorizedPin = pinThroughAdapter(token, 103, () => {
      authorizedChecks += 1;
    });
    try {
      await held.arrived.promise;
      await queued.promise;
      expect(requests.map(({ fields }) => fields.message_id)).toEqual([101]);
      authorityActive = false;
      held.release.resolve();
      await blocker;
      await expect(deniedPin).resolves.toEqual({ error: revoked });
      await authorizedPin;
      expect(authorizedChecks).toBeGreaterThan(0);
      // An older caller must not inherit the rejected client's assertion.
      await pinThroughAdapter(token, 104);
      expect(requests.map(({ method, fields }) => [method, fields.message_id])).toEqual([
        ["pinChatMessage", 101],
        ["pinChatMessage", 103],
        ["pinChatMessage", 104],
      ]);
    } finally {
      held.release.resolve();
      await Promise.allSettled([blocker, deniedPin, authorizedPin]);
    }
  });

  it("fences delivery pin retries after the actual Telegram retry_after wait", async () => {
    const token = "123456:telegram-pin-retry";
    const retryResponse = createDeferred<void>();
    getOrCreateAccountThrottler(token, () => {
      const throttle = apiThrottler({ global: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } });
      return async (prev, method, payload, signal) => {
        const response = await throttle(prev, method, payload, signal);
        if (method === "pinChatMessage" && !response.ok && response.error_code === 429) {
          retryResponse.resolve();
        }
        return response;
      };
    });
    rejections.push({
      error_code: 429,
      description: "Too Many Requests: retry after 1",
      parameters: { retry_after: 1 },
    });
    const revoked = new Error("Pin authority revoked during retry delay");
    let authorityActive = true;
    const outcome = pinThroughAdapter(token, 201, () => {
      if (!authorityActive) {
        throw revoked;
      }
    }).then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await retryResponse.promise;
      // Let grammY consume the response and enter the existing real retry sleep.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(requests.map(({ fields }) => fields.message_id)).toEqual([201]);
      authorityActive = false;
      await expect(outcome).resolves.toEqual({ error: revoked });
      expect(requests.map(({ method, fields }) => [method, fields.message_id])).toEqual([
        ["pinChatMessage", 201],
      ]);
    } finally {
      await outcome;
    }
  });

  it("settles an accepted delivery pin after its authority is revoked", async () => {
    const token = "123456:telegram-pin-accepted";
    const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
    requestHold = held;
    let authorityActive = true;
    let authorityChecks = 0;
    const outcome = pinThroughAdapter(token, 301, () => {
      authorityChecks += 1;
      if (!authorityActive) {
        throw new Error("Pin authority revoked after acceptance");
      }
    });
    try {
      await held.arrived.promise;
      expect(authorityChecks).toBeGreaterThan(0);
      const checksAtAcceptance = authorityChecks;
      authorityActive = false;
      held.release.resolve();
      await expect(outcome).resolves.toBeUndefined();
      expect(authorityChecks).toBe(checksAtAcceptance);
      expect(requests.map(({ method, fields }) => [method, fields.message_id])).toEqual([
        ["pinChatMessage", 301],
      ]);
    } finally {
      held.release.resolve();
      await Promise.allSettled([outcome]);
    }
  });

  it.each([
    { failure: "misdirected", revoke: false },
    { failure: "misdirected", revoke: true },
    { failure: "connection", revoke: false },
    { failure: "connection", revoke: true },
  ] as const)(
    "checks pin authority through $failure fallback (revoked: $revoke)",
    async ({ failure, revoke }) => {
      // Each control needs a fresh transport with an available fallback path.
      resetTelegramClientOptionsCacheForTests();
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      requestHold = held;
      rejections.push(
        failure === "misdirected"
          ? { error_code: 421, description: "Misdirected Request" }
          : { resetConnection: true },
      );
      const revoked = new Error("Pin authority revoked before transport fallback");
      let current = true;
      const outcome = pinThroughAdapter(`123456:pin-${failure}-${revoke}`, 401, () => {
        if (!current) {
          throw revoked;
        }
      }).then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          held.arrived.promise,
          outcome.then(() => {
            throw new Error("pin settled before the held fallback response");
          }),
        ]);
        current = !revoke;
        held.release.resolve();
        expect(await outcome).toEqual(revoke ? { error: revoked } : { ok: true });
        expect(requests.map(({ method, fields }) => [method, fields.message_id])).toEqual(
          Array.from({ length: revoke ? 1 : 2 }, () => ["pinChatMessage", 401]),
        );
      } finally {
        held.release.resolve();
        await outcome;
      }
    },
  );

  it.each(["direct", "public"] as const)(
    "preserves %s operation callbacks through quote and format fallback",
    async (entry) => {
      rejections.push("Bad Request: quote not found", "Bad Request: can't parse entities");
      await sendThrough(entry, "answer", async () => {
        events.push("dispatch");
      });
      expect(events).toEqual(
        entry === "direct"
          ? ["dispatch", "http", "http", "http"]
          : ["dispatch", "http", "dispatch", "http", "dispatch", "http"],
      );
      expect(requests).toHaveLength(3);
      expect(requests[0]?.fields.reply_parameters).toMatchObject({ message_id: 7, quote: "quote" });
      expect(requests[1]?.fields.reply_to_message_id).toBe(7);
      expect(requests[2]?.fields.parse_mode).toBeUndefined();
    },
  );

  it.each(["direct", "public"] as const)(
    "retains accepted IDs when the next existing %s callback rejects closure",
    async (entry) => {
      const closure = new PlatformMessageNotDispatchedError("delivery owner closed", {
        cause: new Error("fixture authority closed after the first accepted HTTP request"),
      });
      const observed = await sendThrough(entry, "A".repeat(8000), async () => {
        events.push("dispatch");
        if (requests.length > 0) {
          throw closure;
        }
      }).catch((error: unknown) => error);
      expect(events).toEqual(["dispatch", "http", "dispatch"]);
      expect(requests).toHaveLength(1);
      expect(isChannelPartialDeliveryError(observed)).toBe(true);
      if (!isChannelPartialDeliveryError(observed)) {
        throw observed;
      }
      expect(observed.deliveryResult.messageIds).toEqual(["1"]);
      const causes: Error[] = [];
      for (
        let cause: unknown = observed;
        cause instanceof Error && !causes.includes(cause);
        cause = cause.cause
      ) {
        causes.push(cause);
      }
      expect(causes).toContain(closure);
    },
  );

  it.each(["direct", "public"] as const)(
    "preserves %s media follow-up ordering and keyboard placement",
    async (entry) => {
      await sendThrough(entry, "A".repeat(9000), async () => {}, photoPath);
      expect(requests.map(({ method }) => method)).toEqual([
        "sendPhoto",
        "sendMessage",
        "sendMessage",
        "sendMessage",
      ]);
      expect(requests[0]?.fields.caption).toBeUndefined();
      expect(requests.slice(1).map(({ fields }) => String(fields.text).length)).toEqual([
        4000, 4000, 1000,
      ]);
      expect(requests.flatMap(({ fields }, index) => (fields.reply_markup ? [index] : []))).toEqual(
        [entry === "direct" ? 1 : 3],
      );
    },
  );

  it.each([
    ["direct", true],
    ["direct", false],
    ["public", true],
    ["public", false],
  ] as const)(
    "keeps %s delivery when a rendered-empty chunk comes first=%s",
    async (entry, first) => {
      const empty = "Bad Request: text must be non-empty";
      rejections.push(...(first ? [empty, empty, ""] : ["", empty, empty]));

      await sendThrough(entry, `${"A".repeat(4000)}${"B".repeat(4000)}`, async () => {});

      expect(requests.map(({ fields }) => fields.text)).toEqual(
        (first ? ["A", "A", "B"] : ["A", "B", "B"]).map((text) => text.repeat(4000)),
      );
      expect(requests.map(({ fields }) => fields.parse_mode)).toEqual(
        first ? ["HTML", undefined, "HTML"] : ["HTML", "HTML", undefined],
      );
    },
  );

  it.each(["direct", "public"] as const)(
    "preserves %s accepted media after photo rejection falls back to a document",
    async (entry) => {
      rejections.push("Bad Request: PHOTO_INVALID_DIMENSIONS");
      await sendThrough(
        entry,
        "caption",
        async () => {
          events.push("dispatch");
        },
        photoPath,
      );
      expect(requests.map(({ method }) => method)).toEqual(["sendPhoto", "sendDocument"]);
      expect(requests.map(({ fields }) => fields.caption)).toEqual(["caption", "caption"]);
      expect(events).toEqual(["dispatch", "http", "dispatch", "http"]);
    },
  );

  it.each(["direct", "public"] as const)(
    "retains %s buttons when a rich native quote is rejected",
    async (entry) => {
      rejections.push("Bad Request: quote not found");
      await sendThrough(entry, "answer", async () => {}, undefined, true);
      expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage", "sendRichMessage"]);
      expect(requests[0]?.fields.reply_parameters).toMatchObject({ message_id: 7, quote: "quote" });
      expect(requests[1]?.fields.reply_parameters).toMatchObject({ message_id: 7 });
      expect(requests[1]?.fields.reply_parameters).not.toHaveProperty("quote");
      expect(requests.map(({ fields }) => fields.reply_markup)).toEqual([
        { inline_keyboard: buttons },
        { inline_keyboard: buttons },
      ]);
    },
  );

  it("retains the observed media receipt when accepted-send bookkeeping fails", async () => {
    const error = new Error("delivery observer failed");
    const observed = await sendMessageTelegram("123", "caption", {
      cfg,
      api: bot.api,
      mediaUrl: photoPath,
      mediaLocalRoots: [mediaDir],
      messageThreadId: 42,
      onDeliveryResult: () => {
        throw error;
      },
    }).catch((failure: unknown) => failure);
    expect(requests.map(({ method }) => method)).toEqual(["sendPhoto"]);
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["1"]);
    expect(observed.deliveryResult.receipt).toMatchObject({
      threadId: "42",
      platformMessageIds: ["1"],
    });
  });

  it.each([
    new Error("delivery observer failed"),
    new Error("can't parse entities"),
    new Error("message text is empty"),
    Object.assign(new Error("Bad Request: observer failed"), { error_code: 400 }),
  ])("never resends or continues after observing an accepted message fails: %s", async (error) => {
    const observedIds: string[] = [];
    let observedError: unknown;
    try {
      await sendMessageTelegram("123", `${"A".repeat(4000)}${"B".repeat(4000)}tail`, {
        cfg,
        api: bot.api,
        textMode: "html",
        onDeliveryResult: (delivery) => {
          observedIds.push(delivery.messageId);
          if (observedIds.length === 2) {
            throw error;
          }
        },
      });
    } catch (caught) {
      observedError = caught;
    }

    expect(
      requests.map(({ method, fields }) => ({
        method,
        textPrefix: String(fields.text).slice(0, 4),
        textLength: String(fields.text).length,
        parseMode: fields.parse_mode,
      })),
    ).toEqual([
      { method: "sendMessage", textPrefix: "AAAA", textLength: 4000, parseMode: "HTML" },
      { method: "sendMessage", textPrefix: "BBBB", textLength: 4000, parseMode: "HTML" },
    ]);
    expect(observedIds).toEqual(["1", "2"]);
    expect(isChannelPartialDeliveryError(observedError)).toBe(true);
    if (!isChannelPartialDeliveryError(observedError)) {
      throw observedError;
    }
    expect(observedError.deliveryResult.messageIds).toEqual(["1", "2"]);
    expect(observedError.deliveryResult.receipt?.platformMessageIds).toEqual(["1", "2"]);
  });

  it.each([
    { required: false, revoke: false, legacy: true },
    { required: true, revoke: false, legacy: false },
    { required: false, revoke: true, legacy: false },
    { required: true, revoke: true, legacy: false },
  ])(
    "settles registered Telegram delivery and pin (required: $required, revoked: $revoke, legacy: $legacy)",
    async ({ required, revoke, legacy }) => {
      await withOpenClawTestState({ prefix: "telegram-registered-pin-" }, async () => {
        resetTelegramClientOptionsCacheForTests();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
        );
        const messageSend = telegramPlugin.message?.send;
        if (!messageSend?.text) {
          throw new Error("Telegram preferred message sender is missing");
        }
        const preferredSend = vi.spyOn(messageSend, "text");
        const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
        const revoked = new Error("Registered pin owner revoked before retry");
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw revoked;
          }
        };
        const outcome = sendDurableMessageBatch({
          cfg: {
            channels: {
              telegram: {
                botToken: `123456:registered-pin-${required}-${revoke}`,
                apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
              },
            },
          },
          channel: "telegram",
          to: "123",
          payloads: [{ text: "registered pin", delivery: { pin: { enabled: true, required } } }],
          skipQueue: true,
          ...(legacy ? {} : { assertDirectAdapterHandoff: assertCurrent }),
          onDeliveredPayload: () => {
            if (revoke) {
              requestHold = held;
              rejections.push({
                error_code: 429,
                description: "Too Many Requests: retry after 1",
                parameters: { retry_after: 1 },
              });
            }
          },
        });
        try {
          if (revoke) {
            await Promise.race([
              held.arrived.promise,
              outcome.then((result) => {
                throw new Error(`delivery settled before pin retry: ${result.status}`);
              }),
            ]);
            current = false;
            held.release.resolve();
          }
          expect(await outcome).toMatchObject({
            status: required && revoke ? "partial_failed" : "sent",
            results: [{ channel: "telegram", messageId: "1" }],
            receipt: { primaryPlatformMessageId: "1" },
            ...(required && revoke ? { sentBeforeError: true } : {}),
          });
          expect(preferredSend).toHaveBeenCalledOnce();
          expect(requests.map(({ method }) => method)).toEqual(["sendMessage", "pinChatMessage"]);
          expect(requests[1]?.fields.message_id).toBe(1);
        } finally {
          held.release.resolve();
          await outcome;
          preferredSend.mockRestore();
          resetPluginRuntimeStateForTest();
        }
      });
    },
  );
});
