import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildDiscordComponentMessage } from "./components.builders.js";
import type { DiscordComponentMessageSpec } from "./components.types.js";
import {
  createDiscordOutboundHoisted,
  expectDiscordThreadBotSend,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { createDiscordSendReceipt } from "./send.receipt.js";

const outboundWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "discord/outbound" ? { ...logger, warn: outboundWarnSpy } : logger;
    },
  };
});

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);
const {
  sendMessageDiscordMock: sendMessage,
  sendDiscordComponentMessageMock: sendComponent,
  sendPollDiscordMock: sendPoll,
  sendWebhookMessageDiscordMock: sendWebhook,
  sendVoiceMessageDiscordMock: sendVoice,
} = hoisted;

let outbound: typeof import("./outbound-adapter.js").discordOutbound;
let discordInboundEventDelivery: typeof import("./inbound-event-delivery.js").discordInboundEventDelivery;

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCall(source: MockCallSource, callIndex = 0) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected Discord send call ${callIndex}`);
  }
  return call;
}

function mockObjectArg(source: MockCallSource, callIndex = 0, argIndex = 2) {
  const value = mockCall(source, callIndex)[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected Discord send call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectMessage(text: string, index = 0) {
  expect(mockCall(sendMessage, index).slice(0, 2)).toEqual(["channel:123456", text]);
  const options = mockObjectArg(sendMessage, index);
  expect(options.accountId).toBe("default");
  return options;
}

function sendContext(to = "channel:123456") {
  return { cfg: {}, to, text: "", accountId: "default" };
}

const firstReply = {
  replyToId: "reply-1",
  replyToIdSource: "implicit",
  replyToMode: "first",
} as const;
const poll = { question: "Best snack?", options: ["banana", "apple"] };

function beginInboundDelivery(sessionKey: string, markInboundEventDelivered: () => void) {
  return discordInboundEventDelivery.begin(
    sessionKey,
    { outboundTo: "thread-1", outboundAccountId: "default", markInboundEventDelivered },
    { inboundEventKind: "room_event" },
  );
}

function deliveredPayload() {
  return {
    cfg: {},
    target: {
      channel: "discord" as const,
      to: "channel:parent-1",
      accountId: "default",
      threadId: "thread-1",
    },
    payload: { text: "delivered" },
    results: [{ channel: "discord" as const, messageId: "msg-1" }],
  };
}

function approvalPayload(text: string) {
  return { text, channelData: { execApproval: { approvalId: "req-1", approvalSlug: "req-1" } } };
}

function adaptPresentation(presentation: MessagePresentation) {
  return adaptMessagePresentationForChannel({
    capabilities: outbound.presentationCapabilities,
    presentation,
  });
}

function buttons(...entries: MessagePresentationButton[]): MessagePresentation {
  return { blocks: [{ type: "buttons", buttons: entries }] };
}

type PresentationParams = Parameters<NonNullable<typeof outbound.renderPresentation>>[0];
type Payload = PresentationParams["payload"];
type PayloadContext = Parameters<NonNullable<typeof outbound.sendPayload>>[0];
function sendPayload(payload: Payload, options: Partial<Omit<PayloadContext, "payload">> = {}) {
  return outbound.sendPayload?.({ ...sendContext(), ...options, payload });
}
function discordPayload(text: string, discord: unknown): Payload {
  return { text, channelData: { discord } };
}
function renderPresentation(presentation: MessagePresentation, payload: Payload = {}) {
  return outbound.renderPresentation?.({
    payload,
    presentation,
    ctx: { cfg: {}, to: "channel:123456", text: "", payload },
  });
}

async function nativePresentation(...args: Parameters<typeof renderPresentation>) {
  const payload = await renderPresentation(...args);
  if (!payload) {
    throw new Error("expected Discord presentation payload");
  }
  return payload;
}

function sendResult(messageId = "msg-1", id = "ch-1") {
  return { channel: "discord", messageId, target: { kind: "channel", id } };
}

function receiptResult(
  messageId: string,
  kind: "text" | "media",
  sentAt: number,
  threadId?: string,
) {
  return {
    messageId,
    channelId: "thread-1",
    receipt: {
      ...(threadId ? { threadId } : {}),
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind, index: 0 }],
      sentAt,
    },
  };
}

function trustedMedia(workspaceDir = "/tmp/agent-workspace", content = "trusted media") {
  const mediaReadFile = vi.fn(async () => Buffer.from(content));
  const mediaAccess = { localRoots: [workspaceDir], readFile: mediaReadFile, workspaceDir };
  return { mediaAccess, mediaLocalRoots: mediaAccess.localRoots, mediaReadFile };
}

function expectMediaAuthority(
  options: Record<string, unknown>,
  media: ReturnType<typeof trustedMedia>,
) {
  expect(options.mediaAccess).toBe(media.mediaAccess);
  expect(options.mediaLocalRoots).toBe(media.mediaLocalRoots);
  expect(options.mediaReadFile).toBe(media.mediaReadFile);
}

beforeAll(async () => {
  ({ discordOutbound: outbound } = await import("./outbound-adapter.js"));
  ({ discordInboundEventDelivery } = await import("./inbound-event-delivery.js"));
});

beforeEach(() => {
  resetDiscordOutboundMocks(hoisted);
  outboundWarnSpy.mockClear();
});

it("uses allowFrom to disambiguate bare numeric DM delivery targets", () => {
  expect(
    outbound.resolveTarget?.({
      to: "1470130713209602050",
      allowFrom: ["1470130713209602050"],
    }),
  ).toEqual({
    ok: true,
    to: "user:1470130713209602050",
  });
});

it("uses webhook persona delivery for bound thread text replies", async () => {
  mockDiscordBoundThreadManager(hoisted);
  const cfg = { channels: { discord: { token: "resolved-token" } } };

  const result = await outbound.sendText?.({
    ...sendContext("channel:parent-1"),
    cfg,
    text: "hello from persona",
    threadId: "thread-1",
    replyToId: "reply-1",
    identity: {
      name: "Codex",
      avatarUrl: "https://example.com/avatar.png",
    },
  });

  expect(mockCall(sendWebhook)[0]).toBe("hello from persona");
  const options = mockObjectArg(sendWebhook, 0, 1);
  expect(options).toMatchObject({
    webhookId: "wh-1",
    webhookToken: "tok-1",
    accountId: "default",
    threadId: "thread-1",
    username: "Codex",
    avatarUrl: "https://example.com/avatar.png",
  });
  expect(options.replyTo).toEqual({ messageId: "reply-1", scope: "all" });
  expect(options.cfg).toBe(cfg);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(result).toEqual(sendResult("msg-webhook-1", "thread-1"));
});

it("falls back to bot send when Discord rejects the webhook send", async () => {
  mockDiscordBoundThreadManager(hoisted);
  sendWebhook.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));

  const result = await outbound.sendText?.({
    ...sendContext("channel:parent-1"),
    text: "fallback",
    threadId: "thread-1",
  });

  expect(sendWebhook).toHaveBeenCalledTimes(1);
  expectDiscordThreadBotSend({ hoisted, text: "fallback", result });
  expect(outboundWarnSpy).toHaveBeenCalledWith(
    expect.stringContaining("webhook persona send failed"),
    { error: expect.objectContaining({ message: "rate limited" }) },
  );
});

it("routes poll sends to thread target when threadId is provided", async () => {
  const onPlatformSendDispatch = vi.fn(async () => undefined);
  const markInboundEventDelivered = vi.fn();
  const sessionKey = "agent:main:discord:channel:parent-1";
  const end = beginInboundDelivery(sessionKey, markInboundEventDelivered);
  sendPoll.mockResolvedValueOnce({
    messageId: "poll-1",
    channelId: "thread-1",
    receipt: createDiscordSendReceipt({
      platformMessageIds: ["poll-1"],
      channelId: "thread-1",
      kind: "poll",
      threadId: "thread-1",
    }),
  });
  let result;
  try {
    result = await outbound.sendPoll?.({
      ...sendContext("channel:parent-1"),
      poll,
      content: "Vote now",
      threadId: "thread-1",
      silent: true,
      sessionKey,
      inboundEventKind: "room_event",
      onPlatformSendDispatch,
    });
  } finally {
    end();
  }

  const call = mockCall(sendPoll);
  expect(call[0]).toBe("channel:thread-1");
  expect(call[1]).toEqual({ question: "Best snack?", options: ["banana", "apple"] });
  expect(mockObjectArg(sendPoll)).toMatchObject({
    accountId: "default",
    content: "Vote now",
    threadId: "thread-1",
    silent: true,
    onPlatformSendDispatch,
  });
  expect(result).toEqual({
    channel: "discord",
    messageId: "poll-1",
    channelId: "thread-1",
    receipt: expect.objectContaining({
      primaryPlatformMessageId: "poll-1",
      threadId: "thread-1",
    }),
  });
  expect(markInboundEventDelivered).toHaveBeenCalledOnce();
});

it("enforces account poll policy before provider dispatch", async () => {
  await expect(
    outbound.sendPoll?.({
      cfg: {
        channels: {
          discord: {
            actions: { polls: true },
            accounts: { work: { actions: { polls: false } } },
          },
        },
      },
      to: "channel:parent-1",
      poll,
      accountId: "work",
    }),
  ).rejects.toThrow("Discord polls are disabled");
  expect(sendPoll).not.toHaveBeenCalled();
});

it("routes audioAsVoice payloads through the Discord voice send helper", async () => {
  const onDeliveryResult = vi.fn();
  const media = trustedMedia();
  sendMessage.mockImplementation(async (_to: unknown, _text: unknown, options: unknown) => {
    const deliveryResult = { messageId: "msg-1", channelId: "ch-1" };
    const onProgress = (options as { onDeliveryResult?: (result: unknown) => Promise<void> })
      .onDeliveryResult;
    await onProgress?.(deliveryResult);
    return deliveryResult;
  });
  const result = await sendPayload(
    {
      text: "voice note",
      mediaUrls: ["./voice.ogg", "./extra.png"],
      audioAsVoice: true,
    },
    {
      ...media,
      ...firstReply,
      onDeliveryResult,
    },
  );

  expect(mockCall(sendVoice).slice(0, 2)).toEqual(["channel:123456", "./voice.ogg"]);
  const voiceOptions = mockObjectArg(sendVoice);
  expect(voiceOptions.accountId).toBe("default");
  expect(voiceOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });
  expectMediaAuthority(voiceOptions, media);

  const messageOptions = expectMessage("voice note");
  expect(messageOptions.reply).toBeUndefined();
  expect(messageOptions).not.toHaveProperty("mediaAccess");

  const mediaOptions = expectMessage("", 1);
  expect(mediaOptions.mediaUrl).toBe("./extra.png");
  expectMediaAuthority(mediaOptions, media);
  expect(mediaOptions.reply).toBeUndefined();
  expect(result).toEqual(sendResult());
  expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
    "voice-1",
    "msg-1",
    "msg-1",
  ]);
});

it("preserves reader-free workspace authority on direct voice media sends", async () => {
  const mediaAccess = {
    localRoots: ["/tmp/agent-workspace"],
    workspaceDir: "/tmp/agent-workspace",
  };

  await outbound.sendMedia?.({
    ...sendContext(),
    accountId: undefined,
    mediaUrl: "./voice.ogg",
    audioAsVoice: true,
    mediaAccess,
    mediaLocalRoots: mediaAccess.localRoots,
  });

  expect(mockCall(sendVoice)[1]).toBe("./voice.ogg");
  const voiceOptions = mockObjectArg(sendVoice);
  expect(voiceOptions.mediaAccess).toBe(mediaAccess);
  expect(voiceOptions.mediaLocalRoots).toBe(mediaAccess.localRoots);
  expect(voiceOptions.mediaReadFile).toBeUndefined();
  expect(voiceOptions.mediaAccess).not.toHaveProperty("readFile");
});

it("delivers fallback TTS supplement text before reporting a voice failure", async () => {
  const voiceError = new Error("ffmpeg unavailable");
  sendVoice.mockRejectedValueOnce(voiceError);

  await expect(
    sendPayload(
      {
        mediaUrls: ["https://example.com/voice.ogg"],
        audioAsVoice: true,
        ttsSupplement: { spokenText: "spoken answer" },
      },
      {
        replyToId: "reply-1",
        replyToMode: "first",
      },
    ),
  ).rejects.toBe(voiceError);

  expect(sendVoice).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(expectMessage("spoken answer").reply).toEqual({ messageId: "reply-1", scope: "first" });
  expect(outboundWarnSpy).toHaveBeenCalledWith(
    "discord voice send failed; continuing without voice",
    { error: voiceError },
  );
});

it("does not treat delivery progress failures as voice delivery failures", async () => {
  await expect(
    sendPayload(
      {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg"],
        audioAsVoice: true,
      },
      {
        onDeliveryResult: async () => {
          throw new Error("progress unavailable");
        },
      },
    ),
  ).rejects.toThrow("progress unavailable");

  expect(sendVoice).toHaveBeenCalledOnce();
  expect(sendMessage).not.toHaveBeenCalled();
});

it("sends implicit all-mode video captions before media with replies", async () => {
  await outbound.sendMedia?.({
    ...sendContext(),
    text: "rendered clip",
    mediaUrl: "/tmp/render.mp4",
    replyToId: "reply-1",
    replyToIdSource: "implicit",
    replyToMode: "all",
  });

  expect(expectMessage("rendered clip").reply).toEqual({ messageId: "reply-1", scope: "all" });

  const mediaOptions = expectMessage("", 1);
  expect(mediaOptions.mediaUrl).toBe("/tmp/render.mp4");
  expect(mediaOptions.reply).toEqual({ messageId: "reply-1", scope: "all" });
});

it("keeps captioned video in the thread created by the forum starter", async () => {
  const media = trustedMedia("/tmp/agent-workspace", "trusted video");
  sendMessage
    .mockResolvedValueOnce(receiptResult("starter-1", "text", 1, "thread-1"))
    .mockResolvedValueOnce(receiptResult("video-1", "media", 2));

  const result = await outbound.sendMedia?.({
    ...sendContext("channel:forum-1"),
    text: "rendered clip",
    mediaUrl: "./render.mp4",
    ...media,
  });

  expect(mockCall(sendMessage, 0)[0]).toBe("channel:forum-1");
  expect(mockCall(sendMessage, 1)[0]).toBe("channel:thread-1");
  expect(mockObjectArg(sendMessage)).not.toHaveProperty("mediaAccess");
  expectMediaAuthority(mockObjectArg(sendMessage, 1), media);
  expect(result).toMatchObject({
    channel: "discord",
    messageId: "starter-1",
    target: { kind: "channel", id: "thread-1" },
    receipt: {
      primaryPlatformMessageId: "starter-1",
      threadId: "thread-1",
      platformMessageIds: ["starter-1", "video-1"],
      parts: [
        { platformMessageId: "starter-1", kind: "text", index: 0, threadId: "thread-1" },
        { platformMessageId: "video-1", kind: "media", index: 1, threadId: "thread-1" },
      ],
    },
  });
});

it("touches bound thread activity after shared outbound delivery succeeds", async () => {
  const touchThread = vi.fn();
  hoisted.getThreadBindingManagerMock.mockReturnValue({
    getByThreadId: () => ({ threadId: "thread-1" }),
    touchThread,
  });

  await outbound.afterDeliverPayload?.(deliveredPayload());

  expect(touchThread).toHaveBeenCalledWith({ threadId: "thread-1" });
});

it("notifies inbound event delivery after shared outbound delivery succeeds", async () => {
  const markDelivered = vi.fn();
  const end = beginInboundDelivery("agent:main:discord:channel:c1", markDelivered);

  try {
    await outbound.afterDeliverPayload?.({
      ...deliveredPayload(),
      payload: discordPayload("delivered", {
        __openclawInboundEventDelivery: {
          sessionKey: "agent:main:discord:channel:c1",
          inboundEventKind: "room_event",
        },
      }),
    });
  } finally {
    end();
  }

  expect(markDelivered).toHaveBeenCalledTimes(1);
});

it("sends component payload media sequences with the component message first", async () => {
  const media = trustedMedia("/tmp/media", "trusted component media");
  sendComponent.mockResolvedValueOnce({ messageId: "component-1", channelId: "ch-1" });
  sendMessage.mockResolvedValueOnce({ messageId: "msg-2", channelId: "ch-1" });

  const payload = await nativePresentation(buttons({ label: "Open", value: "open" }), {
    text: "hello",
    mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
  });

  const result = await sendPayload(payload, { ...media, ...firstReply });

  expect(mockCall(sendComponent)[0]).toBe("channel:123456");
  expect(mockObjectArg(sendComponent, 0, 1).text).toBe("hello");
  const componentOptions = mockObjectArg(sendComponent);
  expect(componentOptions.mediaUrl).toBe("https://example.com/1.png");
  expectMediaAuthority(componentOptions, media);
  expect(componentOptions.accountId).toBe("default");
  expect(componentOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });

  const messageOptions = expectMessage("");
  expect(messageOptions.mediaUrl).toBe("https://example.com/2.png");
  expectMediaAuthority(messageOptions, media);
  expect(messageOptions.reply).toBeUndefined();
  expect(result).toEqual(sendResult("msg-2"));
});

it("delivers complete authored title through native presentation components", async () => {
  const text = `${"x".repeat(1996)} \n  TAIL_NOT_DELIVERED`;
  const presentation = adaptPresentation({ title: text, blocks: [] });
  const payload = await nativePresentation(presentation, { presentation });
  await sendPayload(payload, { accountId: undefined });
  const spec = mockObjectArg(sendComponent, 0, 1) as DiscordComponentMessageSpec;
  const components = buildDiscordComponentMessage({ spec }).components;
  const wire = JSON.stringify(components.map((component) => component.serialize()));
  expect(wire).toContain("TAIL_NOT_DELIVERED");
  expect(
    (spec.blocks ?? [])
      .flatMap((block) => (block.type === "text" ? [block.text.replace(/^-# /u, "")] : []))
      .join(""),
  ).toBe(text);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("preserves disabled presentation buttons through channel adaptation", async () => {
  const adaptedPresentation = adaptPresentation(
    buttons(
      { label: "Already handled", value: "done", disabled: true },
      { label: "Open docs", url: "https://example.com/docs", disabled: true },
    ),
  );
  const payload = await nativePresentation(adaptedPresentation, { text: "Action state" });

  const discordData = payload.channelData?.discord as
    | { presentationComponents?: { blocks?: Array<{ type?: string; buttons?: unknown[] }> } }
    | undefined;
  const nativeButtons = discordData?.presentationComponents?.blocks?.find(
    (block) => block.type === "actions",
  )?.buttons;

  expect(nativeButtons?.slice(0, 2)).toEqual([
    { label: "Already handled", style: "secondary", callbackData: "done", disabled: true },
    { label: "Open docs", style: "link", url: "https://example.com/docs", disabled: true },
  ]);
});

it("encodes question buttons from Gateway option order", async () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";
  const payload = await renderPresentation(
    buttons(
      {
        label: "Production",
        action: { type: "question", questionId, optionValue: "Production" },
      },
      { label: "Other…", action: { type: "question", questionId, intent: "custom-input" } },
      { label: "Staging", action: { type: "question", questionId, optionValue: "Staging" } },
    ),
    { channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } } },
  );

  const discordData = payload?.channelData?.discord as
    | { presentationComponents?: { blocks?: Array<{ buttons?: unknown[] }> } }
    | undefined;
  expect(discordData?.presentationComponents?.blocks?.[0]?.buttons).toMatchObject([
    { internalCustomId: `ocq:id=${questionId};i=1` },
    { internalCustomId: `ocq:id=${questionId};i=0` },
  ]);
});

it("falls back to chunked text when a table exceeds the Discord component envelope", async () => {
  const table = {
    type: "table" as const,
    caption: "Large pipeline",
    headers: ["Account", "Stage"],
    rows: Array.from({ length: 900 }, (_entry, index) => [
      `account-${String(index)}-${"x".repeat(80)}`,
      "Review",
    ]),
  };
  const presentation = adaptPresentation({
    blocks: [
      table,
      ...buttons({ label: "Continue", action: { type: "command", command: "/continue" } }).blocks,
    ],
  });
  const rendered = await renderPresentation(presentation);
  const fallbackText = renderMessagePresentationFallbackText({ presentation });
  await sendPayload({ text: fallbackText }, { text: fallbackText });
  const textChunks = sendMessage.mock.calls.map((call) => String(call[1]));
  const deliveredText = textChunks.join("\n");

  expect(presentation.blocks.length).toBeGreaterThan(40);
  expect(rendered).toBeNull();
  expect(sendComponent).not.toHaveBeenCalled();
  expect(textChunks.length).toBeGreaterThan(1);
  expect(deliveredText).toContain("account-0-");
  expect(deliveredText).toContain("account-899-");
  expect(deliveredText).toContain("Continue: `/continue`");
});

it("sends prepared native Discord payload data through outbound delivery", async () => {
  await sendPayload(
    {
      ...discordPayload("hello", {
        components: [{ type: 1, components: [] }],
        filename: "photo.png",
      }),
      mediaUrl: "https://example.com/photo.png",
    },
    firstReply,
  );

  const options = expectMessage("hello");
  expect(options).toMatchObject({
    mediaUrl: "https://example.com/photo.png",
    filename: "photo.png",
  });
  expect(options.components).toEqual([{ type: 1, components: [] }]);
  expect(options.reply).toEqual({ messageId: "reply-1", scope: "first" });
});

it("renders channelData Discord components on payload sends", async () => {
  await sendPayload(
    discordPayload("native component text", {
      components: { blocks: [{ type: "text", text: "Native component body" }] },
    }),
  );

  expect(mockCall(sendComponent)[0]).toBe("channel:123456");
  const payload = mockObjectArg(sendComponent, 0, 1);
  expect(payload.text).toBe("native component text");
  expect(payload.blocks).toEqual([{ type: "text", text: "Native component body" }]);
  expect(mockObjectArg(sendComponent).accountId).toBe("default");
  expect(sendMessage).not.toHaveBeenCalled();
});

it("neutralizes approval mentions only for approval payloads", async () => {
  await sendPayload(approvalPayload("Approval @everyone <@123> <#456>"));

  expectMessage("Approval @\u200beveryone <@\u200b123> <#\u200b456>");
});

it("uses a single implicit reply for chunked approval payload fallbacks", async () => {
  await sendPayload(approvalPayload("line one\nline two"), {
    ...firstReply,
    formatting: { maxLinesPerMessage: 1 },
  });

  expect(
    sendMessage.mock.calls.map((call) => (call[2] as { reply?: unknown } | undefined)?.reply),
  ).toEqual([{ messageId: "reply-1", scope: "first" }, undefined]);
});
