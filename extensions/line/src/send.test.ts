import { HTTPFetchError, type messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse as createTrackedResponse } from "../../test-support/streaming-error-response.js";

const realGlobalFetch = globalThis.fetch.bind(globalThis);
const { client, fetchLine, Client, activity, verbose, resolveHost } = vi.hoisted(() => {
  const sdkClient = {
    pushMessage: vi.fn(),
    replyMessage: vi.fn(),
    showLoadingAnimation: vi.fn(),
    getProfile: vi.fn(),
    getGroupMemberProfile: vi.fn(),
    getRoomMemberProfile: vi.fn(),
    getGroupSummary: vi.fn(),
  };
  return {
    client: sdkClient,
    fetchLine: vi.fn(),
    Client: vi.fn(function () {
      return sdkClient;
    }),
    activity: vi.fn(),
    verbose: vi.fn(),
    resolveHost: vi.fn(),
  };
});
vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: Client },
  };
});
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>();
  return { ...actual, recordChannelActivity: activity };
});
vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: verbose,
  };
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, resolvePinnedHostnameWithPolicy: resolveHost };
});
const send = await import("./send.js");
const LINE_TEST_CFG = {
  channels: { line: { channelAccessToken: "line-token", channelSecret: "line-secret" } },
};
const options = { cfg: LINE_TEST_CFG };
const imageMapArea = { x: 0, y: 0, width: 1040, height: 1040 };
function imageMap<T extends object>(fields: T) {
  return {
    type: "imagemap",
    baseUrl: "https://e.example/imagemap",
    altText: "Map",
    baseSize: { width: 1040, height: 1040 },
    ...fields,
  };
}
const video = {
  type: "video",
  url: "https://e.example/video.mp4",
  previewUrl: "https://e.example/preview.jpg",
  altContent: { type: "image", url: "https://e.example/preview.jpg", size: "full" },
};
const imageMapVideo = (externalLink: messagingApi.ImagemapExternalLink) => ({
  originalContentUrl: video.url,
  previewImageUrl: video.previewUrl,
  area: imageMapArea,
  externalLink,
});

// Capture the wire payload once; SDK response mocks do not normalize it for us.
function pushedMessage() {
  return expectDefined(
    client.pushMessage.mock.calls[0]?.[0]?.messages[0],
    "LINE push message",
  ) as messagingApi.Message;
}
async function sendBoth(message: messagingApi.Message) {
  await send.pushMessagesLine("U123", [message], options);
  await send.replyMessageLine("reply-token", [message], options);
  expect(client.pushMessage.mock.calls[0]?.[0]?.messages).toEqual(
    client.replyMessage.mock.calls[0]?.[0]?.messages,
  );
}
describe("LINE send helpers", () => {
  const fixedSentAt = 1_800_000_000_000;
  const pushText = (channelAccessToken?: string) =>
    send.pushMessageLine("U123", "Hello", { ...options, channelAccessToken });
  async function captureError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("Expected LINE send to fail");
  }
  async function capturePartialDelivery(run: () => Promise<unknown>) {
    const caught = await captureError(run);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("Expected partial LINE delivery");
    }
    return caught;
  }
  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });
  beforeEach(() => {
    vi.setSystemTime(fixedSentAt);
    for (const mock of [
      ...Object.values(client),
      fetchLine,
      Client,
      activity,
      verbose,
      resolveHost,
    ]) {
      mock.mockReset();
    }
    Client.mockImplementation(function () {
      return client;
    });
    resolveHost.mockResolvedValue({ hostname: "example.com", addresses: ["93.184.216.34"] });
    client.pushMessage.mockResolvedValue({ sentMessages: [{ id: "push" }] });
    client.replyMessage.mockResolvedValue({ sentMessages: [{ id: "reply" }] });
    client.showLoadingAnimation.mockResolvedValue({});
    fetchLine.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (typeof init?.body !== "string") {
        throw new Error("LINE test fetch requires a JSON string request body");
      }
      const payload = JSON.parse(init.body);
      const provider = requestUrl.endsWith("/push") ? client.pushMessage : client.replyMessage;
      const body = await provider(payload);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchLine);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("sends the same provider-valid Flex alternative text through direct pushes", async () => {
    const altText = `${"a".repeat(1499)}😀 overflow`;
    await send.pushFlexMessage("U123", altText, { type: "bubble" }, options);
    expect(client.pushMessage).toHaveBeenCalledWith({
      to: "U123",
      messages: [{ type: "flex", altText: "a".repeat(1499), contents: { type: "bubble" } }],
    });
  });

  it("normalizes nested Flex actions without disabling authored Unavailable labels", async () => {
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
          ...structuredClone(video),
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
    await sendBoth(message as never);
    const output = pushedMessage();
    expect(output).not.toHaveProperty("contents.action");
    expect(output).toHaveProperty("contents.hero", video);
    expect(output).not.toHaveProperty("contents.body.action");
    expect(output).not.toHaveProperty("contents.body.contents.0.action");
    expect(output).toHaveProperty("contents.body.contents.1.action", {
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
    expect(output).toHaveProperty("contents.body.contents.2.action", {
      type: "message",
      label: "Unavailable",
      text: "keep",
    });
    expect(output).toHaveProperty("contents.body.contents.length", 4);
    expect(output).toHaveProperty(
      "contents.body.contents.3.text",
      "Action unavailable: callback data exceeds LINE's limit.\nLink unavailable: URL exceeds LINE's limit.",
    );
    expect(message.contents.action).toBe(oversizedPostback);
    expect(message.contents.hero.action).toBe(oversizedUri);
  });

  it("normalizes raw imagemap actions at both outbound API boundaries", async () => {
    const area = imageMapArea;
    const message = imageMap({
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
      video: imageMapVideo({
        linkUri: `https://e.example/video?q=${"x".repeat(1200)}`,
        label: "Open",
      }),
    });
    await sendBoth(message as never);
    const pushed = pushedMessage() as messagingApi.ImagemapMessage;
    expect(pushed.actions).toHaveLength(50);
    expect(pushed.actions[0]).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
      area,
    });
    expect(
      pushed.actions.slice(1).map((action) => action.type === "message" && action.text),
    ).toEqual(Array.from({ length: 49 }, (_, i) => `item-${i}`));
    expect(pushed.video?.externalLink).toBeUndefined();
    expect(message.actions[0]?.type).toBe("uri");
  });

  it("counts imagemap message text in UTF-16 units at both outbound API boundaries", async () => {
    const area = imageMapArea;
    const exactText = "😀".repeat(200);
    const message = imageMap({
      actions: [
        { type: "message", label: "Exact", text: exactText, area },
        { type: "message", label: "Too long", text: `${exactText}😀`, area },
      ],
    });
    await sendBoth(message as never);
    expect((pushedMessage() as messagingApi.ImagemapMessage).actions).toEqual([
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
    const message = imageMap({
      actions: [],
      video: imageMapVideo({ linkUri: "https://e.example/video", label: "😀".repeat(16) }),
    });
    await send.pushMessagesLine("U123", [message] as never, options);
    expect((pushedMessage() as messagingApi.ImagemapMessage).video?.externalLink?.label).toBe(
      "😀".repeat(15),
    );
  });

  it("pushes images via normalized LINE target", async () => {
    client.pushMessage.mockResolvedValueOnce({
      sentMessages: [{ id: "push-first" }, { id: "push-second" }],
    });
    const result = await send.pushMessageLine("line:user:U123", "Image caption", {
      cfg: LINE_TEST_CFG,
      mediaUrl: "https://example.com/original.jpg",
      mediaKind: "image",
    });
    expect(client.pushMessage).toHaveBeenCalledWith({
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
    expect(activity).toHaveBeenCalledWith({
      channel: "line",
      accountId: "default",
      direction: "outbound",
    });
    expect(result).toMatchObject({
      chatId: "U123",
      messageId: "push-first",
      receipt: { platformMessageIds: ["push-first", "push-second"], threadId: "U123" },
    });
    expect(
      result.receipt?.parts.map(({ kind, platformMessageId }) => [kind, platformMessageId]),
    ).toEqual([
      ["media", "push-first"],
      ["media", "push-second"],
    ]);
  });

  it.each(["push", "reply"] as const)(
    "preserves accepted %s ids when activity recording fails",
    async (operation) => {
      const messageIds = ["713452345678901234", "713452345678901235"];
      client[operation === "push" ? "pushMessage" : "replyMessage"].mockResolvedValueOnce({
        sentMessages: messageIds.map((id) => ({ id })),
      });
      activity.mockImplementationOnce(() => {
        throw new Error("activity store unavailable");
      });
      const caught = await capturePartialDelivery(() =>
        operation === "push"
          ? pushText()
          : send.replyMessageLine("reply-token", [{ type: "text", text: "Hello" }], options),
      );
      expect(caught.deliveryResult).toMatchObject({ messageIds, visibleReplySent: true });
      if (operation === "push") {
        expect(caught.deliveryResult.receipt).toMatchObject({
          primaryPlatformMessageId: messageIds[0],
          platformMessageIds: messageIds,
          threadId: "U123",
          parts: messageIds.map((platformMessageId) => ({
            platformMessageId,
            kind: "text",
            raw: { chatId: "U123", meta: { messageCount: 1 } },
          })),
        });
      } else {
        expect(caught.deliveryResult.receipt).toBeUndefined();
      }
    },
  );

  it.each([
    ["push", "initial denial", false, false, 0],
    ["push", "revoked quote fallback", true, false, 1],
    ["reply", "allowed quote fallback", true, true, 2],
  ] as const)(
    "authorizes %s at each attempt: %s",
    async (operation, _stage, initiallyAllowed, allowFallback, attempts) => {
      let allowed: boolean = initiallyAllowed;
      const authorize = vi.fn(async () => allowed);
      fetchLine.mockImplementationOnce(async () => {
        allowed = allowFallback;
        return new Response("invalid quote", { status: 400, statusText: "Bad Request" });
      });
      const quoteOptions = { cfg: LINE_TEST_CFG, quoteToken: "stale-token", authorize };
      const messages = [{ type: "text" as const, text: "answering you" }];
      const sending =
        operation === "push"
          ? send.pushMessagesLine("U0123456789abcdef0123456789abcdef", messages, quoteOptions)
          : send.replyMessageLine("reply-token", messages, quoteOptions);
      if (allowFallback) {
        await sending;
      } else {
        await expect(sending).rejects.toThrow("LINE send authorization denied");
      }
      expect(fetchLine).toHaveBeenCalledTimes(attempts);
      expect(authorize).toHaveBeenCalledTimes(initiallyAllowed ? 2 : 1);
      if (allowFallback) {
        const messagesSent = fetchLine.mock.calls.map(([, init]) => {
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
    },
  );

  it("does not misclassify network SyntaxErrors as provider acceptance", async () => {
    const failure = new SyntaxError("upstream network decoder failed");
    fetchLine.mockRejectedValueOnce(failure);
    await expect(pushText()).rejects.toBe(failure);
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
    client.pushMessage.mockResolvedValueOnce({ sentMessages });
    const caught = await capturePartialDelivery(pushText);
    expect(caught.deliveryResult).toEqual({ messageIds, visibleReplySent: true });
    expect(client.pushMessage).toHaveBeenCalledOnce();
    expect(activity).not.toHaveBeenCalled();
  });

  it("sends a bare audio URL using the kind inferred by the LINE media owner", async () => {
    await send.pushMessageLine("line:user:U123", "", {
      cfg: LINE_TEST_CFG,
      mediaUrl: "https://example.com/voice.m4a",
    });
    expect(client.pushMessage).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        { type: "audio", originalContentUrl: "https://example.com/voice.m4a", duration: 60000 },
      ],
    });
  });

  it("throws when push messages are empty", async () => {
    await expect(send.pushMessagesLine("U123", [], options)).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it.each([
    ["cabcdef0123456789abcdef0123456789", "cabc"],
    [`aab😀${"x".repeat(40)}`, "aab"],
    [`aa😀${"y".repeat(40)}`, "aa😀"],
  ])("rejects invalid recipient %s with Unicode-safe diagnostics (#81628)", async (to, prefix) => {
    await expect(
      send.pushMessagesLine(to, [{ type: "text", text: "hello" }], options),
    ).rejects.toThrow(
      `Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): ${prefix}…`,
    );
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it("bounds profile cache entries across distinct users", async () => {
    client.getProfile.mockImplementation(async (userId: string) => ({ displayName: userId }));
    for (let index = 0; index <= 1000; index += 1) {
      await send.getUserProfile(`U-profile-${index}`, options);
    }
    await send.getUserProfile("U-profile-0", options);
    expect(client.getProfile).toHaveBeenCalledTimes(1002);
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    const label = "1234567890123456789😀";
    await send.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      ["", "  ", label, ...Array.from({ length: 19 }, (_, index) => `Choice ${index + 1}`)],
      options,
    );
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    const payload = pushedMessage();
    expect(payload.quickReply?.items?.[0]).toMatchObject({
      action: { label, text: label },
    });
    expect(payload.quickReply?.items).toHaveLength(13);
  });
  it("degrades to no profile when LINE cannot answer", async () => {
    client.getGroupMemberProfile.mockRejectedValue(new Error("404 not found"));
    await expect(
      send.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();
    await expect(
      send.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();
    expect(client.getGroupMemberProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps profile cache entries scoped to their conversation endpoint", async () => {
    client.getGroupMemberProfile.mockResolvedValueOnce({ displayName: "Group Sora" });
    client.getRoomMemberProfile.mockResolvedValueOnce({ displayName: "Room Sora" });
    await expect(
      send.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, groupId: "Cshared" }),
    ).resolves.toMatchObject({ displayName: "Group Sora" });
    await expect(
      send.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, roomId: "Rshared" }),
    ).resolves.toMatchObject({ displayName: "Room Sora" });
    expect(client.getGroupMemberProfile).toHaveBeenCalledTimes(1);
    expect(client.getRoomMemberProfile).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent group-name cache misses", async () => {
    const summary = Promise.withResolvers<{ groupId: string; groupName: string }>();
    client.getGroupSummary.mockReturnValueOnce(summary.promise);
    const first = send.getLineGroupName("Cconcurrent", options);
    const second = send.getLineGroupName("Cconcurrent", options);
    expect(client.getGroupSummary).toHaveBeenCalledTimes(1);
    summary.resolve({ groupId: "Cconcurrent", groupName: "Release Squad" });
    await expect(Promise.all([first, second])).resolves.toEqual(["Release Squad", "Release Squad"]);
    await expect(send.getLineGroupName("Cconcurrent", options)).resolves.toBe("Release Squad");
    expect(client.getGroupSummary).toHaveBeenCalledTimes(1);
  });

  it("degrades to no group name when the summary call fails", async () => {
    client.getGroupSummary.mockRejectedValue(new Error("403 forbidden"));
    await expect(send.getLineGroupName("Cforbidden", options)).resolves.toBeUndefined();
    await expect(send.getLineGroupName("Cforbidden", options)).resolves.toBeUndefined();
    expect(client.getGroupSummary).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, "Conflict"],
    [400, "Bad Request"],
  ] as const)(
    "bounds a %s provider response without changing its acceptance classification",
    async (status, statusText) => {
      const tracked = createTrackedResponse(`${"line upstream unavailable ".repeat(1024)}tail`, {
        status,
        statusText,
        headers: { "content-type": status === 409 ? "application/json" : "text/plain" },
      });
      fetchLine.mockResolvedValueOnce(tracked.response);
      const caught = await captureError(pushText);
      expect(isChannelPartialDeliveryError(caught)).toBe(status === 409);
      expect(caught instanceof HTTPFetchError).toBe(status === 400);
      expect(fetchLine).toHaveBeenCalledOnce();
      if (caught instanceof HTTPFetchError) {
        expect(caught).toMatchObject({ status, statusText });
        expect(caught.body).toContain("line upstream unavailable");
        expect(caught.body).not.toContain("tail");
      } else {
        expect(
          new Headers(fetchLine.mock.calls[0]?.[1]?.headers).get("X-Line-Retry-Key"),
        ).toBeTruthy();
      }
      expect(tracked.wasCanceled()).toBe(true);
    },
  );

  it.each(["batch", "flex"] as const)(
    "does not log reflected message content on a rejected %s push",
    async (kind) => {
      const text = "synthetic private message reflected by LINE";
      fetchLine.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: text }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        }),
      );
      const caught = await captureError(() =>
        kind === "batch"
          ? send.pushMessagesLine("U123", [{ type: "text", text }], options)
          : send.pushFlexMessage("U123", text, { type: "bubble" }, options),
      );
      expect(caught).toBeInstanceOf(HTTPFetchError);
      expect(caught).toMatchObject({ status: 400, body: JSON.stringify({ message: text }) });
      expect(verbose).not.toHaveBeenCalled();
    },
  );

  it("masks a reflected Authorization token through a real HTTP reflector", async () => {
    const token = "line-channel-access-token-xyz0123456789abcdef";
    await withServer(
      (req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(
          `proxy failure reflected Authorization: ${req.headers.authorization}; request rejected`,
        );
      },
      async (origin) => {
        // Redirect only the destination; keep the real fetch and response handling.
        fetchLine.mockImplementationOnce(
          async (url: string | URL | Request, init?: RequestInit) => {
            const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
            return realGlobalFetch(target.replace("https://api.line.me", origin), init);
          },
        );
        const caught = await captureError(() => pushText(token));
        expect(caught).toBeInstanceOf(HTTPFetchError);
        const body = (caught as HTTPFetchError).body;
        expect(body).toContain("proxy failure");
        expect(body).toContain("request rejected");
        expect(body).not.toContain(token);
      },
    );
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
    fetchLine.mockResolvedValueOnce(response);
    const caught = await captureError(() =>
      send.replyMessageLine("reply-token", [{ type: "text", text: "Hello" }], options),
    );
    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({ status: 503, statusText: "Service Unavailable", body: "" });
    expect(fetchLine).toHaveBeenCalledOnce();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
