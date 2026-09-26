import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  sanitizeForPlainText,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import * as configMutation from "openclaw/plugin-sdk/config-mutation";
import * as cronStore from "openclaw/plugin-sdk/cron-store-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { apiThrottler } from "./bot.runtime.js";
import { telegramPlugin } from "./channel.js";
import { sendLogger } from "./send-context.js";
import {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  resetTelegramClientOptionsCacheForTests,
  sendLocationTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
  sendTypingTelegram,
  unpinMessageTelegram,
} from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram physical send acceptance over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, events, rejections, buttons, sendThrough, pinThroughAdapter } = fixture;
  let bot: typeof fixture.bot;
  let mediaDir: string;
  let photoPath: string;
  beforeEach(() => {
    ({ bot, mediaDir, photoPath } = fixture);
  });
  afterEach(() => vi.restoreAllMocks());

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
            apiRoot: cfg.channels.telegram.apiRoot,
          },
        },
      };
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      fixture.requestHold = held;
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
              apiRoot: cfg.channels.telegram.apiRoot,
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
    fixture.requestHold = held;
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
    fixture.requestHold = held;
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
      fixture.requestHold = held;
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
      const result = await sendThrough(
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
      expect(result).toMatchObject(
        entry === "public" ? { messageId: "2" } : { receipt: { platformMessageIds: ["2"] } },
      );
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
        const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
        const revoked = new Error("Registered pin owner revoked before retry");
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw revoked;
          }
        };
        const pinCfg = {
          channels: {
            telegram: {
              botToken: `123456:registered-pin-${required}-${revoke}`,
              apiRoot: cfg.channels.telegram.apiRoot,
            },
          },
        };
        const outcome = legacy
          ? telegramPlugin.actions!.handleAction!({
              channel: "telegram",
              action: "send",
              cfg: pinCfg,
              skipQueue: true,
              params: {
                to: "group:-1001:topic:77",
                message: "registered pin",
                delivery: { pin: { enabled: true, notify: true } },
              },
            })
          : sendDurableMessageBatch({
              cfg: pinCfg,
              channel: "telegram",
              to: "group:-1001:topic:77",
              payloads: [
                {
                  text: "registered pin",
                  delivery: { pin: { enabled: true, required, notify: true } },
                },
              ],
              skipQueue: true,
              assertDirectAdapterHandoff: assertCurrent,
              onDeliveredPayload: () => {
                if (revoke) {
                  fixture.requestHold = held;
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
              outcome.then(() => {
                throw new Error("delivery settled before pin retry");
              }),
            ]);
            current = false;
            held.release.resolve();
          }
          if (legacy) {
            expect(await outcome).toMatchObject({ details: { ok: true, messageId: "1" } });
          } else {
            expect(await outcome).toMatchObject({
              status: required && revoke ? "partial_failed" : "sent",
              results: [{ channel: "telegram", messageId: "1" }],
              receipt: { primaryPlatformMessageId: "1" },
              ...(required && revoke ? { sentBeforeError: true } : {}),
            });
          }
          expect(requests.map(({ method }) => method)).toEqual(["sendMessage", "pinChatMessage"]);
          expect(requests[0]?.fields).toMatchObject({ chat_id: "-1001", message_thread_id: 77 });
          expect(requests[1]?.fields).toMatchObject({
            chat_id: "-1001",
            message_id: 1,
            disable_notification: false,
          });
        } finally {
          held.release.resolve();
          await outcome;
          resetPluginRuntimeStateForTest();
        }
      });
    },
  );

  it("normalizes endpoint roots and legacy targets before sending", async () => {
    fixture.responseFor = (method) =>
      method === "getChat" ? { id: -100123, type: "supergroup", title: "Resolved" } : undefined;
    await sendMessageTelegram("https://t.me/fixture", "Resolved destination", {
      gatewayClientScopes: ["operator.write"],
      cfg: {
        channels: {
          telegram: {
            botToken: cfg.channels.telegram.botToken,
            apiRoot: `${cfg.channels.telegram.apiRoot}/bot${cfg.channels.telegram.botToken}/`,
          },
        },
      },
    });
    expect(fixture.endpoints).toEqual(
      ["getChat", "sendMessage"].map((method) => `/bot${cfg.channels.telegram.botToken}/${method}`),
    );
    expect(requests.map(({ fields }) => fields.chat_id)).toEqual(["@fixture", "-100123"]);
  });

  it("resolves topic-qualified mutations to the base chat while preserving reaction variants", async () => {
    fixture.responseFor = (method) =>
      method === "getChat" ? { id: -100123, type: "supergroup", title: "Resolved" } : undefined;
    const opts = { cfg, api: bot.api, gatewayClientScopes: ["operator.write"] };
    await reactMessageTelegram("@fixture:topic:77", 321, "❤️‍🔥", opts);
    await reactMessageTelegram("telegram:group:-100123:topic:77", 321, "5231419410191111111", opts);
    await reactMessageTelegram("-100123:topic:77", 321, "❤️", { ...opts, remove: true });
    await pinMessageTelegram("-100123:topic:77", 321, opts);
    await unpinMessageTelegram("-100123:topic:77", undefined, opts);
    await deleteMessageTelegram("-100123:topic:77", 321, opts);
    expect(requests).toEqual([
      { method: "getChat", fields: { chat_id: "@fixture" } },
      {
        method: "setMessageReaction",
        fields: {
          chat_id: "-100123",
          message_id: 321,
          reaction: [{ type: "emoji", emoji: "❤‍🔥" }],
        },
      },
      {
        method: "setMessageReaction",
        fields: {
          chat_id: "-100123",
          message_id: 321,
          reaction: [{ type: "custom_emoji", custom_emoji_id: "5231419410191111111" }],
        },
      },
      {
        method: "setMessageReaction",
        fields: { chat_id: "-100123", message_id: 321, reaction: [] },
      },
      {
        method: "pinChatMessage",
        fields: { chat_id: "-100123", message_id: 321, disable_notification: true },
      },
      { method: "unpinChatMessage", fields: { chat_id: "-100123" } },
      { method: "deleteMessage", fields: { chat_id: "-100123", message_id: 321 } },
    ]);
  });

  it.each(["message to delete not found", "MESSAGE_DELETE_FORBIDDEN", "CHAT_WRITE_FORBIDDEN"])(
    "distinguishes a benign delete refusal from %s",
    async (description) => {
      rejections.push(`Bad Request: ${description}`);
      const deleting = deleteMessageTelegram("123", 321, { cfg, api: bot.api });
      if (description === "CHAT_WRITE_FORBIDDEN") {
        await expect(deleting).rejects.toThrow(description);
      } else {
        await expect(deleting).resolves.toMatchObject({
          ok: false,
          warning: expect.stringContaining(description),
        });
      }
      expect(requests.map(({ method }) => method)).toEqual(["deleteMessage"]);
    },
  );

  it("preserves captured forum-topic authority after awaited target preparation", async () => {
    let platformCurrent = true;
    const options = {
      cfg,
      api: bot.api,
      assertPlatformSendAuthorized: () => {
        if (!platformCurrent) {
          throw new Error("Platform request authority revoked");
        }
      },
    };
    fixture.responseFor = (method) => {
      if (method !== "getChat") {
        return undefined;
      }
      platformCurrent = false;
      options.assertPlatformSendAuthorized = () => {};
      return { id: -100123, type: "supergroup", title: "Resolved" };
    };
    await expect(
      createForumTopicTelegram("@platformbound", "Bound topic", options),
    ).rejects.toThrow("Platform request authority revoked");
    expect(requests).toEqual([{ method: "getChat", fields: { chat_id: "@platformbound" } }]);
  });

  it("validates forum names by code points rather than UTF-16 length", async () => {
    const opts = { cfg, api: bot.api };
    const name = "😀".repeat(128);
    await createForumTopicTelegram("telegram:group:-100123:topic:77", name, opts);
    await editForumTopicTelegram("-100123", 77, { ...opts, name, iconCustomEmojiId: " 123 " });
    await sendTypingTelegram("-100123:topic:77", opts);
    expect(requests.map(({ method }) => method)).toEqual([
      "createForumTopic",
      "editForumTopic",
      "sendChatAction",
    ]);
    expect(requests[0]!.fields).toEqual({ chat_id: "-100123", name });
    expect(requests[1]!.fields).toEqual({
      chat_id: "-100123",
      message_thread_id: 77,
      name,
      icon_custom_emoji_id: "123",
    });
    expect(requests[2]!.fields).toEqual({
      chat_id: "-100123",
      message_thread_id: 77,
      action: "typing",
    });
    for (const invalid of [" ", "😀".repeat(129), "👨‍👩‍👧‍👦".repeat(19)]) {
      await expect(createForumTopicTelegram("-100123", invalid, opts)).rejects.toThrow(
        /required|128/,
      );
      await expect(
        editForumTopicTelegram("-100123", 77, { ...opts, name: invalid }),
      ).rejects.toThrow(/required|128/);
    }
    await expect(editForumTopicTelegram("-100123", 77, opts)).rejects.toThrow(/requires/);
    await expect(
      editForumTopicTelegram("-100123", 77, { ...opts, iconCustomEmojiId: " " }),
    ).rejects.toThrow(/required/);
    await expect(sendStickerTelegram("123", " ", opts)).rejects.toThrow(/file_id is required/);
    await expect(deleteMessageTelegram("123", "321abc", opts)).rejects.toThrow(/Message id/);
    await expect(
      sendLocationTelegram("123", { latitude: 1, longitude: 2, name: "Missing address" }, opts),
    ).rejects.toThrow(/require both/);
    expect(requests).toHaveLength(3);
  });

  it("uses the Telegram poll option and duration boundaries without sending invalid polls", async () => {
    const poll = {
      question: " Ready? ",
      options: Array.from({ length: 12 }, (_, index) => `Option ${index}`),
    };
    for (const durationSeconds of [5, 604800]) {
      await sendPollTelegram("123", { ...poll, durationSeconds }, { cfg, api: bot.api });
    }
    expect(
      requests.map(({ fields }) => [fields.question, fields.options, fields.open_period]),
    ).toEqual([
      ["Ready?", poll.options.map((text) => ({ text })), 5],
      ["Ready?", poll.options.map((text) => ({ text })), 604800],
    ]);
    for (const invalid of [
      { durationSeconds: 4 },
      { durationSeconds: 604801 },
      { durationHours: 1 },
    ]) {
      await expect(
        sendPollTelegram("123", { ...poll, ...invalid }, { cfg, api: bot.api }),
      ).rejects.toThrow(/duration/);
    }
    expect(requests).toHaveLength(2);
  });

  it.each([undefined, [], ["operator.write"], ["operator.admin"]])(
    "reaches target persistence only for internal or admin send authority (%j)",
    async (gatewayClientScopes) => {
      const read = vi
        .spyOn(configMutation, "readConfigFileSnapshotForWrite")
        .mockRejectedValue(new Error("isolated persistence boundary unavailable"));
      vi.spyOn(cronStore, "loadCronStore").mockResolvedValue({ version: 1, jobs: [] });
      fixture.responseFor = (method) =>
        method === "getChat" ? { id: 123, type: "private" } : undefined;
      await sendMessageTelegram("@fixture", "Delivered regardless of writeback permission", {
        cfg,
        api: bot.api,
        gatewayClientScopes,
      });
      expect(read).toHaveBeenCalledTimes(
        gatewayClientScopes === undefined || gatewayClientScopes.includes("operator.admin") ? 1 : 0,
      );
      expect(requests.map(({ method }) => method)).toEqual(["getChat", "sendMessage"]);
    },
  );

  it.each(["text", "media", "rejected"] as const)(
    "keeps private content out of %s success logging",
    async (kind) => {
      const info = vi.spyOn(sendLogger, "info");
      const text = "private outbound payload";
      if (kind === "rejected") {
        rejections.push("Bad Request: message thread not found");
      }
      const sending = sendMessageTelegram("123:topic:77", text, {
        cfg,
        api: bot.api,
        ...(kind === "media" ? { mediaUrl: photoPath, mediaLocalRoots: [mediaDir] } : {}),
      });
      if (kind === "rejected") {
        await expect(sending).rejects.toThrow("message thread not found");
      } else {
        await sending;
      }
      const logs = info.mock.calls.map(([message]) => message).join("\n");
      expect(logs.includes("outbound send ok")).toBe(kind !== "rejected");
      expect(logs).not.toContain(text);
      expect(logs).not.toContain(photoPath);
    },
  );

  it("encodes interactive destinations without leaking invalid or competing actions", async () => {
    await sendMessageTelegram("123", "Choose", {
      cfg,
      api: bot.api,
      buttons: [
        [
          { text: "Open", callback_data: "ignored", url: "https://example.com", style: "primary" },
          { text: "Launch", web_app: { url: "https://example.com/app" } },
          { text: "", callback_data: "invalid" },
        ],
        [{ text: "Choose", callback_data: "env|prod" }],
      ],
    });
    expect(requests[0]!.fields.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Open", url: "https://example.com", style: "primary" },
          { text: "Launch", web_app: { url: "https://example.com/app" } },
        ],
        [{ text: "Choose", callback_data: "env|prod" }],
      ],
    });
    await sendStickerTelegram("123", " file-id ", {
      cfg,
      api: bot.api,
      replyToMessageId: Number.NaN,
    });
    expect(requests[1]).toEqual({
      method: "sendSticker",
      fields: { chat_id: "123", sticker: "file-id" },
    });
  });

  it.each(["text", "poll"] as const)(
    "rejects a malformed accepted %s response without fabricating a message identity",
    async (kind) => {
      fixture.responseFor = () => ({
        chat: { id: 123, type: "private" },
        poll: { id: "malformed" },
      });
      const sending =
        kind === "text"
          ? sendMessageTelegram("123", "Hello", { cfg, api: bot.api })
          : sendPollTelegram(
              "123",
              { question: "Ready?", options: ["Yes", "No"] },
              { cfg, api: bot.api },
            );
      await expect(sending).rejects.toThrow(/returned no message_id/);
      expect(requests.map(({ method }) => method)).toEqual([
        kind === "text" ? "sendMessage" : "sendPoll",
      ]);
    },
  );
});
