/**
 * Tests for DingTalk Stream client.
 * Note: These tests focus on the startDingTalkStreamClient function behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatbotMessage } from "./types.js";

let registeredCallbacks: Map<string, (res: unknown) => Promise<void> | void> = new Map();
let shouldConnectFail = false;

// Mock dingtalk-stream before importing client
vi.mock("dingtalk-stream", () => {
  const EventAck = {
    SUCCESS: "SUCCESS",
    LATER: "LATER",
    UNKNOWN: "UNKNOWN",
  };

  const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
  const TOPIC_AI_GRAPH_API = "/v1.0/graph/api/invoke";

  class DWClient {
    static lastInstance: DWClient | null = null;

    socketCallBackResponse = vi.fn();
    sendGraphAPIResponse = vi.fn();
    connect = vi.fn().mockImplementation(() => {
      if (shouldConnectFail) {
        return Promise.reject(new Error("Connection failed"));
      }
      return Promise.resolve(undefined);
    });
    disconnect = vi.fn();

    constructor(public options: Record<string, unknown>) {
      DWClient.lastInstance = this;
      registeredCallbacks = new Map();
    }

    registerCallbackListener(
      topic: string,
      callback: (res: unknown) => Promise<void> | void,
    ): void {
      registeredCallbacks.set(topic, callback);
    }

    registerAllEventListener(): void {}
  }

  return { DWClient, EventAck, TOPIC_ROBOT, TOPIC_AI_GRAPH_API };
});

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { startDingTalkStreamClient } from "./client.js";

describe("startDingTalkStreamClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DWClient.lastInstance = null;
    registeredCallbacks = new Map();
    shouldConnectFail = false;
  });

  it("creates and connects client", async () => {
    const onChatMessage = vi.fn();

    const handle = await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    expect(handle).toBeDefined();
    expect(handle.stop).toBeDefined();
    expect(DWClient.lastInstance).not.toBeNull();
    expect(DWClient.lastInstance?.connect).toHaveBeenCalled();
  });

  it("registers robot message callback", async () => {
    const onChatMessage = vi.fn();

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    expect(registeredCallbacks.has(TOPIC_ROBOT)).toBe(true);
  });

  it("calls onChatMessage when robot message received", async () => {
    const onChatMessage = vi.fn().mockResolvedValue(undefined);

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    const robotCallback = registeredCallbacks.get(TOPIC_ROBOT);
    expect(robotCallback).toBeDefined();

    // Simulate receiving a message
    const mockMessage = {
      type: "CALLBACK",
      headers: {
        topic: TOPIC_ROBOT,
        eventType: "CHATBOT_MESSAGE",
        messageId: "msg-123",
      },
      data: JSON.stringify({
        text: { content: "Hello bot!" },
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
        conversationId: "cid123",
        conversationType: "2",
        senderStaffId: "user001",
        senderNick: "Test User",
      }),
    };

    await robotCallback!(mockMessage);
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 20));

    expect(onChatMessage).toHaveBeenCalled();
    const chatArg = onChatMessage.mock.calls[0][0] as ChatbotMessage;
    expect(chatArg.text).toBe("Hello bot!");
    expect(chatArg.senderId).toBe("user001");
  });

  it("sends ACK response on message receipt", async () => {
    const onChatMessage = vi.fn().mockResolvedValue(undefined);

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    const robotCallback = registeredCallbacks.get(TOPIC_ROBOT);

    const mockMessage = {
      type: "CALLBACK",
      headers: {
        topic: TOPIC_ROBOT,
        eventType: "CHATBOT_MESSAGE",
        messageId: "msg-ack-test",
      },
      data: JSON.stringify({
        text: { content: "Test" },
        sessionWebhook: "https://example.com",
      }),
    };

    await robotCallback!(mockMessage);

    expect(DWClient.lastInstance?.socketCallBackResponse).toHaveBeenCalledWith("msg-ack-test", {
      status: "received",
    });
  });

  it("ignores non-chatbot messages", async () => {
    const onChatMessage = vi.fn();

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    const robotCallback = registeredCallbacks.get(TOPIC_ROBOT);

    // Message without text should be ignored
    const mockMessage = {
      type: "CALLBACK",
      headers: {
        topic: TOPIC_ROBOT,
        eventType: "UNKNOWN_EVENT",
        messageId: "msg-unknown",
      },
      data: JSON.stringify({
        someOtherField: "value",
      }),
    };

    await robotCallback!(mockMessage);
    await new Promise((r) => setTimeout(r, 10));

    expect(onChatMessage).not.toHaveBeenCalled();
  });

  it("handles invalid JSON data gracefully", async () => {
    const onChatMessage = vi.fn();
    const mockLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
      logger: mockLogger,
    });

    const robotCallback = registeredCallbacks.get(TOPIC_ROBOT);

    const mockMessage = {
      type: "CALLBACK",
      headers: {
        topic: TOPIC_ROBOT,
        messageId: "msg-invalid",
      },
      data: "not valid json {{{",
    };

    await robotCallback!(mockMessage);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(onChatMessage).not.toHaveBeenCalled();
  });

  it("stop method disconnects client", async () => {
    const onChatMessage = vi.fn();

    const handle = await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
    });

    handle.stop();

    const instance = DWClient.lastInstance;
    expect(instance).not.toBeNull();
    if (!instance) {
      throw new Error("Expected DWClient instance to exist");
    }
    expect(instance.disconnect).toHaveBeenCalled();
  });

  it("logs connection on success", async () => {
    const mockLogger = { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const onChatMessage = vi.fn();

    await startDingTalkStreamClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      onChatMessage,
      logger: mockLogger,
    });

    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("throws error on connection failure", async () => {
    shouldConnectFail = true;
    const onChatMessage = vi.fn();

    await expect(
      startDingTalkStreamClient({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        onChatMessage,
      }),
    ).rejects.toThrow("Connection failed");
  });
});
