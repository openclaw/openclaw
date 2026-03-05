import { describe, expect, it } from "vitest";
import {
  assertFeishuMessageApiSuccess,
  toFeishuSendResult,
  type FeishuMessageApiResponse,
} from "./send-result.js";

describe("send-result", () => {
  describe("assertFeishuMessageApiSuccess", () => {
    it("should not throw when code is 0", () => {
      const response: FeishuMessageApiResponse = { code: 0, data: { message_id: "msg_123" } };
      expect(() => assertFeishuMessageApiSuccess(response, "Test error")).not.toThrow();
    });

    it("should throw basic error for non-permission errors", () => {
      const response: FeishuMessageApiResponse = { code: 123, msg: "Unknown error" };
      expect(() => assertFeishuMessageApiSuccess(response, "Test error")).toThrow(
        "Test error: Unknown error",
      );
    });

    it("should include hint for permission error 99991663 (no permission to send messages)", () => {
      const response: FeishuMessageApiResponse = {
        code: 99991663,
        msg: "No permission to send messages to this chat",
      };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The bot doesn't have permission to send messages to this chat. Ensure the app has 'im:message' permission and is added to the group.",
      );
    });

    it("should include hint for permission error 99991668 (bot not in group)", () => {
      const response: FeishuMessageApiResponse = { code: 99991668, msg: "Bot not in group" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The bot is not a member of this group. Add the bot to the group first.",
      );
    });

    it("should include hint for permission error 230019 (bot not in chat)", () => {
      const response: FeishuMessageApiResponse = { code: 230019, msg: "Bot not in chat" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The bot is not in this chat. Add the bot to the group first.",
      );
    });

    it("should include docs link for permission errors", () => {
      const response: FeishuMessageApiResponse = {
        code: 99991663,
        msg: "No permission to send messages to this chat",
      };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "📖 See: https://docs.openclaw.ai/channels/feishu#troubleshooting",
      );
    });

    it("should handle permission error without message", () => {
      const response: FeishuMessageApiResponse = { code: 99991663 };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "Feishu send failed: code 99991663",
      );
    });

    it("should handle error code 99991664 (no permission to @mention)", () => {
      const response: FeishuMessageApiResponse = { code: 99991664, msg: "No permission to @mention" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The bot doesn't have permission to @mention users. Ensure the app has 'im:message' permission.",
      );
    });

    it("should handle error code 99991665 (no permission to send cards)", () => {
      const response: FeishuMessageApiResponse = { code: 99991665, msg: "No permission to send cards" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The bot doesn't have permission to send interactive cards. Ensure the app has 'im:message' and 'im:resource' permissions.",
      );
    });

    it("should handle error code 99991669 (group dissolved)", () => {
      const response: FeishuMessageApiResponse = { code: 99991669, msg: "Group dissolved" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: This group has been dissolved.",
      );
    });

    it("should handle error code 99991670 (chat is read-only)", () => {
      const response: FeishuMessageApiResponse = { code: 99991670, msg: "Chat is read-only" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: This chat is read-only and cannot receive messages.",
      );
    });

    it("should handle error code 230020 (chat not found)", () => {
      const response: FeishuMessageApiResponse = { code: 230020, msg: "Chat not found" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "💡 Hint: The chat doesn't exist or has been deleted.",
      );
    });

    it("should handle unknown error codes without hint", () => {
      const response: FeishuMessageApiResponse = { code: 99999999, msg: "Unknown error" };
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).toThrow(
        "Feishu send failed: Unknown error",
      );
      // Should not contain hint or docs link
      expect(() => assertFeishuMessageApiSuccess(response, "Feishu send failed")).not.toThrow(
        "💡 Hint:",
      );
    });
  });

  describe("toFeishuSendResult", () => {
    it("should extract message_id and chat_id from response", () => {
      const response: FeishuMessageApiResponse = {
        code: 0,
        data: { message_id: "om_123456" },
      };
      const result = toFeishuSendResult(response, "oc_789");
      expect(result).toEqual({
        messageId: "om_123456",
        chatId: "oc_789",
      });
    });

    it("should return 'unknown' for missing message_id", () => {
      const response: FeishuMessageApiResponse = { code: 0, data: {} };
      const result = toFeishuSendResult(response, "oc_789");
      expect(result).toEqual({
        messageId: "unknown",
        chatId: "oc_789",
      });
    });

    it("should handle missing data", () => {
      const response: FeishuMessageApiResponse = { code: 0 };
      const result = toFeishuSendResult(response, "oc_789");
      expect(result).toEqual({
        messageId: "unknown",
        chatId: "oc_789",
      });
    });
  });
});
