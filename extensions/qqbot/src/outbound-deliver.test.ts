import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendC2CMessage: vi.fn(),
  sendDmMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendC2CImageMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
}));

const outboundMocks = vi.hoisted(() => ({
  sendPhoto: vi.fn(async () => ({})),
  sendVoice: vi.fn(async () => ({})),
  sendVideoMsg: vi.fn(async () => ({})),
  sendDocument: vi.fn(async () => ({})),
  sendMedia: vi.fn(async () => ({})),
}));

const runtimeMocks = vi.hoisted(() => ({
  chunkMarkdownText: vi.fn((text: string) => [text]),
}));

const ttsMocks = vi.hoisted(() => ({
  synthesizeAndDeliverTtsVoice: vi.fn(async () => false),
}));

vi.mock("./reply-dispatcher.js", () => ({
  synthesizeAndDeliverTtsVoice: ttsMocks.synthesizeAndDeliverTtsVoice,
}));

vi.mock("./api.js", () => ({
  sendC2CMessage: apiMocks.sendC2CMessage,
  sendDmMessage: apiMocks.sendDmMessage,
  sendGroupMessage: apiMocks.sendGroupMessage,
  sendChannelMessage: apiMocks.sendChannelMessage,
  sendC2CImageMessage: apiMocks.sendC2CImageMessage,
  sendGroupImageMessage: apiMocks.sendGroupImageMessage,
}));

vi.mock("./outbound.js", () => ({
  sendPhoto: outboundMocks.sendPhoto,
  sendVoice: outboundMocks.sendVoice,
  sendVideoMsg: outboundMocks.sendVideoMsg,
  sendDocument: outboundMocks.sendDocument,
  sendMedia: outboundMocks.sendMedia,
}));

vi.mock("./runtime.js", () => ({
  getQQBotRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: runtimeMocks.chunkMarkdownText,
      },
    },
  }),
}));

vi.mock("./utils/image-size.js", () => ({
  getImageSize: vi.fn(),
  formatQQBotMarkdownImage: vi.fn((url: string) => `![img](${url})`),
  hasQQBotImageSize: vi.fn(() => false),
}));

import {
  parseAndSendMediaTags,
  sendPlainReply,
  type ConsumeQuoteRefFn,
  type DeliverAccountContext,
  type DeliverEventContext,
  type SendWithRetryFn,
} from "./outbound-deliver.js";

function buildEvent(): DeliverEventContext {
  return {
    type: "c2c",
    senderId: "user-1",
    messageId: "msg-1",
  };
}

function buildAccountContext(markdownSupport: boolean, cfg?: unknown): DeliverAccountContext {
  return {
    qualifiedTarget: "qqbot:c2c:user-1",
    account: {
      accountId: "default",
      appId: "app-id",
      clientSecret: "secret",
      markdownSupport,
      config: {},
    } as DeliverAccountContext["account"],
    ...(cfg !== undefined ? { cfg } : {}),
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

const sendWithRetry: SendWithRetryFn = async (sendFn) => await sendFn("token");
const consumeQuoteRef: ConsumeQuoteRefFn = () => undefined;

describe("qqbot outbound deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.chunkMarkdownText.mockImplementation((text: string) => [text]);
    ttsMocks.synthesizeAndDeliverTtsVoice.mockResolvedValue(false);
  });

  it("sends plain replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello plain world",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello plain world",
      "msg-1",
      undefined,
    );
  });

  it("sends markdown replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello markdown world",
      buildEvent(),
      buildAccountContext(true),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello markdown world",
      "msg-1",
      undefined,
    );
  });

  it("routes media-tag text segments through the shared chunk sender", async () => {
    await parseAndSendMediaTags(
      "before<qqimg>https://example.com/a.png</qqimg>after",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      1,
      "app-id",
      "token",
      "user-1",
      "before",
      "msg-1",
      undefined,
    );
    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "app-id",
      "token",
      "user-1",
      "after",
      "msg-1",
      undefined,
    );
    expect(outboundMocks.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it("skips plain text when audioAsVoice TTS succeeds and cfg is present", async () => {
    ttsMocks.synthesizeAndDeliverTtsVoice.mockResolvedValueOnce(true);
    await sendPlainReply(
      { audioAsVoice: true },
      "spoken reply",
      buildEvent(),
      buildAccountContext(false, {}),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(ttsMocks.synthesizeAndDeliverTtsVoice).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CMessage).not.toHaveBeenCalled();
  });

  it("falls back to plain text when audioAsVoice TTS does not send", async () => {
    ttsMocks.synthesizeAndDeliverTtsVoice.mockResolvedValueOnce(false);
    await sendPlainReply(
      { audioAsVoice: true },
      "still text",
      buildEvent(),
      buildAccountContext(false, {}),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(ttsMocks.synthesizeAndDeliverTtsVoice).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "still text",
      "msg-1",
      undefined,
    );
  });

  it("does not synthesize TTS when audioAsVoice is set but cfg is missing", async () => {
    await sendPlainReply(
      { audioAsVoice: true },
      "no cfg",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(ttsMocks.synthesizeAndDeliverTtsVoice).not.toHaveBeenCalled();
    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "no cfg",
      "msg-1",
      undefined,
    );
  });
});
