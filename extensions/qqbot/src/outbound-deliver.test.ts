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

const imageSizeMocks = vi.hoisted(() => ({
  getImageSize: vi.fn(),
  formatQQBotMarkdownImage: vi.fn((url: string) => `![img](${url})`),
  hasQQBotImageSize: vi.fn(() => false),
}));

const fileUtilsMocks = vi.hoisted(() => ({
  resolveApprovedQqbotRemoteMediaUrl: vi.fn(async (url: string) => url),
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
  getImageSize: imageSizeMocks.getImageSize,
  formatQQBotMarkdownImage: imageSizeMocks.formatQQBotMarkdownImage,
  hasQQBotImageSize: imageSizeMocks.hasQQBotImageSize,
}));

vi.mock("./utils/file-utils.js", () => ({
  resolveApprovedQqbotRemoteMediaUrl: (...args: unknown[]) =>
    fileUtilsMocks.resolveApprovedQqbotRemoteMediaUrl(...args),
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

function buildAccountContext(markdownSupport: boolean): DeliverAccountContext {
  return {
    qualifiedTarget: "qqbot:c2c:user-1",
    account: {
      accountId: "default",
      appId: "app-id",
      clientSecret: "secret",
      markdownSupport,
      config: {},
    } as DeliverAccountContext["account"],
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
    fileUtilsMocks.resolveApprovedQqbotRemoteMediaUrl.mockImplementation(
      async (url: string) => url,
    );
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
      "before<qqimg>/tmp/a.png</qqimg>after",
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

  it("skips remote media tags from reply text when the URL is not approved", async () => {
    fileUtilsMocks.resolveApprovedQqbotRemoteMediaUrl.mockResolvedValueOnce(null);

    await parseAndSendMediaTags(
      "before<qqmedia>https://example.com/a.png</qqmedia>after",
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
    expect(outboundMocks.sendMedia).not.toHaveBeenCalled();
  });

  it("does not probe disallowed remote markdown image URLs from reply text", async () => {
    fileUtilsMocks.resolveApprovedQqbotRemoteMediaUrl.mockResolvedValueOnce(null);
    imageSizeMocks.getImageSize.mockResolvedValue({ width: 640, height: 480 });

    await sendPlainReply(
      {},
      "hello ![x](https://example.com/a.png)",
      buildEvent(),
      buildAccountContext(true),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(imageSizeMocks.getImageSize).not.toHaveBeenCalled();
    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello",
      "msg-1",
      undefined,
    );
  });

  it("does not append a duplicate markdown image when approval normalizes the URL", async () => {
    fileUtilsMocks.resolveApprovedQqbotRemoteMediaUrl.mockImplementation(async (url: string) =>
      url === "https://media.qq.com" ? "https://media.qq.com/" : url,
    );
    imageSizeMocks.getImageSize.mockResolvedValue({ width: 640, height: 480 });

    await sendPlainReply(
      {},
      "hello ![x](https://media.qq.com)",
      buildEvent(),
      buildAccountContext(true),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(imageSizeMocks.getImageSize).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello ![img](https://media.qq.com/)",
      "msg-1",
      undefined,
    );
  });
});
