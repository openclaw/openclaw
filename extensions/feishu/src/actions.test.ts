import { describe, expect, it, vi } from "vitest";

// Mock the reactions module before importing actions
vi.mock("./reactions.js", () => ({
  addReactionFeishu: vi.fn().mockResolvedValue({ reactionId: "mock-reaction-id" }),
  listReactionsFeishu: vi.fn().mockResolvedValue([]),
}));

// Mock the accounts module
vi.mock("./accounts.js", () => ({
  listEnabledFeishuAccounts: vi
    .fn()
    .mockReturnValue([{ accountId: "default", enabled: true, configured: true }]),
  resolveFeishuAccount: vi.fn().mockReturnValue({
    accountId: "default",
    enabled: true,
    configured: true,
  }),
}));

import { listEnabledFeishuAccounts } from "./accounts.js";
import { feishuMessageActions } from "./actions.js";
import { addReactionFeishu } from "./reactions.js";

const mockCfg = {} as Parameters<NonNullable<typeof feishuMessageActions.listActions>>[0]["cfg"];

describe("feishuMessageActions", () => {
  describe("listActions", () => {
    it("returns react when accounts are enabled", () => {
      const actions = feishuMessageActions.listActions!({ cfg: mockCfg });
      expect(actions).toContain("react");
    });

    it("returns empty array when no accounts are enabled", () => {
      vi.mocked(listEnabledFeishuAccounts).mockReturnValueOnce([]);
      const actions = feishuMessageActions.listActions!({ cfg: mockCfg });
      expect(actions).toEqual([]);
    });
  });

  describe("handleAction - react", () => {
    it("adds reaction with explicit messageId and emoji", async () => {
      const result = await feishuMessageActions.handleAction!({
        channel: "feishu" as never,
        action: "react" as never,
        cfg: mockCfg,
        params: { messageId: "om_abc123", emoji: "THUMBSUP" },
      });

      expect(result.details).toEqual({
        ok: true,
        action: "react",
        messageId: "om_abc123",
        emojiType: "THUMBSUP",
        reactionId: "mock-reaction-id",
      });
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining('"ok": true') },
      ]);
      expect(addReactionFeishu).toHaveBeenCalledWith({
        cfg: mockCfg,
        messageId: "om_abc123",
        emojiType: "THUMBSUP",
        accountId: undefined,
      });
    });

    it("normalizes emoji aliases (LIKE → THUMBSUP)", async () => {
      await feishuMessageActions.handleAction!({
        channel: "feishu" as never,
        action: "react" as never,
        cfg: mockCfg,
        params: { messageId: "om_abc123", emoji: "LIKE" },
      });

      expect(addReactionFeishu).toHaveBeenCalledWith(
        expect.objectContaining({ emojiType: "THUMBSUP" }),
      );
    });

    it("defaults to THUMBSUP when no emoji is provided", async () => {
      await feishuMessageActions.handleAction!({
        channel: "feishu" as never,
        action: "react" as never,
        cfg: mockCfg,
        params: { messageId: "om_abc123" },
      });

      expect(addReactionFeishu).toHaveBeenCalledWith(
        expect.objectContaining({ emojiType: "THUMBSUP" }),
      );
    });

    it("falls back to currentMessageId from tool context", async () => {
      const result = await feishuMessageActions.handleAction!({
        channel: "feishu" as never,
        action: "react" as never,
        cfg: mockCfg,
        params: { emoji: "HEART" },
        toolContext: { currentMessageId: "om_context_msg" },
      });

      expect(addReactionFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "om_context_msg",
          emojiType: "HEART",
        }),
      );
      expect(result.details).toEqual(
        expect.objectContaining({ ok: true, messageId: "om_context_msg" }),
      );
    });

    it("throws when no messageId and no tool context", async () => {
      await expect(
        feishuMessageActions.handleAction!({
          channel: "feishu" as never,
          action: "react" as never,
          cfg: mockCfg,
          params: { emoji: "SMILE" },
        }),
      ).rejects.toThrow("messageId is required");
    });

    it("passes accountId when provided", async () => {
      await feishuMessageActions.handleAction!({
        channel: "feishu" as never,
        action: "react" as never,
        cfg: mockCfg,
        params: { messageId: "om_abc123", emoji: "FIRE" },
        accountId: "my-bot",
      });

      expect(addReactionFeishu).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "my-bot" }),
      );
    });

    it("throws for unsupported action", async () => {
      await expect(
        feishuMessageActions.handleAction!({
          channel: "feishu" as never,
          action: "unknown-action" as never,
          cfg: mockCfg,
          params: {},
        }),
      ).rejects.toThrow("Unsupported feishu action");
    });
  });
});
