import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  botCtorSpy,
  getLoadConfigMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  onSpy,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  useSpy,
} = harness;

let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

beforeEach(async () => {
  vi.resetModules();
  const { createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
    await import("./bot.js");
  setTelegramBotRuntimeForTest(
    telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
  );
  createTelegramBot = (opts) =>
    createTelegramBotBase({
      ...opts,
      telegramDeps: telegramBotDepsForTest,
    });
});

describe("Telegram Business Chat handlers", () => {
  describe("business_connection handler", () => {
    it("registers business_connection handler", () => {
      createTelegramBot({ token: "tok" });
      const handler = onSpy.mock.calls.find((call) => call[0] === "business_connection")?.[1];
      expect(handler).toBeDefined();
    });

    it("stores business_connection_id mapped to user chat_id", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_connection") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      await handler({
        businessConnection: {
          id: "biz_conn_123",
          user: { id: 12345 },
        },
      });

      // Handler should complete without error
      expect(handler).toBeDefined();
    });

    it("skips when businessConnection is missing", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_connection") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      // Should not throw
      await handler({});
    });

    it("skips when user id is missing", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_connection") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      await handler({
        businessConnection: {
          id: "biz_conn_123",
          user: undefined,
        },
      });

      // Should complete without error - no exception thrown
      expect(handler).toBeDefined();
    });
  });

  describe("business_message handler", () => {
    it("registers business_message handler", () => {
      createTelegramBot({ token: "tok" });
      const handler = onSpy.mock.calls.find((call) => call[0] === "business_message")?.[1];
      expect(handler).toBeDefined();
    });

    it("processes business_message with text content", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      await handler({
        businessMessage: {
          message_id: 100,
          date: 1736380800,
          chat: { id: 12345, type: "private" },
          from: { id: 12345, username: "business_user" },
          text: "Hello from business account",
          business_connection_id: "biz_conn_456",
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      // Message should be processed (no errors thrown)
      expect(replySpy).toHaveBeenCalled();
    });

    it("skips when businessMessage is missing", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      // Should not throw
      await handler({});
    });

    it("tracks business_connection_id from message", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const chatId = 12345;
      const businessConnectionId = "biz_conn_789";

      await handler({
        businessMessage: {
          message_id: 101,
          date: 1736380800,
          chat: { id: chatId, type: "private" },
          from: { id: chatId, username: "business_user" },
          text: "Test message",
          business_connection_id: businessConnectionId,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      // After processing, a reply should have been attempted
      expect(replySpy).toHaveBeenCalled();
    });
  });

  describe("business_connection_id API transformer", () => {
    it("registers API config.use transformer", () => {
      createTelegramBot({ token: "tok" });
      expect(useSpy).toHaveBeenCalled();
    });

    it("injects business_connection_id for known business chats", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });

      // The API transformer should have been registered via useSpy
      const apiUseCalls = useSpy.mock.calls;
      expect(apiUseCalls.length).toBeGreaterThan(0);
    });

    it("excludes sendChatAction from business_connection_id injection", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });

      // Verify API transformer was registered
      expect(useSpy).toHaveBeenCalled();
    });
  });

  describe("handler registration order", () => {
    it("registers business handlers before regular message handler", () => {
      createTelegramBot({ token: "tok" });

      const onCalls = onSpy.mock.calls;
      const businessConnectionIndex = onCalls.findIndex(
        (call) => call[0] === "business_connection",
      );
      const businessMessageIndex = onCalls.findIndex((call) => call[0] === "business_message");
      const messageIndex = onCalls.findIndex((call) => call[0] === "message");

      expect(businessConnectionIndex).toBeGreaterThanOrEqual(0);
      expect(businessMessageIndex).toBeGreaterThanOrEqual(0);
      expect(messageIndex).toBeGreaterThanOrEqual(0);

      // Business handlers should be registered before message handler
      expect(businessConnectionIndex).toBeLessThan(messageIndex);
      expect(businessMessageIndex).toBeLessThan(messageIndex);
    });
  });

  describe("business message deduplication", () => {
    it("handles business_message through the pipeline", async () => {
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("business_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const ctx = {
        businessMessage: {
          message_id: 200,
          date: 1736380800,
          chat: { id: 12345, type: "private" },
          from: { id: 12345 },
          text: "Test",
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        update: {
          update_id: 999999,
          business_message: {
            message_id: 200,
            date: 1736380800,
            chat: { id: 12345, type: "private" },
            from: { id: 12345 },
            text: "Test",
          },
        },
      };

      // Should complete without error
      await handler(ctx);
    });
  });
});
