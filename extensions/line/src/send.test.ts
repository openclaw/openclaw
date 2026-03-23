import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  replyMessageMock,
  showLoadingAnimationMock,
  getProfileMock,
  MessagingApiClientMock,
  loadConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
} = vi.hoisted(() => {
  const pushMessageMock = vi.fn();
  const replyMessageMock = vi.fn();
  const showLoadingAnimationMock = vi.fn();
  const getProfileMock = vi.fn();
  const MessagingApiClientMock = vi.fn(function () {
    return {
      pushMessage: pushMessageMock,
      replyMessage: replyMessageMock,
      showLoadingAnimation: showLoadingAnimationMock,
      getProfile: getProfileMock,
    };
  });
  const loadConfigMock = vi.fn();
  const resolveLineAccountMock = vi.fn();
  const resolveLineChannelAccessTokenMock = vi.fn();
  const recordChannelActivityMock = vi.fn();
  const logVerboseMock = vi.fn();
  return {
    pushMessageMock,
    replyMessageMock,
    showLoadingAnimationMock,
    getProfileMock,
    MessagingApiClientMock,
    loadConfigMock,
    resolveLineAccountMock,
    resolveLineChannelAccessTokenMock,
    recordChannelActivityMock,
    logVerboseMock,
  };
});

let sendModule: typeof import("./send.js");

describe("LINE send helpers", () => {
  beforeEach(async () => {
    vi.resetModules();

    pushMessageMock.mockReset();
    replyMessageMock.mockReset();
    showLoadingAnimationMock.mockReset();
    getProfileMock.mockReset();
    MessagingApiClientMock.mockClear();
    loadConfigMock.mockReset();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();

    loadConfigMock.mockReturnValue({
      channels: {
        line: {
          channelAccessToken: "line-token",
          accounts: {
            default: {
              channelAccessToken: "line-token",
            },
          },
        },
      },
    });
    resolveLineAccountMock.mockReturnValue({
      accountId: "default",
      channelAccessToken: "line-token",
    });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    pushMessageMock.mockResolvedValue({});
    replyMessageMock.mockResolvedValue({});
    showLoadingAnimationMock.mockResolvedValue({});

    vi.doMock("@line/bot-sdk", () => ({
      messagingApi: {
        MessagingApiClient: MessagingApiClientMock,
      },
    }));

    vi.doMock("openclaw/plugin-sdk/config-runtime", () => ({
      loadConfig: loadConfigMock,
    }));

    vi.doMock("./accounts.js", () => ({
      resolveLineAccount: resolveLineAccountMock,
    }));

    vi.doMock("./channel-access-token.js", () => ({
      resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
    }));

    vi.doMock("openclaw/plugin-sdk/infra-runtime", () => ({
      recordChannelActivity: recordChannelActivityMock,
    }));

    vi.doMock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
      const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
      return {
        ...actual,
        logVerbose: logVerboseMock,
      };
    });

    sendModule = await import("./send.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits quick reply items to 13", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Option ${index + 1}`);
    const quickReply = sendModule.createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("pushes images via normalized LINE target", async () => {
    const result = await sendModule.pushImageMessage(
      "line:user:U123",
      "https://example.com/original.jpg",
      undefined,
      { verbose: true, channelAccessToken: "line-token" },
    );

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/original.jpg",
          previewImageUrl: "https://example.com/original.jpg",
        },
      ],
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "line",
      accountId: "default",
      direction: "outbound",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: pushed image to U123");
    expect(result).toEqual({ messageId: "push", chatId: "U123" });
  });

  it("replies when reply token is provided", async () => {
    const result = await sendModule.sendMessageLine("line:group:C1", "Hello", {
      replyToken: "reply-token",
      mediaUrl: "https://example.com/media.jpg",
      verbose: true,
      channelAccessToken: "line-token",
    });

    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/media.jpg",
          previewImageUrl: "https://example.com/media.jpg",
        },
        {
          type: "text",
          text: "Hello",
        },
      ],
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: replied to C1");
    expect(result).toEqual({ messageId: "reply", chatId: "C1" });
  });

  it("throws when push messages are empty", async () => {
    await expect(sendModule.pushMessagesLine("U123", [])).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it("logs HTTP body when push fails", async () => {
    const err = new Error("LINE push failed") as Error & {
      status: number;
      statusText: string;
      body: string;
    };
    err.status = 400;
    err.statusText = "Bad Request";
    err.body = "invalid flex payload";
    pushMessageMock.mockRejectedValueOnce(err);

    await expect(
      sendModule.pushMessagesLine("U999", [{ type: "text", text: "hello" }], {
        channelAccessToken: "line-token",
      }),
    ).rejects.toThrow("LINE push failed");

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: push message failed (400 Bad Request): invalid flex payload",
    );
  });

  it("caches profile results by default", async () => {
    getProfileMock.mockResolvedValue({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });

    const first = await sendModule.getUserProfile("U-cache", {
      channelAccessToken: "line-token",
    });
    const second = await sendModule.getUserProfile("U-cache", {
      channelAccessToken: "line-token",
    });

    expect(first).toEqual({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });
    expect(second).toEqual(first);
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it("continues when loading animation is unsupported", async () => {
    showLoadingAnimationMock.mockRejectedValueOnce(new Error("unsupported"));

    await expect(
      sendModule.showLoadingAnimation("line:room:R1", { channelAccessToken: "line-token" }),
    ).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("line: loading animation failed (non-fatal)"),
    );
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      Array.from({ length: 20 }, (_, index) => `Choice ${index + 1}`),
      { channelAccessToken: "line-token" },
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageMock.mock.calls[0] as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    expect(firstCall[0].messages[0].quickReply?.items).toHaveLength(13);
  });
});
