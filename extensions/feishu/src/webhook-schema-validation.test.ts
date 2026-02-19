import { describe, expect, it } from "vitest";
import {
  validateFeishuMessageEventPayload,
  validateFeishuBotAddedEventPayload,
} from "./webhook-schema-validation.js";

describe("Feishu webhook schema validation", () => {
  describe("validateFeishuMessageEventPayload", () => {
    it("accepts valid p2p message event", () => {
      const payload = {
        sender: {
          sender_id: { open_id: "user123" },
        },
        message: {
          message_id: "msg-1",
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: "Hello",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.message.chat_type).toBe("p2p");
        expect(result.data.message.content).toBe("Hello");
      }
    });

    it("accepts valid group message event", () => {
      const payload = {
        sender: {
          sender_id: { user_id: "user456" },
          sender_type: "user",
        },
        message: {
          message_id: "msg-2",
          chat_id: "chat-2",
          chat_type: "group",
          message_type: "text",
          content: "Group message",
          mentions: [
            {
              key: "@user123",
              id: { open_id: "user123" },
              name: "John",
            },
          ],
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.message.chat_type).toBe("group");
        expect(result.data.message.mentions).toHaveLength(1);
      }
    });

    it("accepts message with optional fields", () => {
      const payload = {
        sender: {
          sender_id: { union_id: "union123" },
          tenant_key: "tenant-123",
        },
        message: {
          message_id: "msg-3",
          root_id: "root-123",
          parent_id: "parent-123",
          chat_id: "chat-3",
          chat_type: "group",
          message_type: "text",
          content: "Reply message",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(true);
    });

    it("rejects null payload", () => {
      const result = validateFeishuMessageEventPayload(null);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("must be a JSON object");
      }
    });

    it("rejects array payload", () => {
      const result = validateFeishuMessageEventPayload([]);
      expect(result.valid).toBe(false);
    });

    it("rejects payload missing sender", () => {
      const payload = {
        message: {
          message_id: "msg-1",
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: "Hello",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects payload missing message", () => {
      const payload = {
        sender: {
          sender_id: { open_id: "user123" },
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects payload with missing message_id", () => {
      const payload = {
        sender: {
          sender_id: { open_id: "user123" },
        },
        message: {
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: "Hello",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects payload with invalid chat_type", () => {
      const payload = {
        sender: {
          sender_id: { open_id: "user123" },
        },
        message: {
          message_id: "msg-1",
          chat_id: "chat-1",
          chat_type: "invalid",
          message_type: "text",
          content: "Hello",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects payload with non-string sender_id fields", () => {
      const payload = {
        sender: {
          sender_id: { open_id: 123 }, // should be string
        },
        message: {
          message_id: "msg-1",
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: "Hello",
        },
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("accepts message with additional properties", () => {
      const payload = {
        sender: {
          sender_id: { open_id: "user123" },
          extra_field: "ignored",
        },
        message: {
          message_id: "msg-1",
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: "Hello",
          extra_msg_field: "also ignored",
        },
        top_level_extra: "ignored",
      };

      const result = validateFeishuMessageEventPayload(payload);
      expect(result.valid).toBe(true);
    });

    it("rejects undefined payload", () => {
      const result = validateFeishuMessageEventPayload(undefined);
      expect(result.valid).toBe(false);
    });
  });

  describe("validateFeishuBotAddedEventPayload", () => {
    it("accepts valid bot added event", () => {
      const payload = {
        chat_id: "chat-123",
      };

      const result = validateFeishuBotAddedEventPayload(payload);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.chat_id).toBe("chat-123");
      }
    });

    it("accepts bot added event with additional properties", () => {
      const payload = {
        chat_id: "chat-456",
        extra_field: "ignored",
        nested: { deep: "value" },
      };

      const result = validateFeishuBotAddedEventPayload(payload);
      expect(result.valid).toBe(true);
    });

    it("rejects null payload", () => {
      const result = validateFeishuBotAddedEventPayload(null);
      expect(result.valid).toBe(false);
    });

    it("rejects array payload", () => {
      const result = validateFeishuBotAddedEventPayload([]);
      expect(result.valid).toBe(false);
    });

    it("rejects payload missing chat_id", () => {
      const payload = {
        extra_field: "value",
      };

      const result = validateFeishuBotAddedEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects payload with non-string chat_id", () => {
      const payload = {
        chat_id: 123,
      };

      const result = validateFeishuBotAddedEventPayload(payload);
      expect(result.valid).toBe(false);
    });

    it("rejects string payload", () => {
      const result = validateFeishuBotAddedEventPayload("not an object");
      expect(result.valid).toBe(false);
    });

    it("rejects numeric payload", () => {
      const result = validateFeishuBotAddedEventPayload(42);
      expect(result.valid).toBe(false);
    });
  });
});
