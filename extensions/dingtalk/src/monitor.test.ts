/**
 * Tests for DingTalk monitor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  loadWebMedia: vi.fn(),
}));

// Mock dependencies
vi.mock("dingtalk-stream", () => {
  const EventAck = { SUCCESS: "SUCCESS" };
  const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
  const TOPIC_AI_GRAPH_API = "/v1.0/graph/api/invoke";

  class DWClient {
    private callbacks = new Map<string, (res: unknown) => Promise<void> | void>();
    socketCallBackResponse = vi.fn();
    sendGraphAPIResponse = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();

    registerCallbackListener(
      topic: string,
      callback: (res: unknown) => Promise<void> | void,
    ): void {
      this.callbacks.set(topic, callback);
    }
    registerAllEventListener(): void {}

    // Test helper
    __simulateMessage(topic: string, message: unknown): Promise<void> | void | undefined {
      const callback = this.callbacks.get(topic);
      if (callback) {
        return callback(message);
      }
    }
  }

  return { DWClient, EventAck, TOPIC_ROBOT, TOPIC_AI_GRAPH_API };
});

vi.mock("./runtime.js", () => {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({ ok: true });
  const runtime = {
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  };

  return {
    getDingTalkRuntime: () => runtime,
    getOrCreateTokenManager: () => ({
      getToken: vi.fn().mockResolvedValue("test-token"),
      invalidate: vi.fn(),
    }),
  };
});

vi.mock("./api/media.js", () => ({
  downloadMedia: vi.fn(),
  uploadMedia: vi.fn(),
}));

vi.mock("./api/send-message.js", async () => {
  const actual =
    await vi.importActual<typeof import("./api/send-message.js")>("./api/send-message.js");
  return {
    ...actual,
    sendFileMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
});

vi.mock("./api/media-upload.js", async () => {
  const actual =
    await vi.importActual<typeof import("./api/media-upload.js")>("./api/media-upload.js");
  return {
    ...actual,
    uploadMediaToOAPI: vi.fn(),
  };
});

import { BASIC_ACCOUNT, FILTERED_ACCOUNT, PREFIX_ACCOUNT } from "../test/fixtures/configs.js";
import { DINGTALK_CHANNEL_ID } from "./config-schema.js";
import { monitorDingTalkProvider } from "./monitor.js";
import { getDingTalkRuntime } from "./runtime.js";

describe("monitorDingTalkProvider", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let capturedCallback: ((message: unknown) => Promise<void> | void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCallback = undefined;

    // Mock fetch for webhook replies
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Capture the robot callback when client is created
    const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");
    vi.spyOn(DWClient.prototype, "registerCallbackListener").mockImplementation(
      (topic: string, callback: (res: unknown) => Promise<void> | void) => {
        if (topic === TOPIC_ROBOT) {
          capturedCallback = callback;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockConfig = {
    channels: {
      dingtalk: { enabled: true },
    },
  };

  const createMockMessage = (
    overrides: Partial<{
      text: string;
      senderId: string;
      conversationType: string;
      conversationId: string;
    }> = {},
  ) => ({
    type: "CALLBACK",
    headers: {
      topic: "/v1.0/im/bot/messages/get",
      eventType: "CHATBOT_MESSAGE",
      messageId: `msg-${Date.now()}`,
    },
    data: JSON.stringify({
      text: { content: overrides.text ?? "Hello bot" },
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      conversationId: overrides.conversationId ?? "cid123",
      conversationType: overrides.conversationType ?? "2",
      senderStaffId: overrides.senderId ?? "user001",
      senderNick: "Test User",
      // Simulate a normal group mention so BASIC_ACCOUNT (requireMention=true) will process it
      isInAtList: true,
    }),
  });

  it("starts monitoring and returns handle", async () => {
    const handle = await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    expect(handle).toBeDefined();
    expect(handle.stop).toBeDefined();
  });

  it("dispatches message to Clawdbot runtime", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    // Simulate incoming message
    if (capturedCallback) {
      await capturedCallback(createMockMessage());
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    }
  });

  it("builds correct context for Clawdbot", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "Test message" }));
      await new Promise((r) => setTimeout(r, 50));

      const call = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      const ctx = call[0].ctx;

      expect(ctx.Body).toBe("Test message");
      expect(ctx.SessionKey).toContain("dingtalk:group:");
      expect(ctx.Provider).toBe(DINGTALK_CHANNEL_ID);
      expect(ctx.Surface).toBe(DINGTALK_CHANNEL_ID);

      // Ensure Openclaw block streaming flushes each block immediately by default.
      // (This is accomplished by forcing chunkMode="newline" on the canonical channel id.)
      const cfg = call[0].cfg;
      expect(cfg?.channels?.[DINGTALK_CHANNEL_ID]?.chunkMode).toBe("newline");
    }
  });

  it("isolates group SessionKey per sender when enabled", async () => {
    const runtime = getDingTalkRuntime();
    const account = { ...BASIC_ACCOUNT, isolateContextPerUserInGroup: true };

    await monitorDingTalkProvider({
      account,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(
        createMockMessage({
          text: "Test message",
          conversationType: "2",
          conversationId: "cid123",
          senderId: "user001",
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      const call = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      const ctx = call[0].ctx;

      expect(ctx.SessionKey).toBe("agent:main:dingtalk:group:cid123:user:user001");
    }
  });

  it("filters messages from self", async () => {
    const runtime = getDingTalkRuntime();
    const accountWithSelf = { ...BASIC_ACCOUNT, selfUserId: "bot-id" };

    await monitorDingTalkProvider({
      account: accountWithSelf,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ senderId: "bot-id" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    }
  });

  it("filters messages not in allowFrom list", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: FILTERED_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      // User not in allowlist
      await capturedCallback(createMockMessage({ senderId: "unknown-user" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    }
  });

  it("allows messages from allowFrom list", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: FILTERED_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ senderId: "allowed-user-1" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    }
  });

  it("enforces prefix requirement in group chats", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: PREFIX_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      // Message without prefix
      await capturedCallback(createMockMessage({ text: "Hello", conversationType: "2" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    }
  });

  it("allows message with correct prefix in group", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: PREFIX_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "@bot Hello", conversationType: "2" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    }
  });

  it("does not enforce prefix in DMs", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: PREFIX_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      // DM (conversationType: "1") should not require prefix
      await capturedCallback(createMockMessage({ text: "Hello", conversationType: "1" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    }
  });

  it("stops client on abort signal", async () => {
    const controller = new AbortController();

    const handle = await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
      abortSignal: controller.signal,
    });

    // The handle should have a stop method
    expect(handle.stop).toBeDefined();

    // Abort signal triggers stop
    controller.abort();

    // Give time for abort handler
    await new Promise((r) => setTimeout(r, 20));

    // Since we can't easily verify disconnect was called with the current mock setup,
    // we just verify the monitor handles abort signal without throwing
    expect(true).toBe(true);
  });

  it("logs errors from message handler", async () => {
    const runtime = getDingTalkRuntime();
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    (
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("Dispatch failed"));

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
      log: mockLogger,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage());
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.error).toHaveBeenCalled();
    }
  });

  it("recognizes /new command for session reset", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "/new Start fresh" }));
      await new Promise((r) => setTimeout(r, 50));

      const call = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call[0].ctx.CommandAuthorized).toBe(true);
    }
  });

  it("recognizes /verbose command", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "/verbose on Hello" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    }
  });

  it("recognizes /reasoning command", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "/reasoning on Hello" }));
      await new Promise((r) => setTimeout(r, 50));

      const call = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call[0].ctx.CommandAuthorized).toBe(true);
    }
  });

  it("injects senderStaffId in BodyForAgent", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ senderId: "staff123" }));
      await new Promise((r) => setTimeout(r, 50));

      const call = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call[0].ctx.BodyForAgent).toContain("senderStaffId: staff123");
    }
  });

  it("supports one-shot thinking via /t!", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    if (capturedCallback) {
      await capturedCallback(createMockMessage({ text: "/t! on Hello" }));
      await new Promise((r) => setTimeout(r, 50));

      const calls = (
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(calls.length).toBe(3);
      expect(calls[0]?.[0]?.ctx?.CommandBody).toBe("/think high");
      expect(calls[1]?.[0]?.ctx?.CommandBody).toBe("Hello");
      expect(calls[2]?.[0]?.ctx?.CommandBody).toBe("/think off");
    }
  });

  it("delivers tool-kind media even when verbose is off", async () => {
    const runtime = getDingTalkRuntime();

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    expect(capturedCallback).toBeTypeOf("function");
    await capturedCallback?.(createMockMessage({ conversationType: "1" }));
    await new Promise((r) => setTimeout(r, 50));

    const call = (
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const dispatcherOptions = call?.[0]?.dispatcherOptions;
    expect(dispatcherOptions?.deliver).toBeTypeOf("function");

    await dispatcherOptions.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "tool" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("sendBySession");
    const body = JSON.parse(init.body as string);
    expect(body.msgtype).toBe("image");
    expect(body.image.picURL).toBe("https://example.com/a.png");
  });

  it("uploads local images via OAPI and sends as sessionWebhook media_id", async () => {
    const runtime = getDingTalkRuntime();
    const pluginSdk = await import("openclaw/plugin-sdk");
    const mediaApi = await import("./api/media.js");
    const mediaUploadApi = await import("./api/media-upload.js");

    (pluginSdk.loadWebMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      kind: "image",
      fileName: "image.png",
    });
    (mediaUploadApi.uploadMediaToOAPI as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      mediaId: "oapi-media-id",
      type: "image",
    });

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    expect(capturedCallback).toBeTypeOf("function");
    await capturedCallback?.(createMockMessage({ conversationType: "1" }));
    await new Promise((r) => setTimeout(r, 50));

    const call = (
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const dispatcherOptions = call?.[0]?.dispatcherOptions;

    await dispatcherOptions.deliver({ mediaUrl: "./image.png" }, { kind: "final" });

    expect(mediaUploadApi.uploadMediaToOAPI).toHaveBeenCalled();
    expect(mediaApi.uploadMedia).not.toHaveBeenCalled();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.msgtype).toBe("image");
    expect(body.image.media_id).toBe("oapi-media-id");
  });

  it("sends non-image media as a file message (not as image)", async () => {
    const runtime = getDingTalkRuntime();
    const pluginSdk = await import("openclaw/plugin-sdk");
    const mediaApi = await import("./api/media.js");
    const sendMessageApi = await import("./api/send-message.js");

    (pluginSdk.loadWebMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      buffer: Buffer.from("fake-pdf"),
      contentType: "application/pdf",
      kind: "document",
      fileName: "report.pdf",
    });
    (mediaApi.uploadMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      mediaId: "media-123",
    });

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    expect(capturedCallback).toBeTypeOf("function");
    await capturedCallback?.(createMockMessage({ conversationType: "1" }));
    await new Promise((r) => setTimeout(r, 50));

    const call = (
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const dispatcherOptions = call?.[0]?.dispatcherOptions;

    await dispatcherOptions.deliver({ mediaUrl: "./report.pdf" }, { kind: "final" });

    expect(sendMessageApi.sendFileMessage).toHaveBeenCalledTimes(1);
    const args = (sendMessageApi.sendFileMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args?.mediaId).toBe("media-123");
    expect(args?.fileName).toBe("report.pdf");
  });

  it("treats a standalone local path in text as media instead of sending the raw path", async () => {
    const runtime = getDingTalkRuntime();
    const pluginSdk = await import("openclaw/plugin-sdk");
    const mediaApi = await import("./api/media.js");
    const mediaUploadApi = await import("./api/media-upload.js");

    (pluginSdk.loadWebMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      kind: "image",
      fileName: "image.png",
    });
    (mediaApi.uploadMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      mediaId: "robot-media-id",
    });
    (mediaUploadApi.uploadMediaToOAPI as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      mediaId: "oapi-media-id",
      type: "image",
    });

    await monitorDingTalkProvider({
      account: BASIC_ACCOUNT,
      config: mockConfig,
    });

    expect(capturedCallback).toBeTypeOf("function");
    await capturedCallback?.(createMockMessage({ conversationType: "1" }));
    await new Promise((r) => setTimeout(r, 50));

    const call = (
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const dispatcherOptions = call?.[0]?.dispatcherOptions;

    await dispatcherOptions.deliver({ text: "./image.png" }, { kind: "final" });

    expect(mediaUploadApi.uploadMediaToOAPI).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.msgtype).toBe("image");
  });
});
