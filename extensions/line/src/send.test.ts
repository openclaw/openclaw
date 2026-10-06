import { HTTPFetchError } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  replyMessageMock,
  lineFetchMock,
  showLoadingAnimationMock,
  getProfileMock,
  getGroupMemberProfileMock,
  getRoomMemberProfileMock,
  getGroupSummaryMock,
  MessagingApiClientMock,
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
  resolvePinnedHostnameWithPolicyMock,
} = vi.hoisted(() => {
  const pushMessageMockLocal = vi.fn();
  const replyMessageMockLocal = vi.fn();
  const lineFetchMockLocal = vi.fn();
  const showLoadingAnimationMockLocal = vi.fn();
  const getProfileMockLocal = vi.fn();
  const getGroupMemberProfileMockLocal = vi.fn();
  const getRoomMemberProfileMockLocal = vi.fn();
  const getGroupSummaryMockLocal = vi.fn();
  const MessagingApiClientMockLocal = vi.fn(function () {
    return {
      pushMessage: pushMessageMockLocal,
      replyMessage: replyMessageMockLocal,
      showLoadingAnimation: showLoadingAnimationMockLocal,
      getProfile: getProfileMockLocal,
      getGroupMemberProfile: getGroupMemberProfileMockLocal,
      getRoomMemberProfile: getRoomMemberProfileMockLocal,
      getGroupSummary: getGroupSummaryMockLocal,
    };
  });
  const requireRuntimeConfigMockLocal = vi.fn((cfg: unknown) => cfg ?? {});
  const resolveLineAccountMockLocal = vi.fn(() => ({ accountId: "default" }));
  const resolveLineChannelAccessTokenMockLocal = vi.fn(() => "line-token");
  const recordChannelActivityMockLocal = vi.fn();
  const logVerboseMockLocal = vi.fn();
  const resolvePinnedHostnameWithPolicyMockLocal = vi.fn();
  return {
    pushMessageMock: pushMessageMockLocal,
    replyMessageMock: replyMessageMockLocal,
    lineFetchMock: lineFetchMockLocal,
    showLoadingAnimationMock: showLoadingAnimationMockLocal,
    getProfileMock: getProfileMockLocal,
    getGroupMemberProfileMock: getGroupMemberProfileMockLocal,
    getRoomMemberProfileMock: getRoomMemberProfileMockLocal,
    getGroupSummaryMock: getGroupSummaryMockLocal,
    MessagingApiClientMock: MessagingApiClientMockLocal,
    requireRuntimeConfigMock: requireRuntimeConfigMockLocal,
    resolveLineAccountMock: resolveLineAccountMockLocal,
    resolveLineChannelAccessTokenMock: resolveLineChannelAccessTokenMockLocal,
    recordChannelActivityMock: recordChannelActivityMockLocal,
    logVerboseMock: logVerboseMockLocal,
    resolvePinnedHostnameWithPolicyMock: resolvePinnedHostnameWithPolicyMockLocal,
  };
});

vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: MessagingApiClientMock },
  };
});

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

let sendModule: typeof import("./send.js");

const LINE_TEST_CFG = {
  channels: {
    line: {
      accounts: {
        default: {},
      },
    },
  },
};

function createTrackedResponse(body: string, init: ResponseInit) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      canceled = true;
    },
  });
  return { response: new Response(stream, init), wasCanceled: () => canceled };
}

describe("LINE send helpers", () => {
  const fixedSentAt = 1_800_000_000_000;
  function expectedMediaSendResult(chatId: string, messageIds: string[], messageCount: number) {
    const raw = messageIds.map((messageId) => ({
      channel: "line",
      chatId,
      conversationId: chatId,
      messageId,
      meta: { messageCount },
    }));
    const messageId = messageIds[0];
    return {
      chatId,
      messageId,
      receipt: {
        parts: messageIds.map((id, index) => ({
          index,
          kind: "media",
          platformMessageId: id,
          raw: raw[index],
          threadId: chatId,
        })),
        platformMessageIds: messageIds,
        primaryPlatformMessageId: messageId,
        raw,
        sentAt: fixedSentAt,
        threadId: chatId,
      },
    };
  }

  async function captureError(send: () => Promise<unknown>): Promise<unknown> {
    try {
      await send();
    } catch (error) {
      return error;
    }
    throw new Error("Expected LINE send to fail");
  }

  async function capturePartialDelivery(send: () => Promise<unknown>) {
    const caught = await captureError(send);
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("Expected partial LINE delivery");
    }
    return caught;
  }

  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.setSystemTime(fixedSentAt);
    pushMessageMock.mockReset();
    replyMessageMock.mockReset();
    lineFetchMock.mockReset();
    showLoadingAnimationMock.mockReset();
    getProfileMock.mockReset();
    getGroupMemberProfileMock.mockReset();
    getRoomMemberProfileMock.mockReset();
    getGroupSummaryMock.mockReset();
    MessagingApiClientMock.mockReset();
    requireRuntimeConfigMock.mockClear();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockReset();

    MessagingApiClientMock.mockImplementation(function () {
      return {
        pushMessage: pushMessageMock,
        replyMessage: replyMessageMock,
        showLoadingAnimation: showLoadingAnimationMock,
        getProfile: getProfileMock,
        getGroupMemberProfile: getGroupMemberProfileMock,
        getRoomMemberProfile: getRoomMemberProfileMock,
        getGroupSummary: getGroupSummaryMock,
      };
    });
    requireRuntimeConfigMock.mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    pushMessageMock.mockResolvedValue({ sentMessages: [{ id: "push" }] });
    replyMessageMock.mockResolvedValue({ sentMessages: [{ id: "reply" }] });
    showLoadingAnimationMock.mockResolvedValue({});
    lineFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (typeof init?.body !== "string") {
        throw new Error("LINE test fetch requires a JSON string request body");
      }
      const payload = JSON.parse(init.body);
      const provider = requestUrl.endsWith("/push") ? pushMessageMock : replyMessageMock;
      const body = await provider(payload);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", lineFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends the same provider-valid Flex alternative text through direct pushes", async () => {
    const altText = `${"a".repeat(1499)}😀 overflow`;

    await sendModule.pushFlexMessage("U123", altText, { type: "bubble" }, { cfg: LINE_TEST_CFG });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [{ type: "flex", altText: "a".repeat(1499), contents: { type: "bubble" } }],
    });
  });

  it("normalizes raw Flex actions at both outbound API boundaries", async () => {
    const oversizedPostback = { type: "postback", label: "Open", data: "x".repeat(301) };
    const oversizedUri = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };
    const message = {
      type: "flex",
      altText: "Raw Flex",
      contents: {
        type: "bubble",
        action: oversizedPostback,
        hero: {
          type: "video",
          url: "https://e.example/video.mp4",
          previewUrl: "https://e.example/preview.jpg",
          altContent: {
            type: "image",
            url: "https://e.example/preview.jpg",
            size: "full",
          },
          action: oversizedUri,
        },
        body: {
          type: "box",
          layout: "vertical",
          action: oversizedPostback,
          contents: [
            { type: "text", text: "Open", action: oversizedUri },
            { type: "button", action: oversizedPostback },
            {
              type: "text",
              text: "Still works",
              action: { type: "message", label: "Unavailable", text: "keep" },
            },
          ],
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ contents: Record<string, unknown> }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ contents: Record<string, unknown> }>;
    };
    expect(pushed.messages[0]?.contents).toEqual(replied.messages[0]?.contents);

    const contents = pushed.messages[0]?.contents as {
      action?: unknown;
      hero: { type: string; action?: unknown };
      body: { action?: unknown; contents: Array<{ action?: unknown; text?: string }> };
    };
    const unavailableAction = {
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    };
    expect(contents.action).toBeUndefined();
    expect(contents.hero).toEqual({
      type: "video",
      url: "https://e.example/video.mp4",
      previewUrl: "https://e.example/preview.jpg",
      altContent: {
        type: "image",
        url: "https://e.example/preview.jpg",
        size: "full",
      },
    });
    expect(contents.body.action).toBeUndefined();
    expect(contents.body.contents[0]?.action).toBeUndefined();
    expect(contents.body.contents[1]?.action).toEqual(unavailableAction);
    expect(contents.body.contents[2]?.action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "keep",
    });
    expect(contents.body.contents.slice(3).map((item) => item.text)).toEqual([
      "Action unavailable: callback data exceeds LINE's limit.\nLink unavailable: URL exceeds LINE's limit.",
    ]);
    expect(message.contents.action).toBe(oversizedPostback);
  });

  it("normalizes raw imagemap actions at both outbound API boundaries", async () => {
    const area = { x: 0, y: 0, width: 520, height: 1040 };
    const videoArea = { x: 520, y: 0, width: 520, height: 1040 };
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [
        {
          type: "uri",
          label: "Open",
          linkUri: `https://e.example/?q=${"x".repeat(1200)}`,
          area,
        },
        ...Array.from({ length: 49 }, (_, index) => ({
          type: "message",
          label: `Item ${index}`,
          text: `item-${index}`,
          area,
        })),
      ],
      video: {
        originalContentUrl: "https://e.example/video.mp4",
        previewImageUrl: "https://e.example/preview.jpg",
        area: videoArea,
        externalLink: {
          linkUri: `https://e.example/video?q=${"x".repeat(1200)}`,
          label: "Open video",
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[]; video?: { externalLink?: unknown } }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    expect(pushed.messages[0]?.actions).toEqual(replied.messages[0]?.actions);
    expect(pushed.messages[0]?.actions).toHaveLength(50);
    expect(pushed.messages[0]?.actions[0]).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
      area,
    });
    expect(pushed.messages[0]?.actions[1]).toMatchObject({
      type: "message",
      text: "item-0",
    });
    expect(pushed.messages[0]?.actions[49]).toMatchObject({
      type: "message",
      text: "item-48",
    });
    expect(pushed.messages[0]?.video?.externalLink).toBeUndefined();
    expect(message.actions[0]?.type).toBe("uri");
  });

  it("counts imagemap message text in UTF-16 units at both outbound API boundaries", async () => {
    const area = { x: 0, y: 0, width: 1040, height: 1040 };
    const exactText = "😀".repeat(200);
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [
        { type: "message", label: "Exact", text: exactText, area },
        { type: "message", label: "Too long", text: `${exactText}😀`, area },
      ],
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    expect(pushed.messages[0]?.actions).toEqual(replied.messages[0]?.actions);
    expect(pushed.messages[0]?.actions).toEqual([
      { type: "message", label: "Exact", text: exactText, area },
      {
        type: "message",
        label: "Unavailable",
        text: "Action unavailable: message text exceeds LINE's limit.",
        area,
      },
    ]);
  });

  it("counts imagemap video-link labels in UTF-16 units", async () => {
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [],
      video: {
        originalContentUrl: "https://e.example/video.mp4",
        previewImageUrl: "https://e.example/preview.jpg",
        area: { x: 0, y: 0, width: 1040, height: 1040 },
        externalLink: {
          linkUri: "https://e.example/video",
          label: "😀".repeat(16),
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ video: { externalLink: { label: string } } }>;
    };
    expect(pushed.messages[0]?.video.externalLink.label).toBe("😀".repeat(15));
  });

  it("pushes images via normalized LINE target", async () => {
    pushMessageMock.mockResolvedValueOnce({
      sentMessages: [{ id: "push-first" }, { id: "push-second" }],
    });
    const result = await sendModule.pushMessageLine("line:user:U123", "Image caption", {
      cfg: LINE_TEST_CFG,
      verbose: true,
      mediaUrl: "https://example.com/original.jpg",
      mediaKind: "image",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/original.jpg",
          previewImageUrl: "https://example.com/original.jpg",
        },
        { type: "text", text: "Image caption" },
      ],
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "line",
      accountId: "default",
      direction: "outbound",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: pushed message to U123");
    expect(result).toEqual(expectedMediaSendResult("U123", ["push-first", "push-second"], 2));
  });

  it("replies when reply token is provided", async () => {
    const text = "⚠️ 🛠️ `search repos (agent)` failed";
    replyMessageMock.mockResolvedValueOnce({
      sentMessages: [{ id: "reply-first" }, { id: "reply-second" }],
    });
    await sendModule.replyMessageLine(
      "reply-token",
      [
        {
          type: "image",
          originalContentUrl: "https://example.com/media.jpg",
          previewImageUrl: "https://example.com/media.jpg",
        },
        { type: "text", text },
      ],
      { cfg: LINE_TEST_CFG, verbose: true },
    );

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
          text,
        },
      ],
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: replied with 2 messages");
  });

  it("preserves all accepted reply ids when activity recording fails", async () => {
    replyMessageMock.mockResolvedValueOnce({
      sentMessages: [{ id: "713452345678901234" }, { id: "713452345678901235" }],
    });
    recordChannelActivityMock.mockImplementationOnce(() => {
      throw new Error("activity store unavailable");
    });

    const caught = await capturePartialDelivery(() =>
      sendModule.replyMessageLine("reply-token", [{ type: "text", text: "Hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    );
    expect(caught.deliveryResult).toEqual({
      messageIds: ["713452345678901234", "713452345678901235"],
      visibleReplySent: true,
    });
  });

  it("preserves a finalized push when activity recording fails", async () => {
    pushMessageMock.mockResolvedValueOnce({ sentMessages: [{ id: "line-provider-final" }] });
    recordChannelActivityMock.mockImplementationOnce(() => {
      throw new Error("activity store unavailable");
    });

    const caught = await capturePartialDelivery(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["line-provider-final"],
      receipt: {
        primaryPlatformMessageId: "line-provider-final",
        platformMessageIds: ["line-provider-final"],
        threadId: "U123",
        parts: [
          {
            platformMessageId: "line-provider-final",
            kind: "text",
            raw: { chatId: "U123", meta: { messageCount: 1 } },
          },
        ],
      },
      visibleReplySent: true,
    });
  });

  it.each([
    {
      operation: "push",
      stage: "initial denial",
      allowed: false,
      allowFallback: false,
      attempts: 0,
    },
    {
      operation: "push",
      stage: "revoked quote fallback",
      allowed: true,
      allowFallback: false,
      attempts: 1,
    },
    {
      operation: "reply",
      stage: "allowed quote fallback",
      allowed: true,
      allowFallback: true,
      attempts: 2,
    },
  ])("authorizes $operation at each attempt: $stage", async (testCase) => {
    let allowed = testCase.allowed;
    const authorize = vi.fn(async () => allowed);
    lineFetchMock.mockImplementationOnce(async () => {
      allowed = testCase.allowFallback;
      return new Response("invalid quote", { status: 400, statusText: "Bad Request" });
    });
    const options = { cfg: LINE_TEST_CFG, quoteToken: "stale-token", authorize };
    const messages = [{ type: "text" as const, text: "answering you" }];
    const sending =
      testCase.operation === "push"
        ? sendModule.pushMessagesLine("U0123456789abcdef0123456789abcdef", messages, options)
        : sendModule.replyMessageLine("reply-token", messages, options);

    if (testCase.allowFallback) {
      await sending;
    } else {
      await expect(sending).rejects.toThrow("LINE send authorization denied");
    }
    expect(lineFetchMock).toHaveBeenCalledTimes(testCase.attempts);
    expect(authorize).toHaveBeenCalledTimes(testCase.allowed ? 2 : 1);
    if (testCase.allowFallback) {
      const messagesSent = lineFetchMock.mock.calls.map(([, init]) => {
        const body = (init as RequestInit).body;
        if (typeof body !== "string") {
          throw new Error("Expected LINE request JSON");
        }
        return (JSON.parse(body) as { messages: unknown[] }).messages;
      });
      expect(messagesSent).toEqual([
        [{ type: "text", text: "answering you", quoteToken: "stale-token" }],
        [{ type: "text", text: "answering you" }],
      ]);
    }
  });

  it("does not resend a rejected send that carried no quote", async () => {
    lineFetchMock.mockResolvedValueOnce(
      new Response("invalid payload", { status: 400, statusText: "Bad Request" }),
    );

    await expect(
      sendModule.pushMessagesLine("U123", [{ type: "text", text: "Hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toBeInstanceOf(HTTPFetchError);
    expect(lineFetchMock).toHaveBeenCalledOnce();
  });

  it("does not misclassify network SyntaxErrors as provider acceptance", async () => {
    const failure = new SyntaxError("upstream network decoder failed");
    lineFetchMock.mockRejectedValueOnce(failure);

    await expect(sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG })).rejects.toBe(
      failure,
    );
    expect(isChannelPartialDeliveryError(failure)).toBe(false);
  });

  it.each([
    { name: "object receipt container", sentMessages: {}, messageIds: [] },
    {
      name: "null receipt entry",
      sentMessages: [{ id: "delivered" }, null],
      messageIds: ["delivered"],
    },
  ])("preserves accepted delivery for a malformed $name", async ({ sentMessages, messageIds }) => {
    pushMessageMock.mockResolvedValueOnce({ sentMessages });

    const caught = await capturePartialDelivery(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(caught.deliveryResult).toEqual({ messageIds, visibleReplySent: true });
    expect(pushMessageMock).toHaveBeenCalledOnce();
    expect(recordChannelActivityMock).not.toHaveBeenCalled();
  });

  it("sends a bare audio URL using the kind inferred by the LINE media owner", async () => {
    await sendModule.pushMessageLine("line:user:U123", "", {
      cfg: LINE_TEST_CFG,
      mediaUrl: "https://example.com/voice.m4a",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        {
          type: "audio",
          originalContentUrl: "https://example.com/voice.m4a",
          duration: 60000,
        },
      ],
    });
  });

  it("throws when push messages are empty", async () => {
    await expect(sendModule.pushMessagesLine("U123", [], { cfg: LINE_TEST_CFG })).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it("rejects lowercased LINE-shaped recipients (#81628 safety net)", async () => {
    // 33-char value with lowercase leading char — what an upstream session-key
    // fragment looked like before the cron-tool fix. LINE rejects with HTTP 400
    // anyway; throwing locally keeps the failure permanent so delivery-recovery
    // moves the entry to failed/ immediately instead of silently retrying 5×.
    await expect(
      sendModule.pushMessagesLine(
        "cabcdef0123456789abcdef0123456789",
        [{ type: "text", text: "hello" }],
        { cfg: LINE_TEST_CFG },
      ),
    ).rejects.toThrow(/Recipient is not a valid LINE id/);
    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it("preserves UTF-16 boundaries in invalid recipient diagnostics", async () => {
    await expect(
      sendModule.pushMessagesLine(`aab😀${"x".repeat(40)}`, [{ type: "text", text: "hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toThrow(
      "Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): aab…",
    );
    await expect(
      sendModule.pushMessagesLine(`aa😀${"y".repeat(40)}`, [{ type: "text", text: "hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toThrow(
      "Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): aa😀…",
    );
    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it("bounds profile cache entries across distinct users", async () => {
    getProfileMock.mockImplementation(async (userId: string) => ({
      displayName: userId,
    }));

    for (let index = 0; index <= 1000; index += 1) {
      await sendModule.getUserProfile(`U-profile-${index}`, { cfg: LINE_TEST_CFG });
    }
    await sendModule.getUserProfile("U-profile-0", { cfg: LINE_TEST_CFG });

    expect(getProfileMock).toHaveBeenCalledTimes(1002);
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    const label = "1234567890123456789😀";
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      [label, ...Array.from({ length: 19 }, (_, index) => `Choice ${index + 1}`)],
      { cfg: LINE_TEST_CFG },
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageMock.mock.calls.at(0) as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    const payload = expectDefined(firstCall[0], "LINE push payload");
    expect(payload.messages[0]?.quickReply?.items[0]).toMatchObject({
      action: { label, text: label },
    });
    expect(expectDefined(payload.messages[0], "LINE push message").quickReply?.items).toHaveLength(
      13,
    );
  });
  it("degrades to no profile when LINE cannot answer", async () => {
    getGroupMemberProfileMock.mockRejectedValue(new Error("404 not found"));

    await expect(
      sendModule.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();
    await expect(
      sendModule.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();

    expect(getGroupMemberProfileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps profile cache entries scoped to their conversation endpoint", async () => {
    getGroupMemberProfileMock.mockResolvedValueOnce({ displayName: "Group Sora" });
    getRoomMemberProfileMock.mockResolvedValueOnce({ displayName: "Room Sora" });

    await expect(
      sendModule.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, groupId: "Cshared" }),
    ).resolves.toMatchObject({ displayName: "Group Sora" });
    await expect(
      sendModule.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, roomId: "Rshared" }),
    ).resolves.toMatchObject({ displayName: "Room Sora" });

    expect(getGroupMemberProfileMock).toHaveBeenCalledTimes(1);
    expect(getRoomMemberProfileMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent group-name cache misses", async () => {
    let resolveSummary: (summary: { groupId: string; groupName: string }) => void = () => {};
    getGroupSummaryMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSummary = resolve;
      }),
    );

    const first = sendModule.getLineGroupName("Cconcurrent", { cfg: LINE_TEST_CFG });
    const second = sendModule.getLineGroupName("Cconcurrent", { cfg: LINE_TEST_CFG });
    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);

    resolveSummary({ groupId: "Cconcurrent", groupName: "Release Squad" });
    await expect(Promise.all([first, second])).resolves.toEqual(["Release Squad", "Release Squad"]);
    await expect(sendModule.getLineGroupName("Cconcurrent", { cfg: LINE_TEST_CFG })).resolves.toBe(
      "Release Squad",
    );
    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to no group name when the summary call fails", async () => {
    getGroupSummaryMock.mockRejectedValue(new Error("403 forbidden"));

    await expect(
      sendModule.getLineGroupName("Cforbidden", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();
    await expect(
      sendModule.getLineGroupName("Cforbidden", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();

    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an accepted retry-key conflict without reclassifying it as rejected", async () => {
    const tracked = createTrackedResponse("x".repeat(16 * 1024 + 1), {
      status: 409,
      statusText: "Conflict",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(tracked.response);

    const caught = await captureError(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(HTTPFetchError);
    expect(lineFetchMock).toHaveBeenCalledOnce();
    const requestInit = lineFetchMock.mock.calls[0]?.[1];
    expect(new Headers(requestInit?.headers).get("X-Line-Retry-Key")).toBeTruthy();
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("bounds oversized rejected LINE response bodies", async () => {
    const tracked = createTrackedResponse(`${"line upstream unavailable ".repeat(1024)}tail`, {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(tracked.response);

    const caught = await captureError(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({ status: 400, statusText: "Bad Request" });
    expect((caught as HTTPFetchError).body).toContain("line upstream unavailable");
    expect((caught as HTTPFetchError).body).not.toContain("tail");
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("preserves reply rejection status when the LINE error body cannot be read", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("provider response body failed"));
        },
      }),
      { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/plain" } },
    );
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(response);

    const caught = await captureError(() =>
      sendModule.replyMessageLine("reply-token", [{ type: "text", text: "Hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    );

    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({
      status: 503,
      statusText: "Service Unavailable",
      body: "",
    });
    expect(lineFetchMock).toHaveBeenCalledOnce();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
