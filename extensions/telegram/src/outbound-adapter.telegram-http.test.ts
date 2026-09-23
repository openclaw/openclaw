import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  addTestHook,
  initializeGlobalHookRunner,
  readQueuedDeliveryEntriesForTest,
  resetGlobalHookRunner,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverReplies } from "./bot/delivery.js";
import { telegramPlugin } from "./channel.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "./send.telegram-http.test-support.js";
import { getTopicName, resolveTopicNameCacheScope } from "./topic-name-cache.js";

describe("Telegram registered adapter conformance over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, endpoints, rejections, runtime, telegramOutbound } = fixture;
  let bot: typeof fixture.bot;
  let mediaDir: string;
  let photoPath: string;
  beforeEach(() => {
    ({ bot, mediaDir, photoPath } = fixture);
  });

  it.each([
    { name: "rich", richMessages: true, html: false },
    { name: "explicit HTML on rich", richMessages: true, html: true },
    { name: "plain", richMessages: false, html: false },
  ])(
    "delivers complete registered $name presentations through the selected account",
    async ({ richMessages, html }) => {
      await telegramPlugin.message!.send!.payload!({
        cfg: {
          channels: {
            telegram: {
              ...cfg.channels.telegram,
              richMessages: !richMessages,
              linkPreview: false,
              accounts: { selected: { botToken: cfg.channels.telegram.botToken, richMessages } },
            },
          },
        },
        accountId: "selected",
        to: "123",
        text: "",
        ...(html ? { formatting: { parseMode: "HTML" as const } } : {}),
        payload: {
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Total"],
                rows: [["Acme", 12]],
              },
              {
                type: "buttons",
                buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
              },
            ],
          },
        },
      });
      expect(requests.map(({ method }) => method)).toEqual([
        richMessages && !html ? "sendRichMessage" : "sendMessage",
      ]);
      const fields = requests[0]!.fields;
      if (richMessages && !html) {
        expect(fields.rich_message).toMatchObject({
          skip_entity_detection: true,
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              cells: [
                [
                  { text: "Account", is_header: true },
                  { text: "Total", is_header: true },
                ],
                [{ text: "Acme" }, { text: "12" }],
              ],
            },
          ],
        });
      } else {
        expect(fields.text).toContain("Pipeline");
        expect(fields.text).toContain("Account: Acme");
        expect(fields.text).toContain("Total: 12");
        expect(fields.text).not.toContain("<table");
        expect(fields.link_preview_options).toEqual({ is_disabled: true });
      }
      expect(fields.reply_markup).toEqual({
        inline_keyboard: [[{ text: "Continue", callback_data: "tgcmd:/continue" }]],
      });
    },
  );

  it("delivers registered message payloads with host-owned media custody", async () => {
    await withOpenClawTestState({ prefix: "telegram-registered-media-" }, async () => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
      const selectedCfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "123456:wrong-account",
            apiRoot: "http://127.0.0.1:1",
            accounts: {
              media: { botToken: "654321:host-media", apiRoot: cfg.channels.telegram.apiRoot },
            },
          },
        },
      };
      const bytes = Buffer.concat([await fs.readFile(photoPath), Buffer.from("host-owned-media")]);
      const mediaAccess = {
        localRoots: [mediaDir],
        workspaceDir: mediaDir,
        readFile: async () => bytes,
      };
      try {
        await telegramPlugin.actions!.handleAction!({
          channel: "telegram",
          action: "send",
          cfg: selectedCfg,
          accountId: "media",
          skipQueue: true,
          params: {
            to: "123",
            message: "host caption",
            mediaUrl: photoPath,
            replyToMessageId: 888,
            threadId: 77,
            silent: true,
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Continue",
                      action: { type: "command", command: "/continue" },
                      style: "primary",
                    },
                    {
                      label: "Allow Always",
                      action: {
                        type: "command",
                        command:
                          "/approve plugin:123e4567-e89b-12d3-a456-426614174000 allow-always",
                      },
                    },
                    {
                      label: "Launch",
                      web_app: { url: "https://example.com/app" },
                      style: "success",
                    },
                  ],
                },
              ],
            },
            mediaAccess: {
              localRoots: ["/model"],
              readFile: async () => Buffer.from("model-owned"),
            },
          },
          mediaAccess,
          mediaReadFile: async () => Buffer.from("legacy-owned"),
        });
        const legacyBytes = Buffer.concat([
          await fs.readFile(photoPath),
          Buffer.from("legacy-host-media"),
        ]);
        await telegramPlugin.actions!.handleAction!({
          channel: "telegram",
          action: "send",
          cfg: selectedCfg,
          accountId: "media",
          skipQueue: true,
          params: { to: "123", message: "legacy caption", mediaUrl: photoPath },
          mediaLocalRoots: [mediaDir],
          mediaReadFile: async () => legacyBytes,
        });
        const result = await telegramPlugin.message!.send!.payload!({
          cfg: selectedCfg,
          accountId: "media",
          to: "123",
          text: "album caption",
          payload: {
            text: "album caption",
            mediaUrls: ["", photoPath, "", path.join(mediaDir, "second.png")],
            channelData: { telegram: { quoteText: "quoted caption" } },
          },
          mediaAccess,
          threadId: "77",
          replyToId: "888",
          replyToIdSource: "implicit",
          replyToMode: "first",
          silent: true,
        });
        expect(requests.map(({ method }) => method)).toEqual([
          "sendPhoto",
          "sendPhoto",
          "sendMediaGroup",
        ]);
        expect(endpoints).toEqual([
          "/bot654321:host-media/sendPhoto",
          "/bot654321:host-media/sendPhoto",
          "/bot654321:host-media/sendMediaGroup",
        ]);
        const resolveUpload = (fields: Record<string, unknown>, reference: unknown) => {
          const upload =
            typeof reference === "string" && reference.startsWith("attach://")
              ? fields[reference.slice("attach://".length)]
              : reference;
          if (!(upload instanceof File)) {
            throw new Error(`Expected Telegram multipart file for ${String(reference)}`);
          }
          return upload;
        };
        const photo = resolveUpload(requests[0]!.fields, requests[0]!.fields.photo);
        expect(photo.name).toBe("pixel.png");
        expect(Buffer.from(await photo.arrayBuffer())).toEqual(bytes);
        expect(requests[0]!.fields).toMatchObject({
          reply_to_message_id: "888",
          message_thread_id: "77",
          disable_notification: "true",
        });
        expect(JSON.parse(String(requests[0]!.fields.reply_markup))).toEqual({
          inline_keyboard: [
            [
              { text: "Continue", callback_data: "tgcmd:/continue", style: "primary" },
              {
                text: "Allow Always",
                callback_data: "/approve plugin:123e4567-e89b-12d3-a456-426614174000 always",
              },
              { text: "Launch", web_app: { url: "https://example.com/app" }, style: "success" },
            ],
          ],
        });
        const legacyPhoto = resolveUpload(requests[1]!.fields, requests[1]!.fields.photo);
        expect(legacyPhoto.name).toBe("pixel.png");
        expect(Buffer.from(await legacyPhoto.arrayBuffer())).toEqual(legacyBytes);
        const album = requests[2]!.fields;
        expect(album.message_thread_id).toBe("77");
        expect(album.disable_notification).toBe("true");
        expect(JSON.parse(String(album.reply_parameters))).toMatchObject({ message_id: 888 });
        const media = JSON.parse(String(album.media)) as Array<{ media: string; caption?: string }>;
        expect(media.map((part) => part.caption ?? null)).toEqual(["album caption", null]);
        const uploads = media.map((part) => resolveUpload(album, part.media));
        expect(uploads.map((file) => file.name)).toEqual(["pixel.png", "second.png"]);
        for (const upload of uploads) {
          expect(Buffer.from(await upload.arrayBuffer())).toEqual(bytes);
        }
        expect(result.receipt.platformMessageIds).toEqual(["1001", "1002"]);
        expect(result.receipt.primaryPlatformMessageId).toBe("1001");
        expect(result.receipt.parts.map((part) => [part.platformMessageId, part.kind])).toEqual([
          ["1001", "media"],
          ["1002", "media"],
        ]);
      } finally {
        resetPluginRuntimeStateForTest();
      }
    });
  });

  it.each(["answer", ""])("reacts to the nested target before delivering %j", async (text) => {
    await telegramOutbound.sendPayload!({
      cfg,
      to: "123",
      text,
      replyToId: "888",
      payload: { text, channelData: { telegram: { reaction: { emoji: "👍", replyToId: "777" } } } },
    });
    expect(requests.map(({ method }) => method)).toEqual(
      text ? ["setMessageReaction", "sendMessage"] : ["setMessageReaction"],
    );
    expect(requests[0]!.fields).toMatchObject({
      message_id: 777,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    if (text) {
      expect(requests[1]!.fields).toMatchObject({ text: "answer", reply_to_message_id: 888 });
    }
  });

  it.each([0, -1, 12.5, Number.MAX_SAFE_INTEGER + 1, "invalid"])(
    "rejects invalid nested reaction target %s without borrowing the text reply",
    async (replyToId) => {
      await expect(
        telegramOutbound.sendPayload!({
          cfg,
          to: "123",
          text: "answer",
          replyToId: "888",
          payload: {
            text: "answer",
            mediaUrl: photoPath,
            channelData: { telegram: { reaction: { emoji: "👍", replyToId } } },
          },
        }),
      ).rejects.toThrow(/reply target/);
      expect(requests).toEqual([]);
    },
  );

  it.each(["adapter", "stream"] as const)(
    "stops %s visible delivery after Telegram rejects its reaction",
    async (entry) => {
      rejections.push("Bad Request: REACTION_INVALID");
      const payload = {
        text: "must not send",
        mediaUrl: photoPath,
        replyToId: "888",
        channelData: { telegram: { reaction: { emoji: "👍", replyToId: "777" } } },
      };
      if (entry === "adapter") {
        await expect(
          telegramOutbound.sendPayload!({ cfg, to: "123", text: payload.text, payload }),
        ).rejects.toThrow(/Reaction unavailable/);
      } else {
        await expect(
          deliverReplies({
            cfg,
            bot,
            runtime,
            chatId: "123",
            token: cfg.channels.telegram.botToken,
            replies: [payload],
            replyToMode: "all",
            textLimit: 4000,
          }),
        ).resolves.toMatchObject({ delivered: false });
      }
      expect(requests.map(({ method }) => method)).toEqual(["setMessageReaction"]);
    },
  );

  it.each(["revoked", "aborted"] as const)(
    "fences the adapter reaction prelude when dispatch is %s",
    async (state) => {
      const controller = new AbortController();
      const revoked = new Error("reaction authority revoked");
      let active = true;
      await expect(
        telegramOutbound.sendPayload!({
          cfg,
          to: "123",
          text: "must not send",
          payload: {
            text: "must not send",
            mediaUrl: photoPath,
            channelData: { telegram: { reaction: { emoji: "👍", replyToId: "777" } } },
          },
          signal: controller.signal,
          onPlatformSendDispatch: async () => {
            await Promise.resolve();
            if (state === "aborted") {
              controller.abort(revoked);
            } else {
              active = false;
            }
          },
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw revoked;
            }
          },
        }),
      ).rejects.toBe(revoked);
      expect(requests).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps the native reply on the location after its origin marker (venue: %s)",
    async (venue) => {
      await telegramPlugin.message!.send!.payload!({
        cfg,
        to: "123",
        text: "[origin: another conversation]",
        replyToId: "888",
        payload: {
          text: "[origin: another conversation]",
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            ...(venue ? { name: "  Eiffel Tower ", address: " Champ de Mars " } : { accuracy: 5 }),
          },
          channelData: { telegram: { quoteText: "exact quote" } },
        },
      });
      expect(requests.map(({ method }) => method)).toEqual([
        "sendMessage",
        venue ? "sendVenue" : "sendLocation",
      ]);
      expect(requests[0]!.fields.text).toBe("[origin: another conversation]");
      expect(requests[0]!.fields.reply_parameters).toBeUndefined();
      expect(requests[0]!.fields.reply_to_message_id).toBeUndefined();
      expect(requests[1]!.fields).toMatchObject({
        latitude: 48.858844,
        longitude: 2.294351,
        reply_parameters: { message_id: 888, quote: "exact quote" },
        ...(venue
          ? { title: "Eiffel Tower", address: "Champ de Mars" }
          : { horizontal_accuracy: 5 }),
      });
    },
  );

  it("routes a registered poll through a legacy topic destination", async () => {
    const result = await telegramOutbound.sendPoll!({
      cfg,
      to: "telegram:group:-1001:topic:77",
      poll: { question: "Ready?", options: ["Yes", "No"] },
      isAnonymous: true,
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendPoll"]);
    expect(requests[0]!.fields).toMatchObject({
      chat_id: "-1001",
      message_thread_id: 77,
      question: "Ready?",
      is_anonymous: true,
    });
    expect(result.pollId).toBe("http-poll");
  });

  it.each([
    { name: "nested with threading off", text: "answer", mode: "off", nested: 777, target: 777 },
    {
      name: "nested with a separate text reply",
      text: "answer",
      mode: "all",
      nested: "777",
      target: 777,
    },
    { name: "outer reaction-only", text: "", mode: "all", nested: undefined, target: 888 },
  ] as const)(
    "delivers streamed $name reactions without stealing reply intent",
    async ({ text, mode, nested, target }) => {
      const result = await deliverReplies({
        cfg,
        bot,
        runtime,
        chatId: "123",
        token: cfg.channels.telegram.botToken,
        replies: [
          {
            text,
            replyToId: "888",
            channelData: { telegram: { reaction: { emoji: "👍", replyToId: nested } } },
          },
        ],
        replyToMode: mode,
        textLimit: 4000,
      });
      expect(result.delivered).toBe(true);
      expect(requests.map(({ method }) => method)).toEqual(
        text ? ["setMessageReaction", "sendMessage"] : ["setMessageReaction"],
      );
      expect(requests[0]!.fields).toMatchObject({
        message_id: target,
        reaction: [{ type: "emoji", emoji: "👍" }],
      });
      if (text) {
        expect(requests[1]!.fields.reply_to_message_id).toBe(mode === "all" ? 888 : undefined);
        expect(requests[1]!.fields.text).toBe("answer");
      }
    },
  );

  it.each([
    { name: "invalid explicit target", nested: "0", mode: "all" },
    { name: "implicit target with threading disabled", nested: undefined, mode: "off" },
  ] as const)("does not deliver a streamed reaction with $name", async ({ nested, mode }) => {
    const result = await deliverReplies({
      cfg,
      bot,
      runtime,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      replies: [
        {
          text: "must not send",
          replyToId: "888",
          channelData: { telegram: { reaction: { emoji: "👍", replyToId: nested } } },
        },
      ],
      replyToMode: mode,
      textLimit: 4000,
    });
    expect(result.delivered).toBe(false);
    expect(requests).toEqual([]);
  });
  describe("registered durable action delivery", () => {
    let state: OpenClawTestState;
    let actionCfg: OpenClawConfig;
    const action = (
      name: ChannelMessageActionContext["action"],
      params: Record<string, unknown>,
      options: Partial<ChannelMessageActionContext> = {},
    ) =>
      telegramPlugin.actions!.handleAction!({
        channel: "telegram",
        action: name,
        params,
        cfg: actionCfg,
        conversationReadOrigin: "direct-operator",
        ...options,
      });
    beforeEach(async () => {
      state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "telegram-action-delivery-",
      });
      actionCfg = {
        ...cfg,
        channels: { telegram: { ...cfg.channels.telegram } },
        session: { store: path.join(state.stateDir, "{agentId}", "sessions.json") },
      };
      setTelegramPluginStateRuntimeForTests();
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
    });
    afterEach(async () => {
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
      resetTelegramTopicNameCacheForTest();
      clearTelegramRuntimeForTest();
      await state.cleanup();
    });

    it("commits the registered action before HTTP and returns its actual reply receipt", async () => {
      let queued: unknown;
      const result = await action(
        "send",
        {
          to: "-1001:topic:77",
          message: "durable answer",
          quoteText: " \nquoted text  ",
        },
        {
          sessionKey: "agent:main:telegram:group:-1001:topic:77",
          reply: { replyToId: "456", source: "implicit", mode: "first" },
          onPlatformSendDispatch: async () => {
            expect(requests).toEqual([]);
            queued = readQueuedDeliveryEntriesForTest(state.stateDir);
          },
        },
      );
      expect(queued).toMatchObject([{ channel: "telegram", to: "-1001:topic:77", retryCount: 0 }]);
      expect(requests).toEqual([
        {
          method: "sendMessage",
          fields: expect.objectContaining({
            chat_id: "-1001",
            message_thread_id: 77,
            text: "durable answer",
            reply_parameters: expect.objectContaining({
              message_id: 456,
              quote: " \nquoted text  ",
            }),
          }),
        },
      ]);
      expect(result.details).toMatchObject({
        ok: true,
        messageId: "1",
        chatId: "-1001",
        receipt: { threadId: "77", replyToId: "456" },
      });
      expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);
    });

    it.each([undefined, "caller"] as const)(
      "leaves exactly one retry owner after a proven pre-dispatch failure (%s)",
      async (deliveryRetryOwner) => {
        let committed = false;
        await expect(
          action(
            "send",
            { to: "123", message: "must retry once" },
            {
              deliveryRetryOwner,
              onPlatformSendDispatch: async () => {
                committed = readQueuedDeliveryEntriesForTest(state.stateDir).length === 1;
                throw new PlatformMessageNotDispatchedError("authority revoked before dispatch", {
                  cause: new Error("temporary handoff unavailable"),
                  retryable: true,
                });
              },
            },
          ),
        ).rejects.toThrow("authority revoked before dispatch");
        expect(committed).toBe(true);
        expect(requests).toEqual([]);
        const entries = readQueuedDeliveryEntriesForTest(state.stateDir);
        if (deliveryRetryOwner === "caller") {
          expect(entries).toEqual([]);
        } else {
          expect(entries).toMatchObject([
            {
              retryCount: 1,
              lastError: expect.stringContaining("authority revoked before dispatch"),
            },
          ]);
        }
      },
    );

    it("returns bounded cancellation rather than fake delivery or hook diagnostics", async () => {
      const registry = createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
      ]);
      addTestHook({
        registry,
        pluginId: "cancel",
        hookName: "message_sending",
        handler: () => ({ cancel: true, cancelReason: "private-hook-diagnostics" }),
      });
      initializeGlobalHookRunner(registry);
      const result = await action("send", { to: "123", message: "cancel me" });
      expect(result.details).toEqual({
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
      });
      expect(JSON.stringify(result)).not.toContain("private-hook-diagnostics");
      expect(requests).toEqual([]);
      expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);
    });

    it("renders supplemental data and exact callback values with a visible degradation result", async () => {
      const result = await action(
        "send",
        {
          to: "tg:123",
          message: "Quarterly results",
          presentation: {
            blocks: [
              { type: "text", text: "Do not duplicate this block" },
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1"],
                series: [{ name: "USD", values: [12] }],
              },
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Total"],
                rows: [["Acme", 12]],
              },
              {
                type: "buttons",
                buttons: [
                  { label: "Deploy", value: "env|prod" },
                  { label: "Copy manually", value: "x".repeat(65) },
                ],
              },
            ],
          },
        },
        { skipQueue: true },
      );
      const text = String(requests[0]!.fields.text);
      for (const content of [
        "Quarterly results",
        "Revenue",
        "USD",
        "Q1: 12",
        "Pipeline",
        "Account: Acme",
        "Total: 12",
        "Copy manually",
      ]) {
        expect(text).toContain(content);
      }
      expect(text).not.toContain("Do not duplicate this block");
      expect(requests[0]!.fields.reply_markup).toEqual({
        inline_keyboard: [[{ text: "Deploy", callback_data: "env|prod" }]],
      });
      expect(result.details).toMatchObject({
        ok: true,
        degradedDelivery: {
          droppedControls: 1,
          fallback: "text",
          reasons: ["callback_data_too_long"],
        },
      });
    });

    it("keeps degraded locations standalone and makes unencodable edits recoverable", async () => {
      const dropped = {
        blocks: [{ type: "buttons", buttons: [{ label: "Copy manually", value: "x".repeat(65) }] }],
      };
      await action(
        "send",
        {
          to: "123",
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            name: " Eiffel Tower ",
            address: " Champ de Mars ",
          },
          presentation: dropped,
        },
        { skipQueue: true },
      );
      expect(requests.map(({ method }) => method)).toEqual(["sendMessage", "sendVenue"]);
      expect(requests[0]!.fields.text).toContain("Copy manually");
      expect(requests[1]!.fields).toMatchObject({
        title: "Eiffel Tower",
        address: "Champ de Mars",
      });
      const rejected = await action("edit", { chatId: "123", messageId: 1, presentation: dropped });
      expect(rejected.details).toMatchObject({
        ok: false,
        degradedDelivery: { fallback: "not_delivered" },
      });
      expect(requests).toHaveLength(2);
      const edited = await action("edit", {
        chatId: "123",
        messageId: 1,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", value: "env|prod" }, ...dropped.blocks[0]!.buttons],
            },
          ],
        },
      });
      expect(requests[2]).toEqual({
        method: "editMessageReplyMarkup",
        fields: {
          chat_id: "123",
          message_id: 1,
          reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "env|prod" }]] },
        },
      });
      expect(edited.details).toMatchObject({
        ok: true,
        degradedDelivery: { fallback: "not_delivered" },
      });
    });

    it.each([
      { to: "-1001:topic:271", threadId: 77, target: "-1001:topic:77" },
      { to: "-1001:topic:271", threadId: 1, target: "-1001:topic:1" },
      { to: "123:topic:7", threadId: 11, target: "123:topic:11" },
      { to: "-1001:77", threadId: undefined, target: "-1001:topic:77" },
    ])(
      "acknowledges only the delivered room-event surface $target",
      async ({ to, threadId, target }) => {
        const acknowledgements: string[] = [];
        const ends = [
          telegramInboundEventDelivery.begin(
            "action-session",
            {
              outboundTo: target,
              markInboundEventDelivered: () => {
                acknowledgements.push("room");
              },
            },
            { inboundEventKind: "room_event" },
          ),
          telegramInboundEventDelivery.begin("action-session", {
            outboundTo: target,
            markInboundEventDelivered: () => {
              acknowledgements.push("user");
            },
          }),
        ];
        try {
          await action(
            "send",
            { to, threadId, message: "room answer" },
            { skipQueue: true, sessionKey: "action-session", inboundEventKind: "room_event" },
          );
          expect(requests.map(({ method }) => method)).toEqual(["sendMessage"]);
          expect(requests[0]!.fields.message_thread_id).toBe(
            threadId === 1 ? undefined : (threadId ?? 77),
          );
          expect(acknowledgements).toEqual(["room"]);
        } finally {
          ends.forEach((end) => end());
        }
      },
    );

    it("uploads all action attachment aliases instead of echoing their paths", async () => {
      const firstBytes = await fs.readFile(photoPath);
      const secondBytes = Buffer.concat([firstBytes, Buffer.from("second-attachment")]);
      const secondPath = path.join(state.stateDir, "second.png");
      await fs.writeFile(secondPath, secondBytes);
      await action(
        "send",
        {
          to: "123",
          message: "album",
          attachments: [{ path: photoPath }, { filePath: secondPath }],
        },
        { skipQueue: true, mediaLocalRoots: [mediaDir, state.stateDir] },
      );
      expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup"]);
      const fields = requests[0]!.fields;
      const media = JSON.parse(String(fields.media)) as Array<{ media: string }>;
      const uploads = await Promise.all(
        media.map(async (part) => {
          const file = fields[part.media.slice("attach://".length)];
          expect(file).toBeInstanceOf(File);
          return Buffer.from(await (file as File).arrayBuffer());
        }),
      );
      expect(uploads).toEqual([firstBytes, secondBytes]);
    });

    it("sends a real video note while rejecting photos and forced documents", async () => {
      const notePath = path.join(state.stateDir, "note.mp4");
      const video = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
      await fs.writeFile(notePath, video);
      const options = { skipQueue: true, mediaLocalRoots: [state.stateDir, mediaDir] };
      for (const params of [{ mediaUrl: photoPath }, { mediaUrl: notePath, forceDocument: true }]) {
        await expect(
          action("send", { to: "123", asVideoNote: true, ...params }, options),
        ).rejects.toThrow("Telegram video notes require video media.");
      }
      expect(requests).toEqual([]);
      await action("send", { to: "123", mediaUrl: notePath, asVideoNote: true }, options);
      expect(requests.map(({ method }) => method)).toEqual(["sendVideoNote"]);
      const upload = resolveTelegramTestUpload(requests[0]!.fields, "video_note");
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(video);
    });

    it("accepts external poll and sticker aliases on the requested topic", async () => {
      actionCfg.channels!.telegram!.actions = { sticker: true };
      actionCfg.channels!.telegram!.groupPolicy = "disabled";
      let delivered = 0;
      const event = {
        outboundTo: "-1001:topic:77",
        markInboundEventDelivered: () => {
          delivered += 1;
        },
      };
      let end = telegramInboundEventDelivery.begin("action-session", event, {
        inboundEventKind: "room_event",
      });
      try {
        const options: Partial<ChannelMessageActionContext> = {
          sessionKey: "action-session",
          inboundEventKind: "room_event",
        };
        const poll = await action(
          "poll",
          {
            to: "-1001",
            pollQuestion: "Ready?",
            pollOption: ["Yes", "No"],
            pollMulti: "true",
            pollPublic: "true",
            pollDurationSeconds: 60,
            replyTo: 55,
            threadId: 77,
            silent: "true",
          },
          options,
        );
        expect(delivered).toBe(1);
        end();
        end = telegramInboundEventDelivery.begin("action-session", event, {
          inboundEventKind: "room_event",
        });
        await action(
          "sticker",
          {
            target: "-1001",
            stickerId: ["sticker"],
            replyToMessageId: null,
            replyTo: 9,
            messageThreadId: null,
            threadId: 77,
          },
          options,
        );
        expect(delivered).toBe(2);
        expect(requests.map(({ method }) => method)).toEqual(["sendPoll", "sendSticker"]);
        expect(requests[0]!.fields).toMatchObject({
          question: "Ready?",
          is_anonymous: false,
          allows_multiple_answers: true,
          open_period: 60,
          reply_to_message_id: 55,
          message_thread_id: 77,
          disable_notification: true,
        });
        expect(requests[1]!.fields).toMatchObject({
          sticker: "sticker",
          reply_to_message_id: 9,
          message_thread_id: 77,
        });
        expect(poll.details).toMatchObject({
          pollAnswerRouting: "unavailable",
          warning: expect.stringMatching(/inbound messages are disabled/),
        });
      } finally {
        end();
      }
    });

    it("persists forum names from real topic responses in the routed account store", async () => {
      actionCfg.agents = { ownership: "explicit", entries: { main: {}, ops: {} } };
      actionCfg.bindings = [{ agentId: "ops", match: { channel: "telegram", accountId: "work" } }];
      actionCfg.channels!.telegram!.accounts = { work: { botToken: "654321:topic-owner" } };
      actionCfg.channels!.telegram!.actions = { createForumTopic: true, editForumTopic: true };
      fixture.responseFor = (method) =>
        method === "createForumTopic"
          ? { message_thread_id: 99, name: "Primary", icon_color: 7322096 }
          : undefined;
      await action(
        "topic-create",
        { chatId: "-1001", name: "Primary", threadName: "Alias" },
        { accountId: "work" },
      );
      await action(
        "topic-edit",
        { chatId: "-1001", threadId: 99, threadName: "Renamed" },
        { accountId: "work" },
      );
      await action(
        "topic-edit",
        { chatId: "-1001", threadId: 99, iconCustomEmojiId: "5231419410191111111" },
        { accountId: "work" },
      );
      expect(requests.map(({ method }) => method)).toEqual([
        "createForumTopic",
        "editForumTopic",
        "editForumTopic",
      ]);
      expect(requests[0]!.fields.name).toBe("Primary");
      expect(requests[2]!.fields).toMatchObject({
        message_thread_id: 99,
        icon_custom_emoji_id: "5231419410191111111",
      });
      resetTelegramTopicNameCacheForTest();
      await expect(
        getTopicName(
          "-1001",
          99,
          resolveTopicNameCacheScope(
            resolveStorePath(actionCfg.session?.store, { agentId: "ops" }),
          ),
        ),
      ).resolves.toBe("Renamed");
      await expect(
        getTopicName(
          "-1001",
          99,
          resolveTopicNameCacheScope(
            resolveStorePath(actionCfg.session?.store, { agentId: "main" }),
          ),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
