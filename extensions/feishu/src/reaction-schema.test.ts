import { describe, it, expect } from "vitest";
import { FeishuReactionSchema } from "./reaction-schema.js";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const ReactionValidator = TypeCompiler.Compile(FeishuReactionSchema);

describe("FeishuReactionSchema", () => {
  describe("action field", () => {
    it("accepts valid action: add", () => {
      const result = ReactionValidator.Check({
        action: "add",
        message_id: "msg_123",
        emoji_type: "THUMBSUP",
      });
      expect(result).toBe(true);
    });

    it("accepts valid action: remove", () => {
      const result = ReactionValidator.Check({
        action: "remove",
        message_id: "msg_123",
        reaction_id: "react_456",
      });
      expect(result).toBe(true);
    });

    it("accepts valid action: list", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: "msg_123",
      });
      expect(result).toBe(true);
    });

    it("rejects invalid action", () => {
      const result = ReactionValidator.Check({
        action: "invalid",
        message_id: "msg_123",
      });
      expect(result).toBe(false);
    });
  });

  describe("message_id field", () => {
    it("accepts valid message_id", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: "msg_123",
      });
      expect(result).toBe(true);
    });

    it("rejects missing message_id", () => {
      const result = ReactionValidator.Check({
        action: "list",
      });
      expect(result).toBe(false);
    });

    it("rejects empty message_id", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: "",
      });
      expect(result).toBe(false);
    });
  });

  describe("emoji_type field", () => {
    it("accepts common emoji types", () => {
      const types = ["THUMBSUP", "HEART", "SMILE", "FIRE", "CLAP", "OK", "PRAY"];
      for (const type of types) {
        const result = ReactionValidator.Check({
          action: "add",
          message_id: "msg_123",
          emoji_type: type,
        });
        expect(result).toBe(true);
      }
    });

    it("accepts any string emoji type", () => {
      const result = ReactionValidator.Check({
        action: "add",
        message_id: "msg_123",
        emoji_type: "CUSTOM_EMOJI",
      });
      expect(result).toBe(true);
    });

    it("allows optional emoji_type for list action", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: "msg_123",
      });
      expect(result).toBe(true);
    });
  });

  describe("reaction_id field", () => {
    it("accepts valid reaction_id", () => {
      const result = ReactionValidator.Check({
        action: "remove",
        message_id: "msg_123",
        reaction_id: "react_456",
      });
      expect(result).toBe(true);
    });

    it("allows optional reaction_id for add/list actions", () => {
      const result = ReactionValidator.Check({
        action: "add",
        message_id: "msg_123",
        emoji_type: "THUMBSUP",
      });
      expect(result).toBe(true);
    });
  });

  describe("account_id field", () => {
    it("accepts optional account_id", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: "msg_123",
        account_id: "acc_123",
      });
      expect(result).toBe(true);
    });
  });

  describe("validation errors", () => {
    it("provides error details for invalid data", () => {
      const errors = Array.from(ReactionValidator.Errors({
        action: "invalid",
        message_id: "msg_123",
      }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects wrong type for action", () => {
      const result = ReactionValidator.Check({
        action: 123,
        message_id: "msg_123",
      });
      expect(result).toBe(false);
    });

    it("rejects wrong type for message_id", () => {
      const result = ReactionValidator.Check({
        action: "list",
        message_id: 123,
      });
      expect(result).toBe(false);
    });
  });
});
