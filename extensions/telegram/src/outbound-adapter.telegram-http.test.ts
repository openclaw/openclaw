import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { MessagePresentationButton } from "openclaw/plugin-sdk/interactive-runtime";
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
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { apiThrottler } from "./bot.runtime.js";
import { deliverReplies } from "./bot/delivery.js";
import { telegramPlugin } from "./channel.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "./send.telegram-http.test-support.js";
import { getTopicName } from "./topic-name-cache.js";

const buttonPresentation = (...buttons: MessagePresentationButton[]) => ({
  blocks: [{ type: "buttons" as const, buttons }],
});
const continueButton: MessagePresentationButton = {
  label: "Continue",
  action: { type: "command", command: "/continue" },
};
const pipelineTable = {
  type: "table" as const,
  caption: "Pipeline",
  headers: ["Account", "Total"],
  rows: [["Acme", 12]],
};
const replyMarkup = (...buttons: Array<Record<string, unknown>>) => ({
  inline_keyboard: [buttons],
});
const telegramRegistry = () =>
  createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]);
const approveId = "plugin:123e4567-e89b-12d3-a456-426614174000";
const location = { latitude: 48.858844, longitude: 2.294351 };
const droppedButton = () => ({ label: "Copy manually", value: "x".repeat(65) });
const uploadBytes = async (fields: Record<string, unknown>, key: string) =>
  Buffer.from(await resolveTelegramTestUpload(fields, key).arrayBuffer());

describe("Telegram registered adapter conformance over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, endpoints, rejections, runtime, telegramOutbound } = fixture;
  const expectMethods = (...methods: string[]) =>
    expect(requests.map(({ method }) => method)).toEqual(methods);
  const requestFields = (index = 0) => requests[index]!.fields;
  const expectFields = (expected: Record<string, unknown>, index = 0) =>
    expect(requestFields(index)).toMatchObject(expected);
  type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
  const accountConfig = (
    name: string,
    account: NonNullable<TelegramConfig["accounts"]>[string],
    defaults: TelegramConfig = {},
  ): OpenClawConfig => ({ channels: { telegram: { ...defaults, accounts: { [name]: account } } } });
  const registeredSend = telegramPlugin.message!.send!.payload!;
  type PayloadOptions = Parameters<typeof registeredSend>[0];
  const sendPayload = (
    body: PayloadOptions["payload"],
    options: Partial<Omit<PayloadOptions, "payload">> = {},
  ) => registeredSend({ cfg, to: "123", text: body.text ?? "", payload: body, ...options });
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
  const send = (
    params: Record<string, unknown>,
    options: Partial<ChannelMessageActionContext> = {},
  ) => action("send", { to: "123", ...params }, { skipQueue: true, ...options });
  let bot: typeof fixture.bot;
  let mediaDir: string;
  let photoPath: string;
  beforeEach(() => {
    actionCfg = cfg;
    ({ bot, mediaDir, photoPath } = fixture);
    resetTelegramAccountThrottlersForTest();
    const { botToken } = cfg.channels.telegram;
    // Conformance keeps real scheduling without Telegram's wall-clock pacing.
    for (const token of [botToken, "654321:host-media", "654321:topic-owner"]) {
      getOrCreateAccountThrottler(token, () =>
        apiThrottler({ global: {}, group: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
      );
    }
  });
  afterEach(resetTelegramAccountThrottlersForTest);

  it("rejects ambiguous account ownership before dispatch and sends with an explicit owner", async () => {
    const ownerCfg: OpenClawConfig = {
      ...cfg,
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
    };
    const request = {
      cfg: ownerCfg,
      accountId: "default",
      to: "123",
      text: "Owner routing control",
      payload: { text: "Owner routing control" },
    };
    await expect(registeredSend(request)).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable: false,
      message: expect.stringContaining("no explicit owner"),
    });
    expect(requests).toEqual([]);

    ownerCfg.bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }];
    await registeredSend(request);
    expectMethods("sendMessage");
    expect(requests[0]!.fields.text).toBe("Owner routing control");
  });

  it.each([false, true])(
    "delivers selected-account rich presentations with explicit HTML=%s",
    async (html) => {
      await sendPayload(
        { presentation: { blocks: [pipelineTable, ...buttonPresentation(continueButton).blocks] } },
        {
          cfg: accountConfig(
            "selected",
            { botToken: cfg.channels.telegram.botToken, richMessages: true },
            { ...cfg.channels.telegram, richMessages: false, linkPreview: false },
          ),
          accountId: "selected",
          ...(html ? { formatting: { parseMode: "HTML" as const } } : {}),
        },
      );
      expectMethods(html ? "sendMessage" : "sendRichMessage");
      const fields = requests[0]!.fields;
      if (!html) {
        expect(fields.rich_message).toMatchObject({
          skip_entity_detection: true,
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              cells: [
                ["Account", "Total"].map((text) => ({ text, is_header: true })),
                ["Acme", "12"].map((text) => ({ text })),
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
      expect(fields.reply_markup).toEqual(
        replyMarkup({ text: "Continue", callback_data: "tgcmd:/continue" }),
      );
    },
  );

  it.each(["host", "legacy", "album"])("keeps %s media under host custody", async (mode) => {
    await withOpenClawTestState({ prefix: "telegram-registered-media-" }, async () => {
      setActivePluginRegistry(telegramRegistry());
      const selectedCfg = accountConfig(
        "media",
        { botToken: "654321:host-media", apiRoot: cfg.channels.telegram.apiRoot },
        { botToken: "123456:wrong-account", apiRoot: "http://127.0.0.1:1" },
      );
      const bytes = Buffer.concat([await fs.readFile(photoPath), Buffer.from("host-custody")]);
      const mediaAccess = {
        localRoots: [mediaDir],
        workspaceDir: mediaDir,
        readFile: async () => bytes,
      };
      try {
        if (mode === "album") {
          const result = await sendPayload(
            {
              text: "album caption",
              mediaUrls: ["", photoPath, "", path.join(mediaDir, "second.png")],
              channelData: { telegram: { quoteText: "quoted caption" } },
            },
            {
              cfg: selectedCfg,
              accountId: "media",
              mediaAccess,
              threadId: "77",
              replyToId: "888",
              replyToIdSource: "implicit",
              replyToMode: "first",
              silent: true,
            },
          );
          expectMethods("sendMediaGroup");
          const fields = requests[0]!.fields;
          expect(fields).toMatchObject({ message_thread_id: "77", disable_notification: "true" });
          expect(JSON.parse(String(fields.reply_parameters))).toMatchObject({ message_id: 888 });
          const media = JSON.parse(String(fields.media)) as Array<{
            media: string;
            caption?: string;
          }>;
          expect(media.map((part) => part.caption ?? null)).toEqual(["album caption", null]);
          const uploads = media.map((part) =>
            resolveTelegramTestUpload({ ...fields, part: part.media }, "part"),
          );
          expect(uploads.map((file) => file.name)).toEqual(["pixel.png", "second.png"]);
          for (const upload of uploads) {
            expect(Buffer.from(await upload.arrayBuffer())).toEqual(bytes);
          }
          expect(result.receipt).toMatchObject({
            platformMessageIds: ["1001", "1002"],
            primaryPlatformMessageId: "1001",
          });
          expect(result.receipt.parts.map((part) => [part.platformMessageId, part.kind])).toEqual([
            ["1001", "media"],
            ["1002", "media"],
          ]);
        } else {
          const host = mode === "host";
          await send(
            {
              message: host ? "host caption" : "legacy caption",
              mediaUrl: photoPath,
              ...(host
                ? {
                    replyToMessageId: 888,
                    threadId: 77,
                    silent: true,
                    presentation: buttonPresentation(
                      { ...continueButton, style: "primary" },
                      {
                        label: "Allow Always",
                        action: { type: "command", command: `/approve ${approveId} allow-always` },
                      },
                      {
                        label: "Launch",
                        web_app: { url: "https://example.com/app" },
                        style: "success",
                      },
                    ),
                    mediaAccess: {
                      localRoots: ["/model"],
                      readFile: async () => Buffer.from("model"),
                    },
                  }
                : {}),
            },
            {
              cfg: selectedCfg,
              conversationReadOrigin: undefined,
              accountId: "media",
              ...(host
                ? { mediaAccess, mediaReadFile: async () => Buffer.from("legacy-owned") }
                : { mediaLocalRoots: [mediaDir], mediaReadFile: async () => bytes }),
            },
          );
          expectMethods("sendPhoto");
          const fields = requests[0]!.fields;
          const photo = resolveTelegramTestUpload(fields, "photo");
          expect(photo.name).toBe("pixel.png");
          expect(Buffer.from(await photo.arrayBuffer())).toEqual(bytes);
          if (host) {
            expect(fields).toMatchObject({
              reply_to_message_id: "888",
              message_thread_id: "77",
              disable_notification: "true",
            });
            expect(JSON.parse(String(fields.reply_markup))).toEqual(
              replyMarkup(
                { text: "Continue", callback_data: "tgcmd:/continue", style: "primary" },
                { text: "Allow Always", callback_data: `/approve ${approveId} always` },
                { text: "Launch", web_app: { url: "https://example.com/app" }, style: "success" },
              ),
            );
          }
        }
        expect(endpoints).toEqual([
          `/bot654321:host-media/${mode === "album" ? "sendMediaGroup" : "sendPhoto"}`,
        ]);
      } finally {
        resetPluginRuntimeStateForTest();
      }
    });
  });

  type ReactionCase = [
    entry: "adapter" | "stream",
    text: string,
    nested: number | string | undefined,
    target: number | undefined,
    mode: "off" | "all",
    failure: "target" | "api" | undefined,
    media: boolean,
  ];
  it.each<ReactionCase>([
    ["adapter", "answer", "777", 777, "all", undefined, false],
    ["adapter", "", "777", 777, "all", undefined, false],
    ["adapter", "answer", "invalid", undefined, "all", "target", true],
    ["adapter", "must not send", "777", undefined, "all", "api", true],
    ["stream", "must not send", "777", undefined, "all", "api", true],
    ["stream", "answer", 777, 777, "off", undefined, false],
    ["stream", "answer", "777", 777, "all", undefined, false],
    ["stream", "", undefined, 888, "all", undefined, false],
    ["stream", "must not send", "0", undefined, "all", "target", false],
  ])(
    "delivers %s reaction text=%j nested=%s target=%s mode=%s failure=%s media=%s",
    async (entry, text, nested, target, mode, failure, media) => {
      if (failure === "api") {
        rejections.push("Bad Request: REACTION_INVALID");
      }
      const payload = {
        text,
        ...(media ? { mediaUrl: photoPath } : {}),
        ...(entry === "stream" || failure === "api" ? { replyToId: "888" } : {}),
        channelData: { telegram: { reaction: { emoji: "👍", replyToId: nested } } },
      };
      if (entry === "adapter") {
        const delivery = telegramOutbound.sendPayload!({
          cfg,
          to: "123",
          text,
          ...(failure === "api" ? {} : { replyToId: "888" }),
          payload,
        });
        if (failure) {
          await expect(delivery).rejects.toThrow(
            failure === "target" ? /reply target/ : /Reaction unavailable/,
          );
        } else {
          await delivery;
        }
      } else {
        const result = await deliverReplies({
          cfg,
          bot,
          runtime,
          chatId: "123",
          token: cfg.channels.telegram.botToken,
          replies: [payload],
          replyToMode: mode,
          textLimit: 4000,
        });
        expect(result.delivered).toBe(!failure);
      }
      if (failure) {
        expect(requests.map(({ method }) => method)).toEqual(
          failure === "api" ? ["setMessageReaction"] : [],
        );
      } else {
        expect(requests.map(({ method }) => method)).toEqual(
          text ? ["setMessageReaction", "sendMessage"] : ["setMessageReaction"],
        );
        expectFields({ message_id: target, reaction: [{ type: "emoji", emoji: "👍" }] });
        if (text) {
          expect(requests[1]!.fields).toMatchObject({ text: "answer" });
          expect(requests[1]!.fields.reply_to_message_id).toBe(mode === "all" ? 888 : undefined);
        }
      }
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

  it("keeps the native reply on the location after its origin marker", async () => {
    await sendPayload(
      {
        text: "[origin: another conversation]",
        location: { ...location, accuracy: 5 },
        channelData: { telegram: { quoteText: "exact quote" } },
      },
      { replyToId: "888" },
    );
    expectMethods("sendMessage", "sendLocation");
    expect(requests[0]!.fields.text).toBe("[origin: another conversation]");
    expect(requests[0]!.fields.reply_parameters).toBeUndefined();
    expect(requests[0]!.fields.reply_to_message_id).toBeUndefined();
    expectFields(
      {
        ...location,
        reply_parameters: { message_id: 888, quote: "exact quote" },
        horizontal_accuracy: 5,
      },
      1,
    );
  });

  it("routes a registered poll through a legacy topic destination", async () => {
    const result = await telegramOutbound.sendPoll!({
      cfg,
      to: "telegram:group:-1001:topic:77",
      poll: { question: "Ready?", options: ["Yes", "No"] },
      isAnonymous: true,
    });
    expectMethods("sendPoll");
    expectFields({
      chat_id: "-1001",
      message_thread_id: 77,
      question: "Ready?",
      is_anonymous: true,
    });
    expect(result.pollId).toBe("http-poll");
  });

  describe("registered durable action delivery", () => {
    let state: OpenClawTestState;
    beforeEach(async () => {
      state = await createOpenClawTestState({ layout: "state-only", prefix: "telegram-actions-" });
      actionCfg = {
        ...cfg,
        channels: { telegram: { ...cfg.channels.telegram } },
        session: { store: path.join(state.stateDir, "{agentId}", "sessions.json") },
      };
      setTelegramPluginStateRuntimeForTests();
      setActivePluginRegistry(telegramRegistry());
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
        { to: "-1001:topic:77", message: "durable answer", quoteText: " \nquoted text  " },
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
      expectMethods("sendMessage");
      expectFields({
        chat_id: "-1001",
        message_thread_id: 77,
        text: "durable answer",
        reply_parameters: { message_id: 456, quote: " \nquoted text  " },
      });
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
      const registry = telegramRegistry();
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
      const result = await send({
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
            pipelineTable,
            ...buttonPresentation({ label: "Deploy", value: "env|prod" }, droppedButton()).blocks,
          ],
        },
      });
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
      expect(requests[0]!.fields.reply_markup).toEqual(
        replyMarkup({ text: "Deploy", callback_data: "env|prod" }),
      );
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
      const dropped = buttonPresentation(droppedButton());
      await send({
        location: { ...location, name: " Eiffel Tower ", address: " Champ de Mars " },
        presentation: dropped,
      });
      expectMethods("sendMessage", "sendVenue");
      expect(requests[0]!.fields.text).toContain("Copy manually");
      expectFields({ title: "Eiffel Tower", address: "Champ de Mars" }, 1);
      const rejected = await action("edit", { chatId: "123", messageId: 1, presentation: dropped });
      expect(rejected.details).toMatchObject({
        ok: false,
        degradedDelivery: { fallback: "not_delivered" },
      });
      expect(requests).toHaveLength(2);
      const edited = await action("edit", {
        chatId: "123",
        messageId: 1,
        presentation: buttonPresentation(
          { label: "Open", value: "env|prod" },
          ...dropped.blocks[0]!.buttons,
        ),
      });
      expect(requests[2]).toEqual({
        method: "editMessageReplyMarkup",
        fields: {
          chat_id: "123",
          message_id: 1,
          reply_markup: replyMarkup({ text: "Open", callback_data: "env|prod" }),
        },
      });
      expect(edited.details).toMatchObject({
        ok: true,
        degradedDelivery: { fallback: "not_delivered" },
      });
    });

    it("uploads all action attachment aliases instead of echoing their paths", async () => {
      const firstBytes = await fs.readFile(photoPath);
      const secondBytes = Buffer.concat([firstBytes, Buffer.from("second-attachment")]);
      const secondPath = path.join(state.stateDir, "second.png");
      await fs.writeFile(secondPath, secondBytes);
      await send(
        { message: "album", attachments: [{ path: photoPath }, { filePath: secondPath }] },
        { mediaLocalRoots: [mediaDir, state.stateDir] },
      );
      expectMethods("sendMediaGroup");
      const fields = requests[0]!.fields;
      const media = JSON.parse(String(fields.media)) as Array<{ media: string }>;
      const uploads = await Promise.all(
        media.map((part) => uploadBytes({ ...fields, part: part.media }, "part")),
      );
      expect(uploads).toEqual([firstBytes, secondBytes]);
    });

    it("sends a real video note while rejecting photos and forced documents", async () => {
      const notePath = path.join(state.stateDir, "note.mp4");
      const video = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
      await fs.writeFile(notePath, video);
      const options = { mediaLocalRoots: [state.stateDir, mediaDir] };
      for (const params of [{ mediaUrl: photoPath }, { mediaUrl: notePath, forceDocument: true }]) {
        await expect(send({ asVideoNote: true, ...params }, options)).rejects.toThrow(
          "Telegram video notes require video media.",
        );
      }
      expect(requests).toEqual([]);
      await send({ mediaUrl: notePath, asVideoNote: true }, options);
      expectMethods("sendVideoNote");
      expect(await uploadBytes(requestFields(), "video_note")).toEqual(video);
    });

    it.each(["poll", "sticker"] as const)(
      "accepts external %s aliases on the requested topic",
      async (kind) => {
        actionCfg.channels!.telegram!.actions = { sticker: true };
        actionCfg.channels!.telegram!.groupPolicy = "disabled";
        let delivered = 0;
        const end = telegramInboundEventDelivery.begin(
          "action-session",
          {
            outboundTo: "-1001:topic:77",
            markInboundEventDelivered: () => {
              delivered += 1;
            },
          },
          { inboundEventKind: "room_event" },
        );
        try {
          const poll = kind === "poll";
          const result = await action(
            kind,
            poll
              ? {
                  to: "-1001",
                  pollQuestion: "Ready?",
                  pollOption: ["Yes", "No"],
                  pollMulti: "true",
                  pollPublic: "true",
                  pollDurationSeconds: 60,
                  replyTo: 55,
                  threadId: 77,
                  silent: "true",
                }
              : {
                  target: "-1001",
                  stickerId: ["sticker"],
                  replyToMessageId: null,
                  replyTo: 9,
                  messageThreadId: null,
                  threadId: 77,
                },
            { sessionKey: "action-session", inboundEventKind: "room_event" },
          );
          expect(delivered).toBe(1);
          expectMethods(poll ? "sendPoll" : "sendSticker");
          expect(requests[0]!.fields).toMatchObject(
            poll
              ? {
                  question: "Ready?",
                  is_anonymous: false,
                  allows_multiple_answers: true,
                  open_period: 60,
                  reply_to_message_id: 55,
                  message_thread_id: 77,
                  disable_notification: true,
                }
              : { sticker: "sticker", reply_to_message_id: 9, message_thread_id: 77 },
          );
          if (poll) {
            expect(result.details).toMatchObject({
              pollAnswerRouting: "unavailable",
              warning: expect.stringMatching(/inbound messages are disabled/),
            });
          }
        } finally {
          end();
        }
      },
    );

    it("persists forum names from real topic responses in the routed account store", async () => {
      actionCfg.agents = { ownership: "explicit", entries: { main: {}, ops: {} } };
      actionCfg.bindings = [{ agentId: "ops", match: { channel: "telegram", accountId: "work" } }];
      actionCfg.channels!.telegram!.accounts = { work: { botToken: "654321:topic-owner" } };
      actionCfg.channels!.telegram!.actions = { createForumTopic: true, editForumTopic: true };
      fixture.responseFor = (method) =>
        method === "createForumTopic"
          ? { message_thread_id: 99, name: "Primary", icon_color: 7322096 }
          : undefined;
      const topic = (name: "topic-create" | "topic-edit", params: Record<string, unknown>) =>
        action(name, { chatId: "-1001", ...params }, { accountId: "work" });
      await topic("topic-create", { name: "Primary", threadName: "Alias" });
      await topic("topic-edit", { threadId: 99, threadName: "Renamed" });
      await topic("topic-edit", { threadId: 99, iconCustomEmojiId: "5231419410191111111" });
      expectMethods("createForumTopic", "editForumTopic", "editForumTopic");
      expect(requests[0]!.fields.name).toBe("Primary");
      expectFields({ message_thread_id: 99, icon_custom_emoji_id: "5231419410191111111" }, 2);
      resetTelegramTopicNameCacheForTest();
      await expect(
        getTopicName("-1001", 99, resolveStorePath(actionCfg.session?.store, { agentId: "ops" })),
      ).resolves.toBe("Renamed");
      await expect(
        getTopicName("-1001", 99, resolveStorePath(actionCfg.session?.store, { agentId: "main" })),
      ).resolves.toBeUndefined();
    });
  });
});
