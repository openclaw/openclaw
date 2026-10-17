import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import * as configMutation from "openclaw/plugin-sdk/config-mutation";
import * as cronStore from "openclaw/plugin-sdk/cron-store-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { apiThrottler } from "./bot.runtime.js";
import { telegramPlugin } from "./channel.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { sendLogger } from "./send-context.js";
import {
  createForumTopicTelegram as createTopic,
  deleteMessageTelegram,
  editForumTopicTelegram as editTopic,
  editMessageTelegram,
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
  const recordDispatch = async () => void events.push("dispatch");
  const requestOptions = () => ({ cfg, api: fixture.bot.api });
  const send = (text: string, options: Parameters<typeof sendMessageTelegram>[2] = {}) =>
    sendMessageTelegram("123", text, { ...requestOptions(), ...options });
  const edit = (text: string, options: Parameters<typeof editMessageTelegram>[3] = {}) =>
    editMessageTelegram("123", 321, text, { ...requestOptions(), ...options });
  const fieldValues = (key: string) => requests.map(({ fields }) => fields[key]);
  const expectMethods = (...methods: string[]) =>
    expect(requests.map(({ method }) => method)).toEqual(methods);
  const expectHttp = (...rows: Array<readonly [string, unknown]>) =>
    expect(requests.map(({ method, fields }) => [method, fields])).toEqual(rows);
  const fieldsContaining = expect.objectContaining;
  const expectPins = (...ids: number[]) =>
    expect(requests.map(({ method, fields }) => [method, fields.message_id])).toEqual(
      ids.map((id) => ["pinChatMessage", id]),
    );
  const configWith = <const T extends object>(overrides: T) => ({
    channels: { telegram: { ...cfg.channels.telegram, ...overrides } },
  });
  const photoOptions = () => ({
    ...requestOptions(),
    mediaUrl: fixture.photoPath,
    mediaLocalRoots: [fixture.mediaDir],
  });
  const holdRequest = () => {
    const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
    fixture.requestHold = held;
    return held;
  };
  const createAuthority = (message: string) => {
    const authority = { active: true, checks: 0, error: new Error(message) };
    return Object.assign(authority, {
      assertCurrent: () => {
        authority.checks += 1;
        if (!authority.active) {
          throw authority.error;
        }
      },
    });
  };
  const rejects = (pending: Promise<unknown>, message: string | RegExp) =>
    expect(pending).rejects.toThrow(message);
  const settlePin = (pending: Promise<void>) =>
    pending.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
  const partialDelivery = (error: unknown) => {
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    if (!isChannelPartialDeliveryError(error)) {
      throw error;
    }
    return error.deliveryResult;
  };
  afterEach(() => vi.restoreAllMocks());

  it("preserves literal code spacing in captions sent over HTTP", async () => {
    await send("````\n```\n• literal bullet\n3. literal number\n````", photoOptions());

    expectHttp([
      "sendPhoto",
      fieldsContaining({
        parse_mode: "HTML",
        caption: "<pre><code>```\n• literal bullet\n3. literal number\n</code></pre>",
      }),
    ]);
  });

  it.each(["active", "closed", "aborted"])("queued send: %s authority", async (state) => {
    const token = `123456:telegram-queue-${state}`;
    getOrCreateAccountThrottler(token, () =>
      apiThrottler({ global: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
    );
    const queuedCfg = configWith({ botToken: token });
    const held = holdRequest();
    const blocker = sendMessageTelegram("123", "queue blocker", { cfg: queuedCfg });
    await held.arrived.promise;
    const checkedBeforeQueue = createDeferred<void>();
    const controller = new AbortController();
    const authority = createAuthority("Send authority closed while queued");
    const outcome = sendMessageTelegram("123", "queued message", {
      cfg: queuedCfg,
      signal: controller.signal,
      assertPlatformSendAuthorized: () => {
        authority.assertCurrent();
        checkedBeforeQueue.resolve();
      },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await checkedBeforeQueue.promise;
      expect(fieldValues("text")).toEqual(["queue blocker"]);
      authority.active = state !== "closed";
      if (state === "aborted") {
        controller.abort();
      }
      held.release.resolve();
      await blocker;
      if (state === "active") {
        await expect(outcome).resolves.toMatchObject({ result: { messageId: "2" } });
        expect(fieldValues("text")).toEqual(["queue blocker", "queued message"]);
      } else {
        await expect(outcome).resolves.toMatchObject({
          error: state === "closed" ? authority.error : { name: "AbortError" },
        });
        expect(fieldValues("text")).toEqual(["queue blocker"]);
      }
    } finally {
      held.release.resolve();
      await Promise.allSettled([blocker, outcome]);
    }
  });

  it.each(["active", "closed"] as const)("delete action: %s authority", async (state) => {
    const revoked = new Error("Progress owner retired");
    const action = telegramPlugin.actions?.handleAction?.({
      channel: "telegram",
      action: "delete",
      params: { chatId: "123", messageId: 42 },
      cfg,
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
      expectHttp(["deleteMessage", { chat_id: "123", message_id: 42 }]);
    }
  });

  it("fences provider-owned delivery after async dispatch refresh and before HTTP", async () => {
    const authority = createAuthority("delivery authority revoked after dispatch refresh");
    const dispatch = async () => {
      await Promise.resolve();
      authority.active = false;
    };
    await expect(
      sendThrough("direct", "answer", dispatch, undefined, false, authority.assertCurrent),
    ).rejects.toBe(authority.error);
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
    const held = holdRequest();
    const authority = createAuthority("Pin authority revoked while queued");
    let authorizedChecks = 0;
    const blocker = pinThroughAdapter(token, 101);
    const deniedPin = settlePin(pinThroughAdapter(token, 102, authority.assertCurrent));
    const authorizedPin = pinThroughAdapter(token, 103, () => {
      authorizedChecks += 1;
    });
    try {
      await held.arrived.promise;
      await queued.promise;
      expect(fieldValues("message_id")).toEqual([101]);
      authority.active = false;
      held.release.resolve();
      await blocker;
      await expect(deniedPin).resolves.toEqual({ error: authority.error });
      await authorizedPin;
      expect(authorizedChecks).toBeGreaterThan(0);
      // An older caller must not inherit the rejected client's assertion.
      await pinThroughAdapter(token, 104);
      expectPins(101, 103, 104);
    } finally {
      held.release.resolve();
      await Promise.allSettled([blocker, deniedPin, authorizedPin]);
    }
  });

  it.each([
    { phase: "retry", revoke: true },
    { phase: "accepted", revoke: true },
    { phase: "misdirected", revoke: true },
    { phase: "connection", revoke: false },
    { phase: "connection", revoke: true },
  ] as const)("pin authority after $phase (revoked=$revoke)", async ({ phase, revoke }) => {
    const retry = phase === "retry",
      accepted = phase === "accepted";
    const token = `123456:pin-${phase}-${revoke}`;
    const id = retry ? 201 : accepted ? 301 : 401;
    const ready = createDeferred<void>();
    const held = retry ? undefined : holdRequest();
    if (retry) {
      getOrCreateAccountThrottler(token, () => {
        const throttle = apiThrottler({ global: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } });
        return async (prev, method, payload, signal) => {
          const response = await throttle(prev, method, payload, signal);
          if (method === "pinChatMessage" && !response.ok && response.error_code === 429) {
            ready.resolve();
          }
          return response;
        };
      });
      rejections.push({
        error_code: 429,
        description: "Too Many Requests: retry after 1",
        parameters: { retry_after: 1 },
      });
    } else if (!accepted) {
      // Each fallback control needs a fresh transport.
      resetTelegramClientOptionsCacheForTests();
      rejections.push(
        phase === "misdirected"
          ? { error_code: 421, description: "Misdirected Request" }
          : { resetConnection: true },
      );
    }
    const authority = createAuthority(`Pin authority revoked after ${phase}`);
    const pending = pinThroughAdapter(token, id, authority.assertCurrent);
    const outcome = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      const arrived = held?.arrived.promise ?? ready.promise;
      await Promise.race([
        arrived,
        outcome.then(() => {
          throw new Error("pin settled before its response boundary");
        }),
      ]);
      if (retry) {
        // Let grammY consume the response and enter its existing real retry sleep.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fieldValues("message_id")).toEqual([201]);
      }
      const checksAtAcceptance = authority.checks;
      if (accepted) {
        expect(checksAtAcceptance).toBeGreaterThan(0);
      }
      authority.active = !revoke;
      held?.release.resolve();
      expect(await outcome).toEqual(
        !accepted && revoke ? { error: authority.error } : { result: undefined },
      );
      if (accepted) {
        expect(authority.checks).toBe(checksAtAcceptance);
      }
      expectPins(...Array<number>(accepted || revoke ? 1 : 2).fill(id));
    } finally {
      held?.release.resolve();
      await Promise.allSettled([pending, outcome]);
    }
  });

  it.each([false, true])("quote fallback: rich=%s", async (rich) => {
    rejections.push("Bad Request: quote not found");
    if (!rich) {
      rejections.push("Bad Request: can't parse entities");
    }
    await sendThrough("public", "answer", recordDispatch, undefined, rich);
    expect(events).toEqual(
      rich
        ? ["dispatch", "http", "dispatch", "http"]
        : ["dispatch", "http", "dispatch", "http", "dispatch", "http"],
    );
    expect(requests).toHaveLength(rich ? 2 : 3);
    expect(requests[0]?.fields.reply_parameters).toMatchObject({ message_id: 7, quote: "quote" });
    if (rich) {
      expectMethods("sendRichMessage", "sendRichMessage");
      expect(requests[1]?.fields.reply_parameters).toMatchObject({ message_id: 7 });
      expect(requests[1]?.fields.reply_parameters).not.toHaveProperty("quote");
      expect(fieldValues("reply_markup")).toEqual([
        { inline_keyboard: buttons },
        { inline_keyboard: buttons },
      ]);
    } else {
      expect(requests[1]?.fields.reply_to_message_id).toBe(7);
      expect(requests[2]?.fields.parse_mode).toBeUndefined();
    }
  });

  it("retains accepted IDs when the next direct callback rejects closure", async () => {
    const closure = new PlatformMessageNotDispatchedError("delivery owner closed", {
      cause: new Error("fixture authority closed after the first accepted HTTP request"),
    });
    const observed = await sendThrough("direct", "A".repeat(8000), async () => {
      events.push("dispatch");
      if (requests.length > 0) {
        throw closure;
      }
    }).catch((error: unknown) => error);
    expect(events).toEqual(["dispatch", "http", "dispatch"]);
    expect(requests).toHaveLength(1);
    expect(partialDelivery(observed).messageIds).toEqual(["1"]);
    const causes: Error[] = [];
    for (
      let cause: unknown = observed;
      cause instanceof Error && !causes.includes(cause);
      cause = cause.cause
    ) {
      causes.push(cause);
    }
    expect(causes).toContain(closure);
  });

  it.each(["direct", "public"] as const)("%s media ordering and keyboard", async (entry) => {
    await sendThrough(entry, "A".repeat(9000), async () => {}, fixture.photoPath);
    expectMethods("sendPhoto", "sendMessage", "sendMessage", "sendMessage");
    expect(requests[0]?.fields.caption).toBeUndefined();
    expect(requests.slice(1).map(({ fields }) => String(fields.text).length)).toEqual([
      4000, 4000, 1000,
    ]);
    expect(requests.flatMap(({ fields }, index) => (fields.reply_markup ? [index] : []))).toEqual([
      entry === "direct" ? 1 : 3,
    ]);
  });

  it("delivers later chunks after a rendered-empty first chunk", async () => {
    const empty = "Bad Request: text must be non-empty";
    rejections.push(empty, empty, "");

    await sendThrough("direct", `${"A".repeat(4000)}${"B".repeat(4000)}`, async () => {});

    expect(fieldValues("text")).toEqual(["A", "A", "B"].map((text) => text.repeat(4000)));
    expect(fieldValues("parse_mode")).toEqual(["HTML", undefined, "HTML"]);
  });

  it("preserves accepted media after photo rejection falls back to a document", async () => {
    rejections.push("Bad Request: PHOTO_INVALID_DIMENSIONS");
    const result = await sendThrough("public", "caption", recordDispatch, fixture.photoPath);
    expectMethods("sendPhoto", "sendDocument");
    expect(fieldValues("caption")).toEqual(["caption", "caption"]);
    expect(events).toEqual(["dispatch", "http", "dispatch", "http"]);
    expect(result).toMatchObject({ messageId: "2" });
  });

  it("never resends or continues after an observer throws a recoverable-looking error", async () => {
    const error = new Error("can't parse entities");
    const observedIds: string[] = [];
    const observedError: unknown = await send(`${"A".repeat(4000)}${"B".repeat(4000)}tail`, {
      textMode: "html",
      onDeliveryResult: (delivery) => {
        observedIds.push(delivery.messageId);
        if (observedIds.length === 2) {
          throw error;
        }
      },
    }).catch((caught: unknown) => caught);

    expect(
      requests.map(({ method, fields }) => [
        method,
        String(fields.text).slice(0, 4),
        String(fields.text).length,
        fields.parse_mode,
      ]),
    ).toEqual([
      ["sendMessage", "AAAA", 4000, "HTML"],
      ["sendMessage", "BBBB", 4000, "HTML"],
    ]);
    expect(observedIds).toEqual(["1", "2"]);
    const delivery = partialDelivery(observedError);
    expect(delivery.messageIds).toEqual(["1", "2"]);
    expect(delivery.receipt?.platformMessageIds).toEqual(["1", "2"]);
  });

  it.each([true, false])("registered pin: legacy=%s", async (legacy) => {
    await withOpenClawTestState({ prefix: "telegram-registered-pin-" }, async () => {
      resetTelegramClientOptionsCacheForTests();
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
      const required = !legacy;
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      const authority = createAuthority("Registered pin owner revoked before retry");
      const common = {
        cfg: configWith({ botToken: `123456:registered-pin-${required}-${required}` }),
        channel: "telegram" as const,
        skipQueue: true,
      };
      const to = "group:-1001:topic:77",
        text = "registered pin";
      const pin = { enabled: true, notify: true };
      const outcome = legacy
        ? telegramPlugin.actions!.handleAction!({
            ...common,
            action: "send",
            params: { to, message: text, delivery: { pin } },
          })
        : sendDurableMessageBatch({
            ...common,
            to,
            payloads: [{ text, delivery: { pin: { ...pin, required } } }],
            assertDirectAdapterHandoff: authority.assertCurrent,
            onDeliveredPayload: () => {
              fixture.requestHold = held;
              rejections.push({
                error_code: 429,
                description: "Too Many Requests: retry after 1",
                parameters: { retry_after: 1 },
              });
            },
          });
      try {
        if (!legacy) {
          await Promise.race([
            held.arrived.promise,
            outcome.then(() => {
              throw new Error("delivery settled before pin retry");
            }),
          ]);
          authority.active = false;
          held.release.resolve();
        }
        expect(await outcome).toMatchObject(
          legacy
            ? { details: { ok: true, messageId: "1" } }
            : {
                status: "partial_failed",
                results: [{ channel: "telegram", messageId: "1" }],
                receipt: { primaryPlatformMessageId: "1" },
                sentBeforeError: true,
              },
        );
        expectHttp(
          ["sendMessage", expect.objectContaining({ chat_id: "-1001", message_thread_id: 77 })],
          [
            "pinChatMessage",
            fieldsContaining({
              chat_id: "-1001",
              message_id: 1,
              disable_notification: false,
            }),
          ],
        );
      } finally {
        held.release.resolve();
        await outcome;
        resetPluginRuntimeStateForTest();
      }
    });
  });

  it("uses canonical endpoint roots when resolving legacy targets", async () => {
    fixture.responseFor = (method) =>
      method === "getChat" ? { id: -100123, type: "supergroup", title: "Resolved" } : undefined;
    await sendMessageTelegram("https://t.me/fixture", "Resolved destination", {
      gatewayClientScopes: ["operator.write"],
      cfg,
    });
    expect(fixture.endpoints).toEqual(
      ["getChat", "sendMessage"].map((method) => `/bot${cfg.channels.telegram.botToken}/${method}`),
    );
    expect(fieldValues("chat_id")).toEqual(["@fixture", "-100123"]);
  });

  it("resolves topic-qualified mutations to the base chat while preserving reaction variants", async () => {
    fixture.responseFor = (method) =>
      method === "getChat" ? { id: -100123, type: "supergroup", title: "Resolved" } : undefined;
    const opts = { ...requestOptions(), gatewayClientScopes: ["operator.write"] };
    await reactMessageTelegram("@fixture:topic:77", 321, "❤️‍🔥", opts);
    await reactMessageTelegram("telegram:group:-100123:topic:77", 321, "5231419410191111111", opts);
    await reactMessageTelegram("-100123:topic:77", 321, "❤️", { ...opts, remove: true });
    await pinMessageTelegram("-100123:topic:77", 321, opts);
    await unpinMessageTelegram("-100123:topic:77", undefined, opts);
    await deleteMessageTelegram("-100123:topic:77", 321, opts);
    const expected = (method: string, fields: Record<string, unknown> = {}) =>
      [method, { chat_id: "-100123", ...fields }] as const;
    const reaction = (value: unknown[]) =>
      expected("setMessageReaction", { message_id: 321, reaction: value });
    expectHttp(
      ["getChat", { chat_id: "@fixture" }],
      reaction([{ type: "emoji", emoji: "❤‍🔥" }]),
      reaction([{ type: "custom_emoji", custom_emoji_id: "5231419410191111111" }]),
      reaction([]),
      expected("pinChatMessage", { message_id: 321, disable_notification: true }),
      expected("unpinChatMessage"),
      expected("deleteMessage", { message_id: 321 }),
    );
  });

  it("reports a benign MESSAGE_DELETE_FORBIDDEN refusal without retrying", async () => {
    rejections.push("Bad Request: MESSAGE_DELETE_FORBIDDEN");
    const deleting = deleteMessageTelegram("123", 321, requestOptions());
    await expect(deleting).resolves.toMatchObject({
      ok: false,
      warning: expect.stringContaining("MESSAGE_DELETE_FORBIDDEN"),
    });
    expectMethods("deleteMessage");
  });

  it("preserves captured forum-topic authority after awaited target preparation", async () => {
    const authority = createAuthority("Platform request authority revoked");
    const options = {
      ...requestOptions(),
      assertPlatformSendAuthorized: authority.assertCurrent,
    };
    fixture.responseFor = (method) => {
      if (method !== "getChat") {
        return undefined;
      }
      authority.active = false;
      options.assertPlatformSendAuthorized = () => {};
      return { id: -100123, type: "supergroup", title: "Resolved" };
    };
    await rejects(
      createTopic("@platformbound", "Bound topic", options),
      "Platform request authority revoked",
    );
    expectHttp(["getChat", { chat_id: "@platformbound" }]);
  });

  it("validates forum names by code points rather than UTF-16 length", async () => {
    const opts = requestOptions();
    const name = "😀".repeat(128);
    const topic = { chat_id: "-100123", message_thread_id: 77 };
    const create = (value: string, to = "-100123") => createTopic(to, value, opts);
    const change = (options: Parameters<typeof editTopic>[2]) =>
      editTopic("-100123", 77, { ...opts, ...options });
    await create(name, "telegram:group:-100123:topic:77");
    await change({ name, iconCustomEmojiId: " 123 " });
    await sendTypingTelegram("-100123:topic:77", opts);
    expectHttp(
      ["createForumTopic", { chat_id: topic.chat_id, name }],
      ["editForumTopic", { ...topic, name, icon_custom_emoji_id: "123" }],
      ["sendChatAction", { ...topic, action: "typing" }],
    );
    for (const invalid of [" ", "😀".repeat(129), "👨‍👩‍👧‍👦".repeat(19)]) {
      await rejects(create(invalid), /required|128/);
      await rejects(change({ name: invalid }), /required|128/);
    }
    await rejects(change({}), /requires/);
    await rejects(change({ iconCustomEmojiId: " " }), /required/);
    await rejects(sendStickerTelegram("123", " ", opts), /file_id is required/);
    await rejects(deleteMessageTelegram("123", "321abc", opts), /Message id/);
    await rejects(
      sendLocationTelegram("123", { latitude: 1, longitude: 2, name: "Missing address" }, opts),
      /require both/,
    );
    expect(requests).toHaveLength(3);
  });

  it("uses the Telegram poll option and duration boundaries without sending invalid polls", async () => {
    const poll = {
      question: " Ready? ",
      options: Array.from({ length: 12 }, (_, index) => `Option ${index}`),
    };
    for (const durationSeconds of [5, 604800]) {
      await sendPollTelegram("123", { ...poll, durationSeconds }, requestOptions());
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
      await rejects(sendPollTelegram("123", { ...poll, ...invalid }, requestOptions()), /duration/);
    }
    expect(requests).toHaveLength(2);
  });

  it.each([
    { gatewayClientScopes: undefined },
    { gatewayClientScopes: ["operator.write"] },
    { gatewayClientScopes: ["operator.admin"] },
  ])("writeback: $gatewayClientScopes", async ({ gatewayClientScopes }) => {
    const read = vi
      .spyOn(configMutation, "readConfigFileSnapshotForWrite")
      .mockRejectedValue(new Error("isolated persistence boundary unavailable"));
    vi.spyOn(cronStore, "loadCronStore").mockResolvedValue({ version: 1, jobs: [] });
    fixture.responseFor = (method) =>
      method === "getChat" ? { id: 123, type: "private" } : undefined;
    await sendMessageTelegram("@fixture", "Delivered regardless of writeback permission", {
      ...requestOptions(),
      gatewayClientScopes,
    });
    expect(read).toHaveBeenCalledTimes(
      gatewayClientScopes === undefined || gatewayClientScopes.includes("operator.admin") ? 1 : 0,
    );
    expectMethods("getChat", "sendMessage");
  });

  it("keeps private captions and media paths out of logs", async () => {
    const info = vi.spyOn(sendLogger, "info");
    const text = "private outbound payload";
    await sendMessageTelegram("123:topic:77", text, photoOptions());
    const logs = info.mock.calls.map(([message]) => message).join("\n");
    expect(logs).not.toContain(text);
    expect(logs).not.toContain(fixture.photoPath);
  });

  it("encodes interactive destinations without leaking invalid or competing actions", async () => {
    await send("Choose", {
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
      ...requestOptions(),
      replyToMessageId: Number.NaN,
    });
    expect(requests[1]).toEqual({
      method: "sendSticker",
      fields: { chat_id: "123", sticker: "file-id" },
    });
  });

  it("rejects a malformed accepted poll response without fabricating a message identity", async () => {
    fixture.responseFor = () => ({
      chat: { id: 123, type: "private" },
      poll: { id: "malformed" },
    });
    const sending = sendPollTelegram(
      "123",
      { question: "Ready?", options: ["Yes", "No"] },
      requestOptions(),
    );
    await rejects(sending, /returned no message_id/);
    expectMethods("sendPoll");
  });

  describe("edit recovery", () => {
    afterEach(resetGlobalHookRunner);
    it.each(["caption", "auto"] as const)("%s rich list caption", async (editMode) => {
      if (editMode === "auto") {
        rejections.push("Bad Request: there is no text in the message to edit");
      }
      await edit("<ul><li>First</li><li>Second</li></ul><aside>Note</aside>", {
        editMode,
      });
      expect(requests.at(-1)).toMatchObject({
        method: "editMessageCaption",
        fields: { caption: "• First\n• Second\n<blockquote>Note</blockquote>" },
      });
    });

    it("keeps a markup-heavy caption edit within the limit after an HTML rejection", async () => {
      rejections.push("Bad Request: can't parse entities");
      await edit(`**${"x".repeat(1024)}**`, {
        editMode: "caption",
      });
      expectMethods("editMessageCaption", "editMessageCaption");
      expect(fieldValues("caption")).toEqual([`<b>${"x".repeat(1024)}</b>`, "x".repeat(1024)]);
      expect(requests[1]?.fields.parse_mode).toBeUndefined();
    });

    it("edits the existing caption when Telegram reports no text to edit", async () => {
      rejections.push("Bad Request: there is no text in the message to edit");
      await edit("<b>visible</b>", {
        cfg: configWith({ richMessages: false, linkPreview: false }),
        textMode: "html",
        editMode: "auto",
        buttons: [],
      });
      expectMethods("editMessageText", "editMessageCaption");
      expect(requests.map(({ fields }) => fields.text ?? fields.caption)).toEqual([
        "<b>visible</b>",
        "<b>visible</b>",
      ]);
      for (const { fields } of requests) {
        expect(fields.message_id).toBe(321);
        expect(fields.reply_markup).toEqual({ inline_keyboard: [] });
      }
    });

    it.each([
      { count: 501, list: false },
      { count: 251, list: true },
    ])("keeps every item in a $count-block rich edit (list: $list)", async ({ count, list }) => {
      const tokens = Array.from(
        { length: count },
        (_, index) => `P${String(index).padStart(3, "0")}`,
      );
      const text = tokens.map((token) => `${list ? "- " : ""}${token}`).join(list ? "\n" : "\n\n");
      rejections.push("Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY");
      await edit(text, {
        cfg: configWith({ richMessages: true }),
      });
      expectMethods("editMessageText", "editMessageText");
      expect(JSON.stringify(requests.at(-1)!.fields).match(/P\d{3}/g)).toEqual(tokens);
      expect(requests.every(({ fields }) => fields.reply_markup === undefined)).toBe(true);
    });

    it.each([undefined, true])("account preview override: %s", async (linkPreview) => {
      rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
      await edit("**Read** https://example.com", {
        cfg: configWith({
          richMessages: true,
          linkPreview: true,
          accounts: { worker: { linkPreview: false } },
        }),
        accountId: "worker",
        token: cfg.channels.telegram.botToken,
        linkPreview,
      });
      expect(fieldValues("link_preview_options")).toEqual(
        Array(2).fill(linkPreview === true ? undefined : { is_disabled: true }),
      );
    });

    it("keeps styled HTML link labels on rich edit fallback and rejects oversized replacement atomically", async () => {
      const richCfg = configWith({ richMessages: true });
      rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
      await edit(
        '<details><summary>More</summary><p><a href="https://example.com">**Download**</a></p></details>',
        { cfg: richCfg },
      );
      expect(JSON.stringify(requests[0]!.fields.rich_message)).toContain(
        '"url":"https://example.com"',
      );
      expect(requests[1]!.fields.text).toBe("More\nDownload");
      rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID", "Bad Request: message is too long");
      const text = `START${"x".repeat(4100)}END`;
      await rejects(edit(text, { cfg: richCfg }), "message is too long");
      expect(requests.slice(2).map(({ method }) => method)).toEqual([
        "editMessageText",
        "editMessageText",
      ]);
      expect(requests.at(-1)!.fields.text).toBe(text);
    });
  });

  it("preserves indented code through the shared payload path in newline mode", async () => {
    const first = "A".repeat(128);
    const second = "B".repeat(128);
    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: configWith({
          richMessages: false,
          textChunkLimit: 512,
          streaming: { chunkMode: "length" },
        }),
        to: "123",
        text: "",
        payload: { text: `    ${first}\n\n    ${second}` },
        formatting: { textLimit: 256, chunkMode: "newline" },
        deps: { sendTelegram: sendMessageTelegram },
      },
      adapter: telegramOutbound,
    });

    const chunks = fixture.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ fields }) => {
        expect(fields.parse_mode).toBe("HTML");
        if (typeof fields.text !== "string") {
          throw new Error("Expected a string Telegram sendMessage text");
        }
        return fields.text;
      });
    const code = chunks.map((html) => {
      expect(html.length).toBeLessThanOrEqual(256);
      expect(html).toMatch(/^<pre><code>[\s\S]+<\/code><\/pre>$/u);
      return html.slice("<pre><code>".length, -"</code></pre>".length);
    });
    expect(code.join("")).toBe(`${first}\n\n${second}\n`);
  });
});
